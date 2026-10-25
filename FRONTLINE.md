# Frontline — the battle in first person

## Status

Implemented. A fourth mode on the menu (**🎯 Frontline**, beside Skirmish,
Last Stand and Ops). Code: `src/sim/modes/frontline.ts` (the rules, pure sim),
`src/fps/` (the first-person scene, HUD, controls and viewmodel),
`tools/frontline-bot.ts` + `tools/frontline.ts` (the scripted player and the
balance panel), `tests/frontline.test.ts`.

## The idea

The RTS battle carries on exactly as it does in AI vs AI: two commanders
build bases, harvest, fight over the Uplinks and call down strikes. The
player is not a commander. They are **one robot in Blue's army**, walking
the battlefield at eye level with a gun, at the head of a small
**fireteam** of squads that answer to them and not to the commander.

What makes it a game and not a tourist trip is the balance target:
**Blue's commander loses without the player.** Red gets an income edge (see
*Difficulty*), so the war is lost by default and won by a soldier who takes
Uplinks, kills the right things, keeps their fireteam alive and spends their
requisition well.

Not in this mode: replays, duels, Last Stand waves, the island map
(nothing walks to an island) and the four-player map. Mutators are off.

## How it sits on the sim

- **The soldier is a Trooper Squad on the sim's books** with `Unit.avatar`
  set. Everything that applies to a squad applies to it for free: enemies
  target it and get the kill, Mastodons crush it, woods halve the damage it
  takes, Menders repair it, it counts double in an Uplink's ring and it
  claims supply crates. Three small hooks keep the sim's hands off it:
  combat never fires for it or turns it on an attacker, movement never moves
  it, and separation never shoves it (others give way, as round a dug-in
  Goliath).
- **The player moves and shoots it directly**, between sim ticks:
  `moveAvatar` (walking with wall-sliding, terrain pace, sprint),
  `avatarShot` and `avatarBlast` (a hit through the sim's own damage table,
  cover and kill credit: `combat.ts directHit`).
- **Aiming is 3D, damage is sim.** The first-person scene casts each round
  against the terrain heightfield, a vertical cylinder round each enemy unit
  where it is drawn (squads, tanks, drones at flying height) and each
  building's box. Rockets and grenades fly as 3D projectiles; their blasts
  are sim splash. Snipers hidden in woods can't be seen or hit, as in the RTS.
- **The fireteam are ordinary Blue units** the commander may not order
  (`filterAiCommands` drops their ids, and the soldier's, from Blue's
  commands). `tickFrontline` keeps them in formation behind the soldier.
- Frontline isn't replayed or played in lockstep, so the player's hits don't
  go through commands. The rest of the match is the deterministic sim as ever.

## Controls

| | Desktop | Touch |
|---|---|---|
| Move / look | WASD, mouse (pointer lock) | left-thumb stick, drag on the right |
| Sprint | Shift | push the stick to the rim |
| Fire / sights | left / right click | 🔥 (drag it to aim) / ◎ |
| Reload, grenade | R, G | ⟳, 💣 |
| Weapons | 1 2 3, wheel, Q (last) | ⇄ |
| Fireteam | F follow · H hold where I aim · T attack what I aim at | ⚑ ✋ 🎯 |
| Armory | B | 🛒 |
| Pause (and settings) | Esc | ⏸ |

On a phone, **aim assist** (the crosshair slows over an enemy and drifts onto
it) and **auto-fire** (the trigger pulls itself while the crosshair is on an
enemy in range; never with rockets) are on by default, with look sensitivity
and vibration, all in the pause menu. Phones play sideways: the game asks
for landscape where the browser allows it, and a portrait screen keeps about
80° of view across and moves the orders down the left edge.

## Survivability

The soldier has the Trooper Squad's 190 HP behind **0.6× plating** (about
317 effective), and **regenerates 14 HP/s after 5 s** without a hit.
What that means against the sim's own weapons (no cover, no regen):

| Under fire from | Time to kill the soldier |
|---|---|
| a Trooper Squad (15 DPS, kinetic) | ~21 s |
| a Stinger (22 DPS, kinetic) | ~14 s |
| a Mastodon (46 DPS, cannon ×0.4 vs infantry) | ~17 s, plus crushing |
| a Sniper Team (50/shot, precision ×3) | 3 shots, ~5 s |
| a Turret (26 DPS) | ~12 s |

So one enemy is a fight you win; three focusing you is a retreat, and the
woods (×0.5) are where you take it. Snipers are the soldier's real threat,
which is why the rail rifle exists. Spawn shield: 2.5 s, dropped by firing.

## Weapons

Damage is in sim HP before armour (`WEAPONS`, `weaponStats`). Squads have
38 HP per robot.

| | Carbine (start) | Rail Rifle (180 RP) | Rocket Launcher (160 RP) | Frag grenade |
|---|---|---|---|---|
| Hit | 7 kinetic, 9 rounds/s | 38 precision, 1 per 1.15 s | 105 cannon + 0.9 splash | 90 explosive, 1.3 splash |
| Magazine / reload | 30 / 1.7 s | 5 / 2.2 s | 1 / 1.4 s, 4 carried | 2 carried |
| Range (full / max) | 7 / 16, ×0.45 at max | 22 / 28 | 22 | thrown, 1.6 s fuse |
| Good against | robots, light drones | infantry (×3: 114, three robots a shot) | armour (×1.3 heavy), bombers (×1.4 air) | clumps |
| Poor against | heavy armour (×0.6), buildings | vehicles (×0.25–0.6) | infantry (×0.4) | aircraft |

Paper DPS for the carbine is 64 against robots, roughly 30 in a real fight
once misses and reloads are counted: **two Trooper Squads' worth**, which is
what a hero should be. It needs about 25 s of hits to bring down a Mastodon,
and that's the point: tanks are what rockets (yours and your Rocket Squad's)
are for. A Mastodon takes about seven rockets, so the launcher alone doesn't
solo heavy armour either; a launcher plus a Rocket Squad does.

Rockets and grenades refill one each every 2 s at a supply point, and fully
from a supply crate.

## Requisition (RP)

Earned by the soldier, spent by the soldier. Blue's scrap is the
commander's and is never touched.

| Source | RP |
|---|---|
| Damage dealt | 0.2 × target cost × share of its max HP |
| A killing blow | +0.1 × cost + 5 |
| A fireteam kill | +0.06 × cost |
| An Uplink taken with the soldier in its ring | +40 |
| A supply crate | +25 (and full ammo) |
| Just being there | 0.5/s |

So soloing a Trooper Squad pays ~35 RP and a Mastodon ~150. The panel's
scripted player earns 1,500–2,000 RP in a 10-minute win; the armory holds
1,760 RP of upgrades, plus reinforcements, so **a match buys about half of
everything** and the order matters.

**Upgrades** (only at a *supply point*: within 3 tiles of any Blue building,
or inside the ring of an Uplink Blue holds; anything while redeploying):

| Carbine | Rail | Launcher | Kit |
|---|---|---|---|
| Overcharged cells, +20% ×2 (90, 160) | Rail Rifle (180) | Rocket Launcher (160) | Grenade belt +2 (70) |
| Drum magazine: 45, 1.2 s reload (70) | Capacitor bank: +25%, 0.9 s (140) | Rocket rack +3 (90) | Ablative plating −15% ×2 (110, 190) |
| Tungsten rounds: full damage vs armour and buildings (150) | | Tandem warheads +30% (150) | Sprint servos +15% (80) |
| | | | Repair nanites: 2× regen after 2.5 s (120) |

Tying upgrades to supply points makes Uplinks matter twice over: hold one
and it is a forward armory.

## The fireteam

Starts as a **Trooper Squad and a Rocket Squad** (rifles for robots, rockets
for tanks: the two holes in a carbine-only soldier). Orders go to the whole
team:

- **Follow** (default): a loose formation behind the soldier. A member
  fighting within 6 tiles of the soldier is left to finish the fight;
  once the soldier moves on they re-form.
- **Hold**: attack-move to where the crosshair hits the ground and fight
  from there.
- **Attack**: focus the unit or building under the crosshair; back to
  following when it falls.

**Reinforcements** are radioed in from anywhere, paid in RP, and land beside
the soldier 8 s later, one at a time, four in the team at most: Trooper
Squad 100, Rocket Squad 150, Sniper Team 180, Mender 160 (a Mender repairs
the soldier too). They are `free` units: no wreck, no ⚡ meter for the enemy.

## Death and redeploying

Down for 5 s, +1.5 s for every death after the first, at most 12 s. Then
**deploy at the HQ**, or **on the fireteam** beside a ground member that
hasn't been hit for 5 s. Keeping the team alive is how you stay at the front.

## Difficulty

Blue's commander is always Balanced on Normal. Red's is the menu's
difficulty, and its income is multiplied on top of that difficulty's own
(`FRONTLINE.enemyIncome`, applied after every commander pass):

| | Easy | Normal | Hard |
|---|---|---|---|
| Red's income (difficulty × Frontline edge) | ×0.75 × 1.6 = 1.2 | ×1 × 1.3 = 1.3 | ×1.3 × 1.05 ≈ 1.37 |

Easy and Normal Red earn about the same; Easy still thinks slower, runs a
harvester short and attacks later. Hard needs hardly any edge: a Hard
commander out-thinks Blue's Normal one by itself.

## Balance: measured

`npx vite-node tools/frontline.ts --difficulty normal --seeds 4` plays
Frontline matches on Riverlands, Dune Sea, Frostbite and Proving Grounds
with the scripted player at several accuracies, and with no player at all
(the same income edge, for the baseline). The scripted player
(`tools/frontline-bot.ts`) walks to the nearest fight or contested Uplink,
shoots what it can see with a set hit chance, picks rockets for armour and
the rail for distant infantry, throws grenades into clumps, falls back to
regenerate below 30% HP, shops at supply points and keeps three in its
fireteam. Its target selection is better than a person's (it never misses a
target it could see), so read its 30% as a casual player and 50% as a good one.

The first tuning pass (enemy edge ×1.12 on Normal, RP rates 75% higher)
let a 30%-accuracy bot win 83% and a 50% one 100%, earning 2,300–2,700 RP:
the soldier decided too much and could buy almost everything. The numbers
above are the second pass:

Blue's win rate (4 maps, 12–28 matches per cell, about ±12 points):

| Red commander | No player | Bot, 30% hits | Bot, 50% hits |
|---|---|---|---|
| Easy | 8% | 83% | 100% |
| Normal | 14% | 57% | 68% |
| Hard | 0% | 31% | 31% |

On Normal the 30% bot averages 12 kills, 4 deaths, 12 fireteam kills and
1,760 RP, buying 7 upgrades; the 50% bot 17 kills, 2.5 deaths, 1,930 RP.
Decided matches run 9–11 minutes, the same coffee break as a skirmish.

How the edge was found: Normal ×1.12 → ×1.3 (no player 58% → 14%);
Easy ×1.1 → ×1.3 → ×1.6 (no player 63% → 67% → 8%); Hard ×1.4 (0% even at
50% accuracy) → ×1.1 (25%) → ×1.0 (58–67%: easier than Normal) → ×1.05.
Hard is that sensitive because Red's income is already 1.3×. Beyond 30%
accuracy the bot gains kills but not wins on Hard: there the fight is
decided by Red's economy, and a better soldier needs to take Uplinks and
hit harvesters, which the bot doesn't plan for.

## Ideas not built

- Taking over any squad in the fireteam when the soldier falls.
- Calling the commander's ⚡ calldowns as the soldier (a laser designator).
- Riding in a Condor drop with the fireteam.
- Online co-op: two soldiers on one side.
