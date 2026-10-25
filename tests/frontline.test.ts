import { describe, expect, it } from "vitest";
import { DIFFICULTY, type Difficulty } from "../src/sim/ai/commander";
import { DAMAGE_VS, TICK_RATE, UNITS } from "../src/sim/balance";
import { tickFog } from "../src/sim/fog";
import { MAPS, createMapWorld } from "../src/sim/maps";
import {
  FRONTLINE, REINFORCEMENTS, UPGRADES, WEAPONS, applyHandicap, atSupply, avatarArmor, avatarBlast, avatarOf, avatarShot,
  buyUpgrade, falloffAt, filterAiCommands, maxRockets, moveAvatar, requestBlocker, requestSquad, respawn, respawnSecs,
  setupFrontline, squadSpawn, standable, teamOrder, teamUnits, upgradeBlocker, weaponStats
} from "../src/sim/modes/frontline";
import { step } from "../src/sim/sim";
import { Terrain, type Command, type World } from "../src/sim/types";
import { buildingCenter, createWorld, hqOf, setTerrain, spawnBuilding, spawnUnit } from "../src/sim/world";
import { FrontlineBot } from "../tools/frontline-bot";

/** A flat 40×40 field: blue's HQ in the west, red's in the east, and a Frontline soldier with its fireteam. */
function field(): World {
  const w = createWorld(40, 40);
  spawnBuilding(w, "hq", "blue", 3, 18);
  spawnBuilding(w, "hq", "red", 34, 18);
  setupFrontline(w, { enemyIncome: 1.3 });
  return w;
}

const run = (w: World, n: number, cmds: Command[] = []) => {
  for (let i = 0; i < n; i++) step(w, i === 0 ? cmds : []);
};

/** Put the soldier at (x, y), away from the HQ's supply reach unless asked. */
function place(w: World, x: number, y: number): void {
  const a = avatarOf(w)!;
  a.x = x;
  a.y = y;
}

describe("Frontline setup", () => {
  it("puts the soldier beside the HQ, facing the enemy, with a fireteam and starting RP", () => {
    const w = field();
    const s = w.frontline!;
    const a = avatarOf(w)!;
    expect(a.avatar).toBe(true);
    expect(a.kind).toBe("trooper");
    expect(a.faction).toBe("blue");
    expect(Math.hypot(a.x - buildingCenter(hqOf(w, "blue")!).x, a.y - buildingCenter(hqOf(w, "blue")!).y)).toBeLessThan(4);
    // red's HQ is due east: yaw a quarter turn clockwise from north
    expect(s.yaw).toBeCloseTo(Math.PI / 2, 2);
    expect(teamUnits(w).map((u) => u.kind)).toEqual(FRONTLINE.startTeam);
    expect(teamUnits(w).every((u) => u.free)).toBe(true);
    expect(s.rp).toBe(FRONTLINE.rp.start);
  });

  it("is offered on every two-player map a soldier can walk across", () => {
    const ok = MAPS.filter((m) => m.players !== 4 && !m.islands).map((m) => m.id);
    expect(ok).toContain("riverlands");
    expect(ok).not.toContain("archipelago");
  });
});

describe("the soldier on the sim's books", () => {
  it("is never moved, nudged or fired for by the sim", () => {
    const w = field();
    const a = avatarOf(w)!;
    place(w, 20, 20);
    const foe = spawnUnit(w, "stinger", "red", 21.5, 20);
    w.powers.stunned.set(foe.id, 1e9); // (the Stinger just sits there)
    const friend = spawnUnit(w, "trooper", "blue", 20.1, 20); // separation would push them apart
    w.powers.stunned.set(friend.id, 1e9); // (and it holds its fire: only the soldier could hurt the Stinger)
    run(w, 30);
    expect(a.x).toBe(20);
    expect(a.y).toBe(20);
    expect(foe.hp).toBe(UNITS.stinger.hp - 0); // the soldier never fired on its own…
    expect(Math.hypot(friend.x - 20, friend.y - 20)).toBeGreaterThan(0.5); // …and the squad took the whole push
  });

  it("is shot by enemies like a squad, through its plating", () => {
    const w = field();
    const a = avatarOf(w)!;
    place(w, 20, 20);
    spawnUnit(w, "stinger", "red", 22, 20);
    w.frontline!.shieldUntil = 0;
    run(w, 30);
    const lost = UNITS.trooper.hp - a.hp;
    expect(lost).toBeGreaterThan(0);
    // 3 s of a Stinger: ~5 shots of 13.2, kinetic ×1 vs infantry, ×0.6 plating
    const shot = UNITS.stinger.dps * UNITS.stinger.shotInterval! * DAMAGE_VS.kinetic.infantry * FRONTLINE.armor;
    expect(lost / shot).toBeCloseTo(Math.round(lost / shot), 5);
  });

  it("takes nothing under the spawn shield, and plating cuts damage", () => {
    const w = field();
    w.tick = 0;
    w.frontline!.shieldUntil = 10;
    expect(avatarArmor(w)).toBe(0);
    w.tick = 10;
    expect(avatarArmor(w)).toBeCloseTo(FRONTLINE.armor);
    w.frontline!.upgrades.plating = 2;
    expect(avatarArmor(w)).toBeCloseTo(FRONTLINE.armor * FRONTLINE.platingStep ** 2);
  });

  it("walks at its pace, and not through rock, water or buildings", () => {
    const w = field();
    place(w, 20, 20);
    const a = avatarOf(w)!;
    moveAvatar(w, 0, -1, 1);
    expect(a.y).toBeCloseTo(20 - FRONTLINE.speed, 5);
    moveAvatar(w, 0, -1, 1, true);
    expect(a.y).toBeCloseTo(20 - FRONTLINE.speed * (1 + FRONTLINE.sprint), 5);
    // a rock wall to the east: it slides along it, never into it
    for (let y = 0; y < 40; y++) setTerrain(w, 22, y, Terrain.Rock);
    place(w, 21.5, 20);
    moveAvatar(w, 1, 1, 1);
    expect(a.x).toBeLessThan(22 - FRONTLINE.radius + 1e-9);
    expect(a.y).toBeGreaterThan(20);
    expect(standable(w, 22.5, 20)).toBe(false);
    setTerrain(w, 10, 10, Terrain.Water);
    expect(standable(w, 10.5, 10.5)).toBe(false);
    expect(standable(w, 4.5, 19.5)).toBe(false); // the HQ's footprint
  });
});

describe("the soldier's guns", () => {
  it("hit with armour, falloff and kill credit, and pay RP for damage and kills", () => {
    const w = field();
    place(w, 20, 20);
    const s = w.frontline!;
    const foe = spawnUnit(w, "trooper", "red", 25, 20);
    w.powers.stunned.set(foe.id, 1e9);
    const rp = s.rp;
    const dealt = avatarShot(w, foe.id, "carbine", 5);
    expect(dealt).toBeCloseTo(WEAPONS.carbine.damage * DAMAGE_VS.kinetic.infantry);
    expect(s.rp).toBeGreaterThan(rp);
    // falloff past its full-damage range, nothing past max range
    expect(falloffAt(WEAPONS.carbine, WEAPONS.carbine.falloff)).toBe(1);
    expect(falloffAt(WEAPONS.carbine, WEAPONS.carbine.range)).toBeCloseTo(WEAPONS.carbine.minFalloff);
    expect(avatarShot(w, foe.id, "carbine", WEAPONS.carbine.range + 1)).toBe(0);
    // the rail: precision ×3 against robots
    s.upgrades.rail = 1;
    expect(avatarShot(w, foe.id, "rail", 10)).toBeCloseTo(WEAPONS.rail.damage * DAMAGE_VS.precision.infantry);
    while (foe.hp > 0) avatarShot(w, foe.id, "carbine", 5);
    run(w, 1);
    expect(s.stats.kills).toBe(1);
    expect(s.feed.some((e) => e.type === "kill" && e.name === UNITS.trooper.name)).toBe(true);
    expect(avatarOf(w)!.kills).toBe(1);
    // RP for the whole squad: its damage share and the kill bonus (plus a tick of trickle)
    const R = FRONTLINE.rp;
    expect(s.rpEarned).toBeCloseTo(R.damageShare * UNITS.trooper.cost + R.killShare * UNITS.trooper.cost + R.killFlat + R.perSec / TICK_RATE, 0);
  });

  it("never hurt friends", () => {
    const w = field();
    place(w, 20, 20);
    const friend = spawnUnit(w, "trooper", "blue", 22, 20);
    expect(avatarShot(w, friend.id, "carbine", 2)).toBe(0);
    expect(avatarBlast(w, 22, 20, 100, 2, "explosive")).toBe(0);
    expect(friend.hp).toBe(UNITS.trooper.hp);
  });

  it("rockets kill armour, splash ground targets, and only burst on aircraft in the air", () => {
    const w = field();
    place(w, 10, 30);
    const tank = spawnUnit(w, "mastodon", "red", 20, 20);
    const squad = spawnUnit(w, "trooper", "red", 20.6, 20);
    const drone = spawnUnit(w, "wasp", "red", 20, 20.3);
    const st = weaponStats(w.frontline!, "launcher");
    avatarBlast(w, 20, 20, st.damage, st.splash!, st.dmgType, { air: false });
    expect(UNITS.mastodon.hp - tank.hp).toBeCloseTo(st.damage * DAMAGE_VS.cannon.heavy);
    expect(squad.hp).toBeLessThan(UNITS.trooper.hp);
    expect(drone.hp).toBe(UNITS.wasp.hp);
    avatarBlast(w, 20, 20.3, st.damage, st.splash!, st.dmgType, { air: true, airMult: st.airMult });
    expect(drone.hp).toBeLessThan(UNITS.wasp.hp);
  });

  it("upgrades change the numbers", () => {
    const w = field();
    const s = w.frontline!;
    expect(weaponStats(s, "carbine").damage).toBe(WEAPONS.carbine.damage);
    s.upgrades["carbine-dmg"] = 2;
    s.upgrades["carbine-mag"] = 1;
    s.upgrades["carbine-ap"] = 1;
    const c = weaponStats(s, "carbine");
    expect(c.damage).toBeCloseTo(WEAPONS.carbine.damage * 1.4);
    expect(c.mag).toBe(45);
    expect(c.floor).toBe(1);
    // tungsten rounds: a Mastodon takes the full carbine round, not ×0.6
    place(w, 20, 20);
    const tank = spawnUnit(w, "mastodon", "red", 24, 20);
    expect(avatarShot(w, tank.id, "carbine", 4)).toBeCloseTo(c.damage);
  });
});

describe("Requisition", () => {
  it("buys upgrades only at a supply point (or while redeploying), with the RP for them", () => {
    const w = field();
    const s = w.frontline!;
    place(w, 20, 20);
    expect(atSupply(w)).toBe(false);
    s.rp = 1000;
    expect(upgradeBlocker(w, "launcher")).toBe("Visit a supply point");
    place(w, 8, 19.5); // beside the HQ
    expect(atSupply(w)).toBe(true);
    expect(buyUpgrade(w, "launcher")).toBeNull();
    expect(s.rp).toBe(1000 - UPGRADES.find((u) => u.id === "launcher")!.cost[0]!);
    expect(s.rockets + s.mag.launcher).toBe(maxRockets(s));
    expect(upgradeBlocker(w, "launcher")).toBe("Owned");
    expect(upgradeBlocker(w, "carbine-ap")).toMatch(/^Needs/);
    s.rp = 10;
    expect(upgradeBlocker(w, "plating")).toBe("110 RP");
  });

  it("an Uplink Blue holds is a supply point", () => {
    const w = field();
    w.objectives.uplinks.push({ id: 999, x: 20, y: 30, owner: "blue", progress: 100, pushing: null, contested: false });
    place(w, 21, 30);
    expect(atSupply(w)).toBe(true);
    w.objectives.uplinks[0]!.owner = "red";
    expect(atSupply(w)).toBe(false);
  });

  it("calls in reinforcements beside the soldier after the wait, up to the team's cap", () => {
    const w = field();
    const s = w.frontline!;
    place(w, 20, 20);
    s.rp = 1000;
    expect(requestSquad(w, "sniper")).toBeNull();
    expect(s.rp).toBe(1000 - REINFORCEMENTS.sniper.cost);
    expect(requestBlocker(w, "trooper")).toBe("One already inbound");
    run(w, FRONTLINE.inbound * TICK_RATE + 1);
    const sniper = teamUnits(w).find((u) => u.kind === "sniper")!;
    expect(sniper).toBeDefined();
    expect(Math.hypot(sniper.x - 20, sniper.y - 20)).toBeLessThan(3);
    expect(s.feed.some((e) => e.type === "reinforced")).toBe(true);
    expect(requestSquad(w, "mender")).toBeNull();
    run(w, FRONTLINE.inbound * TICK_RATE + 1);
    expect(teamUnits(w)).toHaveLength(FRONTLINE.teamMax);
    expect(requestBlocker(w, "trooper")).toMatch(/full/);
  });

  it("earns RP for the fireteam's kills and for Uplinks taken in person", () => {
    const w = field();
    const s = w.frontline!;
    const m = teamUnits(w)[0]!;
    const foe = spawnUnit(w, "stinger", "red", m.x + 1, m.y);
    w.powers.stunned.set(foe.id, 1e9);
    foe.hp = 1;
    run(w, 10);
    expect(s.stats.squadKills).toBe(1);
    expect(s.feed.some((e) => e.type === "teamKill")).toBe(true);
  });
});

describe("the fireteam", () => {
  it("is the player's: the commander's orders for it (and the soldier) are dropped", () => {
    const w = field();
    const s = w.frontline!;
    const other = spawnUnit(w, "stinger", "blue", 10, 10);
    const ids = [s.avatarId!, ...s.team, other.id];
    const out = filterAiCommands(w, [
      { type: "move", faction: "blue", unitIds: ids, x: 1, y: 1 },
      { type: "attackMove", faction: "blue", unitIds: s.team, x: 1, y: 1 },
      { type: "startBuilding", faction: "blue", building: "turret" }
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "move", unitIds: [other.id] });
    expect(out[1]!.type).toBe("startBuilding");
  });

  it("follows in formation, holds a point, and focuses a target until it falls", () => {
    const w = field();
    const s = w.frontline!;
    place(w, 20, 20);
    s.yaw = Math.PI / 2;
    run(w, 80);
    for (const u of teamUnits(w)) expect(Math.hypot(u.x - 20, u.y - 20)).toBeLessThan(3.5);
    teamOrder(w, "hold", { x: 20, y: 32 });
    run(w, 100);
    for (const u of teamUnits(w)) expect(Math.hypot(u.x - 20, u.y - 32)).toBeLessThan(3);
    const foe = spawnUnit(w, "harvester", "red", 24, 32);
    expect(teamOrder(w, "attack", null, foe.id)).toBe(true);
    for (const u of teamUnits(w)) expect(u.order).toMatchObject({ type: "attack", targetId: foe.id });
    run(w, 400);
    expect(w.units.has(foe.id)).toBe(false);
    expect(s.mode).toBe("follow");
  });
});

describe("death and redeploying", () => {
  it("waits out the timer, then deploys at the HQ or beside a safe fireteam member", () => {
    const w = field();
    const s = w.frontline!;
    const a = avatarOf(w)!;
    a.hp = 0;
    run(w, 1);
    expect(avatarOf(w)).toBeNull();
    expect(s.stats.deaths).toBe(1);
    expect(s.respawnAt).toBe(w.tick - 1 + Math.round(respawnSecs(s) * TICK_RATE));
    expect(respawn(w, "hq")).toBe(false); // too soon
    run(w, respawnSecs(s) * TICK_RATE);
    const m = squadSpawn(w)!;
    expect(m).not.toBeNull();
    expect(respawn(w, "squad")).toBe(true);
    const b = avatarOf(w)!;
    expect(b.id).not.toBe(a.id);
    expect(Math.hypot(b.x - m.x, b.y - m.y)).toBeLessThan(2);
    expect(avatarArmor(w)).toBe(0); // spawn shield
    // later deaths wait longer, up to the cap
    s.stats.deaths = 50;
    expect(respawnSecs(s)).toBe(FRONTLINE.respawnMax);
  });

  it("regenerates out of the fight, faster with nanites", () => {
    const w = field();
    const a = avatarOf(w)!;
    place(w, 20, 20);
    a.hp = 100;
    a.damagedTick = w.tick;
    run(w, FRONTLINE.regenDelay * TICK_RATE);
    expect(a.hp).toBe(100);
    run(w, TICK_RATE);
    expect(a.hp).toBeCloseTo(100 + FRONTLINE.regenRate * (1 - 1 / TICK_RATE), 0);
  });
});

describe("the enemy's edge", () => {
  it("multiplies only the enemy's income, once per commander pass", () => {
    const w = field();
    w.factions.red.incomeMult = 1;
    w.factions.blue.incomeMult = 1;
    applyHandicap(w);
    expect(w.factions.red.incomeMult).toBeCloseTo(1.3);
    expect(w.factions.blue.incomeMult).toBe(1);
  });

  it("the enemy's whole income (its difficulty's, times the edge) rises with difficulty", () => {
    const e = FRONTLINE.enemyIncome;
    const total = (d: Difficulty) => DIFFICULTY[d].incomeMult * e[d];
    expect(total("easy")).toBeLessThan(total("normal"));
    expect(total("normal")).toBeLessThanOrEqual(total("hard")); // (Hard also thinks faster and runs an extra harvester)
  });
});

describe("the scripted Frontline player (tools/frontline-bot.ts)", () => {
  it("fights on a real map without breaking the match", () => {
    const w = setupWorldFor("riverlands");
    const bot = new FrontlineBot(w, { accuracy: 0.5, shop: true }, 7);
    for (let i = 0; i < 150 * TICK_RATE && !w.winner; i++) {
      bot.tick();
      step(w, []);
    }
    const s = w.frontline!;
    expect(s.stats.shots).toBeGreaterThan(0);
    expect(s.rpEarned).toBeGreaterThan(0);
    // the soldier is still a single unit on the books, alive or awaiting redeploy
    expect([...w.units.values()].filter((u) => u.avatar).length).toBeLessThanOrEqual(1);
  });
});

function setupWorldFor(map: string): World {
  const w = createMapWorld(map, { seed: 5, objectives: true });
  setupFrontline(w, { enemyIncome: 1 });
  tickFog(w);
  return w;
}
