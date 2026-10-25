// Frontline balance panel (FRONTLINE.md "Balance"): Frontline matches with the
// scripted player (tools/frontline-bot.ts) at several accuracies, and with no
// player at all, against each enemy difficulty.
//   npx vite-node tools/frontline.ts [--seeds N] [--maps a,b] [--difficulty normal] [--players none,idle,0.3,0.55]
// Prints blue's win rate per player setting, match length and the soldier's
// average stats (kills, deaths, RP earned, upgrades bought).
import type { Difficulty } from "../src/sim/ai/commander";
import { playFrontline, type FrontlineMatch } from "./frontline-bot";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const seeds = Number(arg("--seeds") ?? 6);
const maps = (arg("--maps") ?? "riverlands,dune-sea,frostbite,proving-grounds").split(",");
const difficulty = (arg("--difficulty") ?? "normal") as Difficulty;
const players = (arg("--players") ?? "none,idle,0.3,0.55").split(",").map((p) => (p === "none" || p === "idle" ? p : Number(p))) as FrontlineMatch["player"][];

for (const player of players) {
  const ms: FrontlineMatch[] = [];
  for (const map of maps) for (let s = 0; s < seeds; s++) ms.push(playFrontline(map, 9100 + s * 37 + map.length, player, difficulty));
  const won = ms.filter((m) => m.winner === "blue").length;
  const draws = ms.filter((m) => m.winner === "draw").length;
  const avg = (f: (m: FrontlineMatch) => number) => (ms.reduce((a, m) => a + f(m), 0) / ms.length).toFixed(1);
  const st = (k: keyof NonNullable<FrontlineMatch["stats"]>) => avg((m) => m.stats?.[k] ?? 0);
  console.log(
    `${String(player).padEnd(5)} vs ${difficulty}: blue wins ${won}/${ms.length} (${Math.round((100 * won) / ms.length)}%), draws ${draws}, ` +
      `length ${avg((m) => m.min)} min` +
      (player === "none" ? "" : ` | kills ${st("kills")} deaths ${st("deaths")} team kills ${st("squadKills")} RP ${avg((m) => m.rpEarned)} upgrades ${avg((m) => m.upgrades)} hit ${avg((m) => (m.stats?.shots ? (100 * m.stats.hits) / m.stats.shots : 0))}%`)
  );
}
