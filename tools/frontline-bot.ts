// A scripted Frontline player (FRONTLINE.md "Balance"): walks its soldier to
// the fight, shoots what it can see with a set accuracy, keeps its fireteam
// following, falls back to heal, shops at supply points and calls
// reinforcements. Pure simulation (no Node APIs), so tests can import it;
// tools/frontline.ts plays matches with it.
import { createAiState, tickAi, type Difficulty, type StrategyName } from "../src/sim/ai/commander";
import { TICK_RATE, UNITS } from "../src/sim/balance";
import { isVisible } from "../src/sim/fog";
import { hash32 } from "../src/sim/rand";
import { unitSeenBy } from "../src/sim/infantry";
import { createMapWorld } from "../src/sim/maps";
import { findPath } from "../src/sim/movement";
import {
  FRONTLINE, REINFORCEMENTS, applyHandicap, atSupply, avatarBlast, avatarOf, avatarShot, buyUpgrade, filterAiCommands, maxRockets,
  moveAvatar, lookAvatar, noteShot, ownsWeapon, requestSquad, respawn, setupFrontline, teamUnits, upgradeBlocker,
  weaponStats, type TeamKind, type UpgradeId, type WeaponId
} from "../src/sim/modes/frontline";
import { pickAiOpener } from "../src/sim/openers";
import { step } from "../src/sim/sim";
import type { Faction, Unit, World } from "../src/sim/types";
import { buildingCenter, hqOf } from "../src/sim/world";

export interface BotOptions {
  /** Share of shots that hit at close range (falls off to half at long range). */
  accuracy: number;
  /** Spend RP on upgrades and reinforcements. */
  shop?: boolean;
}

const SHOP: UpgradeId[] = [
  "carbine-dmg", "launcher", "plating", "carbine-mag", "nanites", "launcher-ammo",
  "carbine-dmg", "plating", "launcher-tandem", "carbine-ap", "servos", "grenades", "rail", "rail-dmg"
];
const CALLS: TeamKind[] = ["trooper", "rocket-squad", "mender", "trooper", "sniper"];

export class FrontlineBot {
  private cd: Record<WeaponId, number> = { carbine: 0, rail: 0, launcher: 0 };
  private reloading: { weapon: WeaponId; left: number } | null = null;
  private nade = 0;
  private path: { x: number; y: number }[] = [];
  private repath = 0;
  private goal: { x: number; y: number } | null = null;
  private retreating = false;
  private calls = 0;
  private n = 0;

  constructor(private w: World, private opts: BotOptions, private seed: number) {}

  private rand(): number {
    return (hash32(this.seed, this.n++) >>> 0) / 4294967296;
  }

  /** One tick's worth of play (before step). */
  tick(): void {
    const w = this.w;
    const s = w.frontline!;
    const dt = 1 / TICK_RATE;
    if (!avatarOf(w)) {
      this.shop();
      if (s.respawnAt !== null && w.tick >= s.respawnAt) respawn(w, "squad") || respawn(w, "hq");
      this.path = [];
      return;
    }
    const a = avatarOf(w)!;
    for (const k of Object.keys(this.cd) as WeaponId[]) this.cd[k] = Math.max(0, this.cd[k] - dt);
    this.nade = Math.max(0, this.nade - dt);
    if (this.reloading) {
      this.reloading.left -= dt;
      if (this.reloading.left <= 0) {
        const wid = this.reloading.weapon;
        if (wid === "launcher") {
          if (s.rockets > 0) {
            s.rockets--;
            s.mag.launcher = 1;
          }
        } else s.mag[wid] = weaponStats(s, wid).mag;
        this.reloading = null;
      }
    }
    if (atSupply(w)) this.shop();

    const hp = a.hp / UNITS.trooper.hp;
    if (hp < 0.3) this.retreating = true;
    if (hp > 0.85) this.retreating = false;
    const target = this.retreating ? null : this.pickTarget(a);
    if (target) {
      this.shoot(a, target.u, target.d);
      // hold a fighting distance
      if (target.d > 7) this.walk(a, target.u.x, target.u.y, dt);
      else if (target.d < 3.2) moveAvatar(w, a.x - target.u.x, a.y - target.u.y, dt);
    } else {
      const g = this.retreating ? this.home() : this.front(a);
      if (g) this.walk(a, g.x, g.y, dt);
    }
  }

  private home(): { x: number; y: number } | null {
    const hq = hqOf(this.w, this.w.frontline!.side);
    return hq ? buildingCenter(hq) : null;
  }

  /** Where the fight is: the nearest enemy seen, else the nearest Uplink not ours, else the enemy HQ. */
  private front(a: Unit): { x: number; y: number } | null {
    const w = this.w;
    const side = w.frontline!.side;
    let best: { x: number; y: number } | null = null;
    let bd = 24;
    for (const u of w.units.values()) {
      if (u.faction === side || !unitSeenBy(w, side, u)) continue;
      const d = Math.hypot(u.x - a.x, u.y - a.y);
      if (d < bd) (bd = d), (best = u);
    }
    if (best) return best;
    bd = Infinity;
    for (const l of w.objectives.uplinks) {
      if (l.owner === side || l.infantryOnly) continue;
      const d = Math.hypot(l.x - a.x, l.y - a.y);
      if (d < bd) (bd = d), (best = l);
    }
    if (best) return best;
    const foe = [...w.buildings.values()].find((b) => b.faction !== side && b.kind === "hq");
    return foe ? buildingCenter(foe) : null;
  }

  private pickTarget(a: Unit): { u: Unit; d: number } | null {
    const w = this.w;
    const side = w.frontline!.side;
    let best: { u: Unit; d: number } | null = null;
    for (const u of w.units.values()) {
      if (u.faction === side || u.hp <= 0) continue;
      if (!isVisible(w, side, Math.floor(u.x), Math.floor(u.y)) || !unitSeenBy(w, side, u)) continue;
      const d = Math.hypot(u.x - a.x, u.y - a.y);
      if (d > 12) continue;
      // armed things first
      const score = d + (UNITS[u.kind].targets === "none" ? 4 : 0);
      if (!best || score < best.d + (UNITS[best.u.kind].targets === "none" ? 4 : 0)) best = { u, d };
    }
    return best;
  }

  private shoot(a: Unit, t: Unit, d: number): void {
    const w = this.w;
    const s = w.frontline!;
    lookAvatar(w, Math.atan2(t.x - a.x, -(t.y - a.y)), 0);
    const armour = UNITS[t.kind].armor;
    const heavy = armour === "heavy" || armour === "medium";
    let wid: WeaponId = "carbine";
    if (heavy && ownsWeapon(s, "launcher") && (s.mag.launcher > 0 || s.rockets > 0)) wid = "launcher";
    else if (armour === "infantry" && ownsWeapon(s, "rail") && d > 5) wid = "rail";
    const st = weaponStats(s, wid);
    if (this.reloading || this.cd[wid] > 0) return;
    if (s.mag[wid] <= 0) {
      this.reloading = { weapon: wid, left: st.reload };
      return;
    }
    s.mag[wid]--;
    this.cd[wid] = st.interval;
    const k = d <= 5 ? 1 : Math.max(0.5, 1 - (d - 5) / 14);
    const hit = this.rand() < this.opts.accuracy * k;
    noteShot(w, hit);
    const air = UNITS[t.kind].domain === "air";
    if (wid === "launcher") {
      if (hit) avatarBlast(w, t.x, t.y, st.damage, st.splash!, st.dmgType, { air, airMult: st.airMult });
    } else if (hit) avatarShot(w, t.id, wid, d);
    // a grenade into a crowd of ground targets
    if (!air && this.nade <= 0 && s.grenades > 0 && d < 6) {
      let crowd = 0;
      for (const u of w.units.values()) if (u.faction !== s.side && Math.hypot(u.x - t.x, u.y - t.y) < 1.4) crowd++;
      if (crowd >= 2) {
        s.grenades--;
        this.nade = 4;
        const G = FRONTLINE.grenade;
        if (this.rand() < Math.min(1, this.opts.accuracy + 0.25)) avatarBlast(w, t.x, t.y, G.damage, G.splash, "explosive");
      }
    }
  }

  private walk(a: Unit, x: number, y: number, dt: number): void {
    const w = this.w;
    if (!this.goal || Math.hypot(this.goal.x - x, this.goal.y - y) > 2 || this.repath <= 0 || this.path.length === 0) {
      this.goal = { x, y };
      this.path = findPath(w, a.x, a.y, x, y, "foot", w.frontline!.side) ?? [];
      this.repath = 3;
    }
    this.repath -= dt;
    while (this.path.length && Math.hypot(this.path[0]!.x - a.x, this.path[0]!.y - a.y) < 0.4) this.path.shift();
    const p = this.path[0] ?? { x, y };
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    if (Math.hypot(dx, dy) < 0.2) return;
    if (!moveAvatar(w, dx, dy, dt, !this.pickTarget(a))) this.path = [];
    lookAvatar(w, Math.atan2(dx, -dy), 0);
  }

  private shop(): void {
    if (!this.opts.shop) return;
    const w = this.w;
    const s = w.frontline!;
    // keep the fireteam topped up before buying gear
    if (teamUnits(w).length < 3 && !s.inbound) {
      const k = CALLS[this.calls % CALLS.length]!;
      if (s.rp >= REINFORCEMENTS[k].cost + 40 && !requestSquad(w, k)) this.calls++;
    }
    for (const id of SHOP) {
      const why = upgradeBlocker(w, id);
      if (why === "Owned" || why?.startsWith("Needs")) continue;
      if (why === null) buyUpgrade(w, id);
      break;
    }
    if (ownsWeapon(s, "launcher") && s.rockets > maxRockets(s)) s.rockets = maxRockets(s);
  }
}

export interface FrontlineMatch {
  map: string;
  seed: number;
  /** "none": no player at all (plain AI vs AI with Frontline's enemy income). */
  player: "none" | "idle" | number;
  difficulty: Difficulty;
  blue: string;
  red: string;
  winner: Faction | "draw";
  min: number;
  stats: NonNullable<World["frontline"]>["stats"] | null;
  rpEarned: number;
  upgrades: number;
}

/**
 * One Frontline match: blue's commander (Balanced, Normal: the mode's fixed
 * ally) with the bot's soldier and fireteam on its side, against a `difficulty`
 * commander with FRONTLINE.enemyIncome. `player` "none" leaves the soldier and
 * fireteam out; "idle" puts them in but the bot never shoots (what the
 * fireteam alone is worth); a number is the bot's accuracy.
 */
export function playFrontline(map: string, seed: number, player: FrontlineMatch["player"], difficulty: Difficulty, red?: StrategyName): FrontlineMatch {
  const blueName: StrategyName = "balanced";
  const redAi = createAiState(red, difficulty, seed + 1);
  const openers = { blue: pickAiOpener(blueName, seed, "blue"), red: pickAiOpener(redAi.strategy.name, seed, "red") };
  const w = createMapWorld(map, { seed, objectives: true, openers });
  const blueAi = createAiState(blueName, "normal", seed + 2);
  const handicap = FRONTLINE.enemyIncome[difficulty];
  const bot = player === "none" ? null : (setupFrontline(w, { enemyIncome: handicap }), new FrontlineBot(w, { accuracy: player === "idle" ? 0 : player, shop: player !== "idle" }, seed));
  for (let i = 0; i < 25 * 60 * TICK_RATE && !w.winner; i++) {
    bot?.tick();
    const blue = tickAi(w, "blue", blueAi);
    const red = tickAi(w, "red", redAi);
    if (bot) applyHandicap(w);
    else w.factions.red.incomeMult *= handicap;
    step(w, [...(bot ? filterAiCommands(w, blue) : blue), ...red]);
  }
  const s = w.frontline ?? null;
  return {
    map, seed, player, difficulty, blue: blueName, red: redAi.strategy.name,
    winner: w.winner ?? "draw", min: w.tick / TICK_RATE / 60,
    stats: s ? { ...s.stats } : null, rpEarned: s ? Math.round(s.rpEarned) : 0,
    upgrades: s ? Object.values(s.upgrades).reduce((a, b) => a + (b ?? 0), 0) : 0
  };
}
