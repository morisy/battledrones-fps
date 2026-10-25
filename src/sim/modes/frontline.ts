/**
 * Frontline (FRONTLINE.md): the battle as a soldier. Two AI commanders fight
 * the whole RTS match as usual, and the player is one robot on blue's side,
 * walked and aimed by hand in first person, leading a fireteam of squads of
 * their own. Kills, damage and captures earn Requisition (RP), spent on
 * weapons, upgrades and reinforcements for the fireteam.
 *
 * On the sim's books the player's soldier (the avatar) is a Trooper Squad
 * with `Unit.avatar` set: enemies see it, shoot it, crush it and get the kill
 * as they would any squad; Menders patch it up; it captures Uplinks at
 * infantry weight and claims supply crates. The sim never moves it, fires
 * for it or shoves it aside (combat.ts, movement.ts): the player does that,
 * through moveAvatar and avatarShot / avatarBlast here. Its HP pool is the
 * Trooper's; its plating is a damage multiplier on top (avatarArmor).
 *
 * The fireteam are ordinary blue units the commander AI keeps its hands off
 * (filterAiCommands): they follow the player, hold a point or focus a target
 * as ordered (teamOrder), and fight on their own as any unit does.
 *
 * Everything here is plain sim code (no three.js): the first-person view
 * does the aiming and ballistics in 3D and hands hits to avatarShot. Unlike
 * the rest of the sim it is not run from commands: Frontline has no replays
 * or duels, and the view calls these functions between steps.
 */
import { BUILDINGS, OBJECTIVES, TERRAIN, TICK_RATE, UNITS } from "../balance";
import { directHit } from "../combat";
import { atan2, cos, hypot, pow, sin } from "../fmath";
import { dropPoint } from "../transport";
import type { Command, DamageType, Faction, Terrain, Unit, UnitKind, World } from "../types";
import { buildingCenter, distToBuilding, hqOf, inBounds, spawnUnit, tileIndex } from "../world";

// ---------------------------------------------------------------- balance ---

export type WeaponId = "carbine" | "rail" | "launcher";
export const WEAPON_IDS: readonly WeaponId[] = ["carbine", "rail", "launcher"];

export interface WeaponStats {
  name: string;
  /** One line for the armory and the weapon bar. */
  role: string;
  /** Damage per hit before armour (sim units: a Trooper Squad has 190 HP, 38 per robot). */
  damage: number;
  dmgType: DamageType;
  /** Seconds between shots. */
  interval: number;
  /** Rounds per magazine, and seconds to reload one. */
  mag: number;
  reload: number;
  /** Full damage out to `falloff` tiles, then linearly down to `minFalloff` × at `range`; nothing past it. */
  range: number;
  falloff: number;
  minFalloff: number;
  /** Aim cone (radians, half-angle) when moving, and settled/zoomed. */
  spread: number;
  settledSpread: number;
  /** Multiplier against aircraft. */
  airMult: number;
  /** Splash radius (tiles): full damage at the centre, half at the edge (the launcher). */
  splash?: number;
  /** A projectile at this speed (tiles/s) rather than a hitscan round. */
  speed?: number;
  /** Zoom factor when aiming down sights. */
  zoom: number;
  /** Camera kick per shot (radians of pitch). */
  kick: number;
}

/**
 * The player's guns, tuned against the sim's units (FRONTLINE.md "Weapons"):
 *
 * - Carbine: a hero's rifle. 64 DPS on paper, ~30 in practice with misses and
 *   reloads: about two Trooper Squads' worth, at no cost. Kinetic, so it
 *   strips infantry and light drones and plinks off a Mastodon (×0.6).
 * - Rail: the Sniper Team's precision rail-rifle in one pair of hands.
 *   Precision ×3 vs infantry: 114 per shot, three robots of a Trooper Squad.
 *   Next to useless against armour (×0.25–0.6), on purpose.
 * - Launcher: the answer to tanks. Cannon damage ×1.3 vs heavy, splash, and
 *   few rockets: it takes about seven to stop a Mastodon alone, so it rewards
 *   bringing the fireteam's Rocket Squad along.
 */
export const WEAPONS: Record<WeaponId, WeaponStats> = {
  carbine: {
    name: "Pulse Carbine", role: "Full-auto rifle. Shreds robots and light drones; weak against heavy armour.",
    damage: 7, dmgType: "kinetic", interval: 0.11, mag: 30, reload: 1.7,
    range: 16, falloff: 7, minFalloff: 0.45, spread: 0.035, settledSpread: 0.008,
    airMult: 0.8, zoom: 1.35, kick: 0.006
  },
  rail: {
    name: "Rail Rifle", role: "Marksman rail. Three robots a shot at long range; useless against vehicles.",
    damage: 38, dmgType: "precision", interval: 1.15, mag: 5, reload: 2.2,
    range: 28, falloff: 22, minFalloff: 0.8, spread: 0.05, settledSpread: 0,
    airMult: 0.6, zoom: 3, kick: 0.04
  },
  launcher: {
    name: "Rocket Launcher", role: "Anti-armour rockets with splash. Kills tanks and bombers. Few rockets.",
    damage: 105, dmgType: "cannon", interval: 0.9, mag: 1, reload: 1.4,
    range: 22, falloff: 22, minFalloff: 1, spread: 0.02, settledSpread: 0.004,
    airMult: 1.4, splash: 0.9, speed: 16, zoom: 1.5, kick: 0.05
  }
};

export type UpgradeId =
  | "carbine-dmg" | "carbine-mag" | "carbine-ap"
  | "rail" | "rail-dmg"
  | "launcher" | "launcher-ammo" | "launcher-tandem"
  | "grenades" | "plating" | "servos" | "nanites";

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  desc: string;
  /** RP per level (its length is the number of levels). */
  cost: number[];
  /** Must own this first. */
  requires?: UpgradeId;
  /** Armory section. */
  group: "carbine" | "rail" | "launcher" | "kit";
}

/**
 * The armory (FRONTLINE.md "Requisition"). Prices are set so a match earns
 * roughly half the catalogue: about 1,000–1,500 RP for a player who fights
 * well, against 1,760 for every upgrade, before any reinforcements.
 */
export const UPGRADES: UpgradeDef[] = [
  { id: "carbine-dmg", group: "carbine", name: "Overcharged cells", desc: "+20% carbine damage per level", cost: [90, 160] },
  { id: "carbine-mag", group: "carbine", name: "Drum magazine", desc: "45 rounds, reload 1.2 s", cost: [70] },
  { id: "carbine-ap", group: "carbine", name: "Tungsten rounds", desc: "Carbine hits armour and buildings at full damage", cost: [150], requires: "carbine-dmg" },
  { id: "rail", group: "rail", name: "Rail Rifle", desc: "Unlock the marksman rail (key 2)", cost: [180] },
  { id: "rail-dmg", group: "rail", name: "Capacitor bank", desc: "+25% rail damage, 0.9 s between shots", cost: [140], requires: "rail" },
  { id: "launcher", group: "launcher", name: "Rocket Launcher", desc: "Unlock the launcher (key 3), 4 rockets", cost: [160] },
  { id: "launcher-ammo", group: "launcher", name: "Rocket rack", desc: "+3 rockets carried", cost: [90], requires: "launcher" },
  { id: "launcher-tandem", group: "launcher", name: "Tandem warheads", desc: "+30% rocket damage", cost: [150], requires: "launcher" },
  { id: "grenades", group: "kit", name: "Grenade belt", desc: "+2 frag grenades carried", cost: [70] },
  { id: "plating", group: "kit", name: "Ablative plating", desc: "−15% damage taken per level", cost: [110, 190] },
  { id: "servos", group: "kit", name: "Sprint servos", desc: "+15% move speed", cost: [80] },
  { id: "nanites", group: "kit", name: "Repair nanites", desc: "Regenerate twice as fast, after 2.5 s", cost: [120] }
];

/** Fireteam reinforcements the player can radio for (RP, not scrap: the commander's economy is untouched). */
export type TeamKind = "trooper" | "rocket-squad" | "sniper" | "mender";
export const REINFORCEMENTS: Record<TeamKind, { cost: number; blurb: string }> = {
  trooper: { cost: 100, blurb: "Rifle bots: cheap all-rounders" },
  "rocket-squad": { cost: 150, blurb: "Rockets: kill tanks and bombers" },
  sniper: { cost: 180, blurb: "Marksmen: delete enemy infantry" },
  mender: { cost: 160, blurb: "Repair drone: heals you and the team" }
};

export const FRONTLINE = {
  /** Avatar HP pool is UNITS.trooper.hp (190); damage taken is multiplied by this (an effective 317 HP)… */
  armor: 0.6,
  /** …and by this per plating level. */
  platingStep: 0.85,
  /** Seconds after the last hit before regeneration starts, and HP/s (sim HP) regenerated. */
  regenDelay: 5,
  regenRate: 14,
  /** Move speed (tiles/s), the sprint multiplier, and the servo upgrade's. */
  speed: 1.9,
  sprint: 1.5,
  servos: 1.15,
  /** Collision radius (tiles). */
  radius: 0.2,
  /** Respawn: base seconds, more per death so far, capped. */
  respawn: 5,
  respawnPerDeath: 1.5,
  respawnMax: 12,
  /** Spawn shield: seconds the new soldier takes no damage (ends early when it fires). */
  shield: 2.5,
  /** Spawning on the fireteam: a member unhurt for this many seconds. */
  squadSpawnSafe: 5,
  /** Requisition: start, per second, share of a target's cost per share of its HP dealt, kill bonus (share of cost + flat). */
  rp: { start: 60, perSec: 0.5, damageShare: 0.2, killShare: 0.1, killFlat: 5, teamKillShare: 0.06, capture: 40, crate: 25 },
  /** Grenades carried at the start, rockets carried with the launcher; the upgrades' extra. */
  grenades: 2,
  grenadesUp: 2,
  rockets: 4,
  rocketsUp: 3,
  /** Frag grenade: damage at the centre, splash radius, explosive. */
  grenade: { damage: 90, splash: 1.3, fuse: 1.6, throwSpeed: 7 },
  /** Supply points: within this many tiles of a friendly building's footprint (an owned Uplink: inside its ring). */
  supplyReach: 3,
  /** One rocket and one grenade back every this many seconds at a supply point. */
  resupply: 2,
  /** The fireteam: most units at once, and the starting team. */
  teamMax: 4,
  startTeam: ["trooper", "rocket-squad"] as TeamKind[],
  /** Seconds a reinforcement takes to arrive. */
  inbound: 8,
  /**
   * The enemy commander's income on top of its difficulty (FRONTLINE.md
   * "Balance"): the player is the edge blue's commander needs. Measured with
   * tools/frontline.ts.
   */
  enemyIncome: { easy: 1.6, normal: 1.3, hard: 1.05 } as Record<"easy" | "normal" | "hard", number>
};

/** Formation slots behind the player (x right, y behind, tiles), in team order. */
const SLOTS: [number, number][] = [[-1.1, 1.3], [1.1, 1.3], [0, 2.3], [-1.9, 2.5]];
/** The fireteam re-forms when a member is this far from its slot. */
const SLOT_SLACK = 1.8;
/** …and lets a fight run while the player is within this of it. */
const FIGHT_LEASH = 6;

// ------------------------------------------------------------------ state ---

export type TeamMode = "follow" | "hold" | "attack";

/** Something the player should hear about (the view drains `feed` every frame). */
export type FrontlineEvent =
  | { type: "kill"; name: string; rp: number; building: boolean }
  | { type: "teamKill"; name: string; rp: number }
  | { type: "rp"; amount: number; why: string }
  | { type: "died"; by: string | null }
  | { type: "respawned"; at: "hq" | "squad" }
  | { type: "reinforced"; kind: UnitKind }
  | { type: "teamLost"; kind: UnitKind }
  | { type: "captured" }
  | { type: "crate" };

export interface FrontlineState {
  side: Faction;
  /** Multiplier on the enemy's income, applied each tick after its commander sets its own (applyHandicap). */
  enemyIncome: number;
  /** The soldier's unit id while alive. */
  avatarId: number | null;
  /** Yaw (radians, 0 = north, clockwise) and pitch the player looks along (the view sets them). */
  yaw: number;
  pitch: number;
  /** Requisition in hand, and earned all match. */
  rp: number;
  rpEarned: number;
  upgrades: Partial<Record<UpgradeId, number>>;
  /** Rounds left in each magazine; rockets and grenades in reserve. */
  mag: Record<WeaponId, number>;
  rockets: number;
  grenades: number;
  /** The fireteam's unit ids and standing orders. */
  team: number[];
  mode: TeamMode;
  holdAt: { x: number; y: number } | null;
  attackId: number | null;
  /** A reinforcement on its way. */
  inbound: { kind: TeamKind; due: number } | null;
  /** Tick the soldier may respawn (null while alive). */
  respawnAt: number | null;
  /** No damage taken until this tick (spawn shield). */
  shieldUntil: number;
  /** Next tick a supply point hands out a rocket and a grenade. */
  resupplyAt: number;
  stats: { kills: number; damage: number; deaths: number; squadKills: number; captures: number; crates: number; shots: number; hits: number };
  feed: FrontlineEvent[];
}

const secs = (s: number) => Math.round(s * TICK_RATE);

export const frontlineOf = (w: World): FrontlineState | null => w.frontline ?? null;

/** The player's soldier, while alive. */
export function avatarOf(w: World): Unit | null {
  const s = w.frontline;
  if (!s || s.avatarId === null) return null;
  const u = w.units.get(s.avatarId);
  return u && u.hp > 0 ? u : null;
}

export const level = (s: FrontlineState, id: UpgradeId): number => s.upgrades[id] ?? 0;

/** Damage multiplier on the soldier (combat.ts damageMult): plating, and nothing at all under the spawn shield. */
export function avatarArmor(w: World): number {
  const s = w.frontline;
  if (!s) return 1;
  if (w.tick < s.shieldUntil) return 0;
  return FRONTLINE.armor * pow(FRONTLINE.platingStep, level(s, "plating"));
}

/** The weapon's numbers with this loadout's upgrades. */
export function weaponStats(s: FrontlineState, id: WeaponId): WeaponStats & { floor: number } {
  const base = WEAPONS[id];
  let { damage, interval, mag, reload } = base;
  let floor = 0;
  if (id === "carbine") {
    damage *= 1 + 0.2 * level(s, "carbine-dmg");
    if (level(s, "carbine-mag")) {
      mag = 45;
      reload = 1.2;
    }
    if (level(s, "carbine-ap")) floor = 1;
  } else if (id === "rail" && level(s, "rail-dmg")) {
    damage *= 1.25;
    interval = 0.9;
  } else if (id === "launcher" && level(s, "launcher-tandem")) damage *= 1.3;
  return { ...base, damage, interval, mag, reload, floor };
}

export const ownsWeapon = (s: FrontlineState, id: WeaponId): boolean =>
  id === "carbine" || level(s, id === "rail" ? "rail" : "launcher") > 0;

export const maxRockets = (s: FrontlineState): number =>
  level(s, "launcher") ? FRONTLINE.rockets + FRONTLINE.rocketsUp * level(s, "launcher-ammo") : 0;
export const maxGrenades = (s: FrontlineState): number => FRONTLINE.grenades + FRONTLINE.grenadesUp * level(s, "grenades");

/** Move speed (tiles/s) before terrain. */
export const avatarSpeed = (s: FrontlineState): number => FRONTLINE.speed * (level(s, "servos") ? FRONTLINE.servos : 1);

export interface FrontlineOptions {
  side?: Faction;
  /** The enemy commander's income on top of its difficulty's (FRONTLINE.enemyIncome). */
  enemyIncome?: number;
}

/**
 * Turn a freshly set-up skirmish world into a Frontline match: the soldier
 * beside its HQ and the starting fireteam (free units: no wreck, no meter).
 */
export function setupFrontline(w: World, opts: FrontlineOptions = {}): FrontlineState {
  const side = opts.side ?? "blue";
  const s: FrontlineState = {
    side, enemyIncome: opts.enemyIncome ?? 1, avatarId: null, yaw: 0, pitch: 0,
    rp: FRONTLINE.rp.start, rpEarned: 0, upgrades: {},
    mag: { carbine: WEAPONS.carbine.mag, rail: WEAPONS.rail.mag, launcher: WEAPONS.launcher.mag },
    rockets: 0, grenades: FRONTLINE.grenades,
    team: [], mode: "follow", holdAt: null, attackId: null, inbound: null,
    respawnAt: null, shieldUntil: 0, resupplyAt: 0,
    stats: { kills: 0, damage: 0, deaths: 0, squadKills: 0, captures: 0, crates: 0, shots: 0, hits: 0 },
    feed: []
  };
  w.frontline = s;
  const hq = hqOf(w, side);
  const c = hq ? buildingCenter(hq) : { x: w.width / 2, y: w.height / 2 };
  // face the enemy HQ
  const foe = [...w.buildings.values()].find((b) => b.kind === "hq" && b.faction !== side);
  const fc = foe ? buildingCenter(foe) : { x: w.width / 2, y: w.height / 2 };
  s.yaw = atan2(fc.x - c.x, -(fc.y - c.y));
  spawnAvatar(w, c.x + sin(s.yaw) * 2.6, c.y - cos(s.yaw) * 2.6);
  s.shieldUntil = 0;
  FRONTLINE.startTeam.forEach((k, i) => addTeam(w, k, c.x + sin(s.yaw) * 2 + (i - 0.5) * 1.6, c.y - cos(s.yaw) * 2 + 1));
  return s;
}

function spawnAvatar(w: World, x: number, y: number): Unit {
  const s = w.frontline!;
  const p = dropPoint(w, s.side, x, y) ?? { x, y };
  const u = spawnUnit(w, "trooper", s.side, p.x, p.y);
  u.avatar = true;
  u.free = true;
  u.facing = u.aim = s.yaw;
  s.avatarId = u.id;
  s.respawnAt = null;
  s.shieldUntil = w.tick + secs(FRONTLINE.shield);
  return u;
}

function addTeam(w: World, kind: TeamKind, x: number, y: number): Unit | null {
  const s = w.frontline!;
  const p = UNITS[kind].domain === "air" ? { x, y } : dropPoint(w, s.side, x, y);
  if (!p) return null;
  const u = spawnUnit(w, kind, s.side, p.x, p.y);
  u.free = true;
  u.facing = u.aim = s.yaw;
  s.team.push(u.id);
  return u;
}

// --------------------------------------------------------------- movement ---

/** Can the soldier stand at (x, y)? On ground infantry can walk, off every building, inside the map. */
export function standable(w: World, x: number, y: number): boolean {
  const r = FRONTLINE.radius;
  if (x < 0.4 || y < 0.4 || x > w.width - 0.4 || y > w.height - 0.4) return false;
  for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]] as const) {
    const tx = Math.floor(x + dx);
    const ty = Math.floor(y + dy);
    if (!inBounds(w, tx, ty)) return false;
    const i = tileIndex(w, tx, ty);
    if (TERRAIN[w.terrain[i] as Terrain].footSpeed <= 0 || w.occupancy[i] !== 0) return false;
  }
  return true;
}

/** Terrain's say in the soldier's pace: the infantry column, softened (a road helps a little, nothing slows to a crawl). */
export function terrainPace(w: World, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!inBounds(w, tx, ty)) return 1;
  const f = TERRAIN[w.terrain[tileIndex(w, tx, ty)] as Terrain].footSpeed;
  return Math.min(1.15, Math.max(0.75, f));
}

/**
 * Walk the soldier `dt` seconds along (dx, dy) (tiles; any length, normalised
 * here) at its pace, sliding along walls and cliffs. Returns whether it moved.
 */
export function moveAvatar(w: World, dx: number, dy: number, dt: number, sprint = false): boolean {
  const u = avatarOf(w);
  const s = w.frontline;
  if (!u || !s) return false;
  const len = hypot(dx, dy);
  if (len < 1e-6 || dt <= 0) return false;
  const v = avatarSpeed(s) * terrainPace(w, u.x, u.y) * (sprint ? FRONTLINE.sprint : 1) * Math.min(1, len);
  const sx = (dx / len) * v * dt;
  const sy = (dy / len) * v * dt;
  const x0 = u.x;
  const y0 = u.y;
  if (standable(w, u.x + sx, u.y + sy)) {
    u.x += sx;
    u.y += sy;
  } else {
    if (standable(w, u.x + sx, u.y)) u.x += sx;
    if (standable(w, u.x, u.y + sy)) u.y += sy;
  }
  return u.x !== x0 || u.y !== y0;
}

/** Point the soldier where the player looks (its hull and aim in the sim, for enemies' and renderers' sake). */
export function lookAvatar(w: World, yaw: number, pitch: number): void {
  const s = w.frontline;
  if (!s) return;
  s.yaw = yaw;
  s.pitch = pitch;
  const u = avatarOf(w);
  if (u) u.facing = u.aim = yaw;
}

// ----------------------------------------------------------------- combat ---

function nameOf(w: World, id: number): string {
  const u = w.units.get(id);
  if (u) return UNITS[u.kind].name;
  const b = w.buildings.get(id);
  return b ? BUILDINGS[b.kind].name : "target";
}

function valueOf(w: World, id: number): { cost: number; hp: number } | null {
  const u = w.units.get(id);
  if (u) return { cost: UNITS[u.kind].cost, hp: UNITS[u.kind].hp };
  const b = w.buildings.get(id);
  return b ? { cost: BUILDINGS[b.kind].cost || 500, hp: BUILDINGS[b.kind].hp } : null;
}

function earn(s: FrontlineState, amount: number): void {
  s.rp += amount;
  s.rpEarned += amount;
}

/** Damage after range falloff, for a hit `dist` tiles away. */
export function falloffAt(st: WeaponStats, dist: number): number {
  if (dist > st.range) return 0;
  if (dist <= st.falloff) return 1;
  const k = (dist - st.falloff) / Math.max(1e-6, st.range - st.falloff);
  return 1 + (st.minFalloff - 1) * k;
}

/** Can the soldier hurt this entity at all (an enemy, still standing)? */
export function isFoe(w: World, id: number): boolean {
  const s = w.frontline;
  const e = w.units.get(id) ?? w.buildings.get(id);
  return !!s && !!e && e.faction !== s.side && e.hp > 0;
}

/**
 * The soldier's round hits entity `id`, `dist` tiles away: armour, cover and
 * falloff as for any shot, kill credit to the soldier, and RP for the share
 * of its HP taken. Returns the damage dealt (0: a friendly, a ghost, out of range).
 */
export function avatarShot(w: World, id: number, weapon: WeaponId, dist: number, scale = 1): number {
  const s = w.frontline;
  const u = avatarOf(w);
  if (!s || !u || !isFoe(w, id)) return 0;
  const st = weaponStats(s, weapon);
  const k = falloffAt(st, dist) * scale;
  if (k <= 0) return 0;
  return credit(w, id, directHit(w, u.id, id, st.damage * k, st.dmgType, st.airMult, st.floor));
}

/**
 * A blast at (x, y): a rocket's splash or a grenade. Every enemy within
 * `radius` takes `damage` (half at the edge), aircraft only if `air` (a
 * rocket that burst in the sky). Returns the total dealt.
 */
export function avatarBlast(
  w: World,
  x: number,
  y: number,
  damage: number,
  radius: number,
  dmgType: DamageType,
  opts: { air?: boolean; airMult?: number; skip?: number } = {}
): number {
  const s = w.frontline;
  const u = avatarOf(w);
  if (!s || !u) return 0;
  let total = 0;
  for (const t of [...w.units.values()]) {
    if (t.faction === s.side || t.hp <= 0 || t.id === opts.skip) continue;
    const air = UNITS[t.kind].domain === "air";
    if (air !== !!opts.air) continue;
    const d = hypot(t.x - x, t.y - y);
    if (d > radius + UNITS[t.kind].radius * 0.5) continue;
    const k = 1 - 0.5 * Math.min(1, d / radius);
    total += credit(w, t.id, directHit(w, u.id, t.id, damage * k, dmgType, opts.airMult ?? 1));
  }
  if (!opts.air)
    for (const b of [...w.buildings.values()]) {
      if (b.faction === s.side || b.hp <= 0) continue;
      const d = distToBuilding(b, x, y);
      if (d > radius) continue;
      total += credit(w, b.id, directHit(w, u.id, b.id, damage * (1 - 0.5 * (d / radius)), dmgType));
    }
  return total;
}

function credit(w: World, id: number, dealt: number): number {
  const s = w.frontline!;
  if (dealt <= 0) return 0;
  const v = valueOf(w, id);
  s.stats.damage += dealt;
  if (v) earn(s, (FRONTLINE.rp.damageShare * v.cost * dealt) / v.hp);
  return dealt;
}

/** The soldier pulled a trigger (accuracy stats; firing drops the spawn shield). */
export function noteShot(w: World, hit: boolean): void {
  const s = w.frontline;
  if (!s) return;
  s.stats.shots++;
  if (hit) s.stats.hits++;
  s.shieldUntil = Math.min(s.shieldUntil, w.tick);
}

// ----------------------------------------------------------------- supply ---

/** Is the soldier at a supply point (a friendly building, or inside an Uplink ring its side holds)? */
export function atSupply(w: World): boolean {
  const s = w.frontline;
  const u = avatarOf(w);
  if (!s || !u) return false;
  for (const b of w.buildings.values())
    if (b.faction === s.side && distToBuilding(b, u.x, u.y) <= FRONTLINE.supplyReach) return true;
  for (const l of w.objectives.uplinks)
    if (l.owner === s.side && hypot(l.x - u.x, l.y - u.y) <= OBJECTIVES.uplink.radius) return true;
  return false;
}

/** Why an upgrade can't be bought now, or null when it can. */
export function upgradeBlocker(w: World, id: UpgradeId): string | null {
  const s = w.frontline;
  const def = UPGRADES.find((d) => d.id === id);
  if (!s || !def) return "Unknown upgrade";
  const lv = level(s, id);
  if (lv >= def.cost.length) return "Owned";
  if (def.requires && !level(s, def.requires)) return `Needs ${UPGRADES.find((d) => d.id === def.requires)!.name}`;
  if (s.respawnAt === null && !atSupply(w)) return "Visit a supply point";
  if (s.rp < def.cost[lv]!) return `${def.cost[lv]} RP`;
  return null;
}

/** Buy the next level of an upgrade. Returns why not, or null when bought. */
export function buyUpgrade(w: World, id: UpgradeId): string | null {
  const why = upgradeBlocker(w, id);
  if (why) return why;
  const s = w.frontline!;
  const def = UPGRADES.find((d) => d.id === id)!;
  s.rp -= def.cost[level(s, id)]!;
  s.upgrades[id] = level(s, id) + 1;
  // a new gun comes loaded; a bigger magazine, full
  if (id === "launcher") s.rockets = maxRockets(s) - 1;
  if (id === "launcher-ammo") s.rockets = Math.min(maxRockets(s), s.rockets + FRONTLINE.rocketsUp);
  if (id === "grenades") s.grenades = Math.min(maxGrenades(s), s.grenades + FRONTLINE.grenadesUp);
  for (const wid of WEAPON_IDS) if (ownsWeapon(s, wid) && wid !== "launcher") s.mag[wid] = weaponStats(s, wid).mag;
  if (id === "launcher") s.mag.launcher = 1;
  return null;
}

// --------------------------------------------------------------- fireteam ---

/** The fireteam still alive, in team order. */
export function teamUnits(w: World): Unit[] {
  const s = w.frontline;
  if (!s) return [];
  const out: Unit[] = [];
  for (const id of s.team) {
    const u = w.units.get(id);
    if (u && u.hp > 0) out.push(u);
  }
  return out;
}

/** Why a reinforcement can't be called now, or null. */
export function requestBlocker(w: World, kind: TeamKind): string | null {
  const s = w.frontline;
  if (!s) return "No fireteam";
  if (s.inbound) return "One already inbound";
  if (teamUnits(w).length >= FRONTLINE.teamMax) return `Fireteam full (${FRONTLINE.teamMax})`;
  const cost = REINFORCEMENTS[kind].cost;
  if (s.rp < cost) return `${cost} RP`;
  return null;
}

/** Radio for a reinforcement: paid now, it arrives at the soldier (or the HQ) in FRONTLINE.inbound seconds. */
export function requestSquad(w: World, kind: TeamKind): string | null {
  const why = requestBlocker(w, kind);
  if (why) return why;
  const s = w.frontline!;
  s.rp -= REINFORCEMENTS[kind].cost;
  s.inbound = { kind, due: w.tick + secs(FRONTLINE.inbound) };
  return null;
}

/**
 * The fireteam's standing order: follow the soldier, hold (x, y) (they
 * attack-move there and fight from it), or focus fire on entity `targetId`
 * (back to following once it's gone).
 */
export function teamOrder(w: World, mode: TeamMode, at?: { x: number; y: number } | null, targetId?: number | null): boolean {
  const s = w.frontline;
  if (!s) return false;
  if (mode === "attack") {
    if (targetId === null || targetId === undefined || !isFoe(w, targetId)) return false;
    s.mode = "attack";
    s.attackId = targetId;
    for (const u of teamUnits(w)) {
      if (UNITS[u.kind].targets === "none") continue;
      u.order = { type: "attack", targetId };
      u.path = null;
    }
    return true;
  }
  if (mode === "hold") {
    const p = at ?? avatarOf(w);
    if (!p) return false;
    s.mode = "hold";
    s.holdAt = { x: p.x, y: p.y };
    teamUnits(w).forEach((u, i) => {
      const [ox, oy] = SLOTS[i % SLOTS.length]!;
      u.order = { type: "attackMove", x: p.x + ox * 0.8, y: p.y + (oy - 1.5) * 0.8 };
      u.path = null;
      u.autoTargetId = null;
    });
    return true;
  }
  s.mode = "follow";
  s.holdAt = null;
  s.attackId = null;
  for (const u of teamUnits(w)) {
    u.order = { type: "idle" };
    u.path = null;
  }
  follow(w, true);
  return true;
}

/** Keep the fireteam in formation behind the soldier, letting fights near them run. */
function follow(w: World, force = false): void {
  const s = w.frontline!;
  const a = avatarOf(w);
  if (!a) return;
  const fx = sin(s.yaw);
  const fy = -cos(s.yaw);
  teamUnits(w).forEach((u, i) => {
    const [ox, oy] = SLOTS[i % SLOTS.length]!;
    // right of facing is (-fy, fx); behind is (-fx, -fy)
    const gx = a.x + -fy * ox + -fx * oy;
    const gy = a.y + fx * ox + -fy * oy;
    const busy = u.autoTargetId !== null && w.units.has(u.autoTargetId) && hypot(u.x - a.x, u.y - a.y) < FIGHT_LEASH;
    if (!force && busy && u.order.type !== "move") return;
    const o = u.order;
    const far = hypot(u.x - gx, u.y - gy) > SLOT_SLACK;
    const stale = o.type === "attackMove" || o.type === "move" ? hypot(o.x - gx, o.y - gy) > SLOT_SLACK * 0.7 : true;
    if (!force && (!far || !stale)) return;
    // (a Mender just flies to its slot; it repairs whoever's hurt on its own)
    u.order = UNITS[u.kind].targets === "none" ? { type: "move", x: gx, y: gy } : { type: "attackMove", x: gx, y: gy };
    u.path = null;
  });
}

/**
 * The enemy's income handicap. A commander sets its side's income multiplier
 * from its difficulty every time it runs (ai/commander.ts tickAi), so call
 * this after the commanders and before the step, every tick.
 */
export function applyHandicap(w: World): void {
  const s = w.frontline;
  if (!s) return;
  for (const f of Object.keys(w.factions) as Faction[]) if (f !== s.side) w.factions[f].incomeMult = Math.round(w.factions[f].incomeMult * s.enemyIncome * 1000) / 1000;
}

/** Drop the soldier's and the fireteam's ids from a commander's orders: they're the player's. */
export function filterAiCommands(w: World, cmds: Command[]): Command[] {
  const s = w.frontline;
  if (!s) return cmds;
  const mine = new Set(s.team);
  if (s.avatarId !== null) mine.add(s.avatarId);
  const out: Command[] = [];
  for (const c of cmds) {
    if (!("unitIds" in c)) {
      out.push(c);
      continue;
    }
    const ids = c.unitIds.filter((id) => !mine.has(id));
    if (ids.length === 0) continue;
    if (c.type === "board" && mine.has(c.carrierId)) continue;
    out.push(ids.length === c.unitIds.length ? c : ({ ...c, unitIds: ids } as Command));
  }
  return out;
}

// ---------------------------------------------------------------- respawn ---

/** Seconds the next respawn takes. */
export const respawnSecs = (s: FrontlineState): number =>
  Math.min(FRONTLINE.respawnMax, FRONTLINE.respawn + FRONTLINE.respawnPerDeath * Math.max(0, s.stats.deaths - 1));

/** A fireteam member the soldier could respawn beside (on the ground, unhurt for a while), or null. */
export function squadSpawn(w: World): Unit | null {
  const safe = secs(FRONTLINE.squadSpawnSafe);
  for (const u of teamUnits(w))
    if (UNITS[u.kind].domain === "ground" && w.tick - u.damagedTick > safe) return u;
  return null;
}

/** Back into the fight once the timer allows: at the HQ, or beside a fireteam member. Returns whether it worked. */
export function respawn(w: World, at: "hq" | "squad"): boolean {
  const s = w.frontline;
  if (!s || s.respawnAt === null || w.tick < s.respawnAt) return false;
  let p: { x: number; y: number } | null = null;
  if (at === "squad") {
    const m = squadSpawn(w);
    if (m) p = { x: m.x - sin(s.yaw) * 0.8, y: m.y + cos(s.yaw) * 0.8 };
  }
  if (!p) {
    const hq = hqOf(w, s.side) ?? [...w.buildings.values()].find((b) => b.faction === s.side) ?? null;
    if (!hq) return false;
    const c = buildingCenter(hq);
    p = { x: c.x + sin(s.yaw) * 2.6, y: c.y - cos(s.yaw) * 2.6 };
    at = "hq";
  }
  spawnAvatar(w, p.x, p.y);
  s.mag.carbine = weaponStats(s, "carbine").mag;
  s.mag.rail = weaponStats(s, "rail").mag;
  s.mag.launcher = 1;
  s.rockets = Math.max(s.rockets, maxRockets(s) - 1);
  s.grenades = Math.max(s.grenades, maxGrenades(s));
  s.feed.push({ type: "respawned", at });
  if (s.mode === "follow") follow(w, true);
  return true;
}

// ------------------------------------------------------------------- tick ---

/** Per tick (sim.ts step, after objectives): deaths and rewards, regeneration, resupply, reinforcements, the fireteam. */
export function tickFrontline(w: World): void {
  const s = w.frontline;
  if (!s) return;
  const R = FRONTLINE.rp;
  const team = new Set(s.team);
  for (const e of w.fx) {
    if (e.type === "death") {
      if (e.faction === s.side) {
        if (e.id === s.avatarId) {
          s.avatarId = null;
          s.stats.deaths++;
          s.respawnAt = w.tick + secs(respawnSecs(s));
          s.feed.push({ type: "died", by: e.killerId !== null ? nameOf(w, e.killerId) : null });
        } else if (team.has(e.id) && e.unitKind) s.feed.push({ type: "teamLost", kind: e.unitKind });
        continue;
      }
      const name = e.unitKind ? UNITS[e.unitKind].name : e.buildingKind ? BUILDINGS[e.buildingKind].name : "target";
      if (e.killerId !== null && e.killerId === s.avatarId) {
        const rp = R.killShare * e.value + R.killFlat;
        earn(s, rp);
        s.stats.kills++;
        s.feed.push({ type: "kill", name, rp: Math.round(rp), building: e.buildingKind !== null });
      } else if (e.killerId !== null && team.has(e.killerId)) {
        const rp = R.teamKillShare * e.value;
        earn(s, rp);
        s.stats.squadKills++;
        s.feed.push({ type: "teamKill", name, rp: Math.round(rp) });
      }
    } else if (e.type === "uplinkFlip" && e.owner === s.side) {
      const a = avatarOf(w);
      if (a && hypot(a.x - e.x, a.y - e.y) <= OBJECTIVES.uplink.radius + 0.5) {
        earn(s, R.capture);
        s.stats.captures++;
        s.feed.push({ type: "captured" }, { type: "rp", amount: R.capture, why: "Uplink captured" });
      }
    } else if (e.type === "crateClaimed" && e.collectorId === s.avatarId) {
      earn(s, R.crate);
      s.stats.crates++;
      s.rockets = maxRockets(s);
      s.grenades = maxGrenades(s);
      s.feed.push({ type: "crate" }, { type: "rp", amount: R.crate, why: "Supply crate" });
    }
  }
  s.team = s.team.filter((id) => w.units.has(id));
  // a soldier the step removed without a death event (it never is, but don't strand the player)
  if (s.avatarId !== null && !w.units.has(s.avatarId)) {
    s.avatarId = null;
    s.respawnAt ??= w.tick + secs(respawnSecs(s));
  }
  earn(s, R.perSec / TICK_RATE);

  const a = avatarOf(w);
  if (a) {
    const fast = level(s, "nanites") > 0;
    const delay = secs(fast ? FRONTLINE.regenDelay / 2 : FRONTLINE.regenDelay);
    const max = UNITS[a.kind].hp;
    if (a.hp < max && w.tick - a.damagedTick > delay)
      a.hp = Math.min(max, a.hp + (FRONTLINE.regenRate * (fast ? 2 : 1)) / TICK_RATE);
    if (w.tick >= s.resupplyAt) {
      s.resupplyAt = w.tick + secs(FRONTLINE.resupply);
      if (atSupply(w)) {
        if (s.rockets < maxRockets(s) - (s.mag.launcher ? 1 : 0)) s.rockets++;
        if (s.grenades < maxGrenades(s)) s.grenades++;
      }
    }
  }

  // a reinforcement touches down beside the soldier (or at home while the soldier is down)
  if (s.inbound && w.tick >= s.inbound.due) {
    const at = a ?? (hqOf(w, s.side) ? buildingCenter(hqOf(w, s.side)!) : null);
    if (at) {
      const u = addTeam(w, s.inbound.kind, at.x - sin(s.yaw) * 1.2, at.y + cos(s.yaw) * 1.2);
      if (u) {
        w.fx.push({ type: "explosion", x: u.x, y: u.y, size: 0.8, air: false, kind: "impact" });
        s.feed.push({ type: "reinforced", kind: u.kind });
      }
    }
    s.inbound = null;
  }

  // standing orders
  if (s.mode === "attack" && (s.attackId === null || !isFoe(w, s.attackId))) {
    s.mode = "follow";
    s.attackId = null;
  }
  if (s.mode === "follow" && w.tick % 5 === 0) follow(w);
}
