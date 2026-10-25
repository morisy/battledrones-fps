import { BUILDINGS, UNITS } from "../sim/balance";
import {
  REINFORCEMENTS, UPGRADES, WEAPONS, WEAPON_IDS, level, maxGrenades, maxRockets, ownsWeapon, requestBlocker,
  upgradeBlocker, type FrontlineState, type TeamKind, type UpgradeId, type WeaponId
} from "../sim/modes/frontline";
import { Terrain, type Faction, type UnitKind, type World } from "../sim/types";
import type { FpsSettings } from "./settings";
import "./fps.css";

/**
 * Frontline's HUD, plain DOM over the 3D view: crosshair and hit markers,
 * health and requisition, the weapon and its ammo, the fireteam, a radar of
 * the whole battlefield, the kill feed, markers over the fireteam and the
 * Uplinks, and the screens (briefing, armory, respawn, pause, the end).
 */

export interface HudHooks {
  start(): void;
  resume(): void;
  menu(): void;
  again(): void;
  deploy(at: "hq" | "squad"): void;
  buy(id: UpgradeId): void;
  request(kind: TeamKind): void;
  closeArmory(): void;
  pause(): void;
  setting(key: keyof FpsSettings, value: number | boolean): void;
}

export interface Marker {
  x: number;
  y: number;
  label: string;
  cls: string;
}

const ICON: Partial<Record<UnitKind, string>> = { trooper: "🤖", "rocket-squad": "🚀", sniper: "🎯", mender: "🔧" };
const MODE_LABEL = { follow: "⚑ Following you", hold: "✋ Holding position", attack: "🎯 Attacking target" } as const;
const SIDE_CSS: Record<Faction, string> = { blue: "#4c9dff", red: "#ff6a5a", green: "#5fe07f", purple: "#b98cff" };

const TERRAIN_COL: Record<number, string> = {
  [Terrain.Ground]: "#5d6b4c", [Terrain.Rock]: "#3b3a3a", [Terrain.Scrap]: "#7a6a4a", [Terrain.Water]: "#244a6a",
  [Terrain.Road]: "#8a8070", [Terrain.Rough]: "#6a5e48", [Terrain.Forest]: "#2f4a2a", [Terrain.Crystal]: "#4a8a9a",
  [Terrain.Bridge]: "#9a8a6a", [Terrain.Shallows]: "#3f6a7a", [Terrain.Deep]: "#173650"
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export class FpsHud {
  readonly el: HTMLElement;
  private q = <T extends HTMLElement = HTMLElement>(s: string) => this.el.querySelector<T>(s)!;
  private last = new Map<string, string>();
  private markerEls: HTMLElement[] = [];
  private mapBase: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private armoryOpen = false;
  private hitT = 0;

  constructor(root: HTMLElement, private world: World, hooks: HudHooks, private touch: boolean) {
    const el = document.createElement("div");
    el.className = `fps-hud${touch ? " touch" : ""}`;
    el.innerHTML = `
      <div class="fps-vignette"></div>
      <div class="fps-hurt"></div>
      <div class="fps-scope" hidden></div>
      <div class="fps-markers"></div>
      <div class="fps-cross"><i></i><i></i><i></i><i></i></div>
      <div class="fps-hit"></div>
      <div class="fps-top">
        <div class="fps-side blue"><b>BLUE</b><span class="hq"><i></i></span><em class="army"></em></div>
        <div class="fps-clock">0:00</div>
        <div class="fps-side red"><em class="army"></em><span class="hq"><i></i></span><b>RED</b></div>
      </div>
      <canvas class="fps-radar" width="150" height="150"></canvas>
      <div class="fps-team"><div class="fps-mode"></div><div class="fps-members"></div><div class="fps-inbound"></div></div>
      <div class="fps-feed"></div>
      <div class="fps-prompt"></div>
      <div class="fps-vitals">
        <div class="fps-hp"><i></i><span></span></div>
        <div class="fps-rp"></div>
      </div>
      <div class="fps-weapon">
        <div class="fps-ammo"><b></b><span></span></div>
        <div class="fps-wname"></div>
        <div class="fps-slots"></div>
        <div class="fps-kit"></div>
      </div>
      <div class="fps-overlay fps-intro" hidden></div>
      <div class="fps-overlay fps-respawn" hidden></div>
      <div class="fps-overlay fps-pause" hidden></div>
      <div class="fps-overlay fps-end" hidden></div>
      <div class="fps-modal fps-armory" hidden></div>`;
    root.appendChild(el);
    this.el = el;
    const base = document.createElement("canvas");
    base.width = world.width;
    base.height = world.height;
    const bx = base.getContext("2d")!;
    for (let y = 0; y < world.height; y++)
      for (let x = 0; x < world.width; x++) {
        bx.fillStyle = TERRAIN_COL[world.terrain[y * world.width + x]!] ?? "#5d6b4c";
        bx.fillRect(x, y, 1, 1);
      }
    this.mapBase = base;
    this.mapCtx = this.q<HTMLCanvasElement>(".fps-radar").getContext("2d")!;
    // the overlays' buttons
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-do]");
      if (!b || (b as HTMLButtonElement).disabled) return;
      e.stopPropagation();
      const d = b.dataset.do!;
      if (d === "start") hooks.start();
      else if (d === "resume") hooks.resume();
      else if (d === "menu") hooks.menu();
      else if (d === "again") hooks.again();
      else if (d === "hq" || d === "squad") hooks.deploy(d);
      else if (d === "buy") hooks.buy(b.dataset.id as UpgradeId);
      else if (d === "req") hooks.request(b.dataset.id as TeamKind);
      else if (d === "close") hooks.closeArmory();
      else if (d === "toggle") {
        const k = b.dataset.k as "assist" | "autoFire" | "haptics";
        const on = !b.classList.contains("on");
        b.classList.toggle("on", on);
        b.querySelector("i")!.textContent = on ? "On" : "Off";
        hooks.setting(k, on);
      }
    });
    el.addEventListener("input", (e) => {
      const r = e.target as HTMLInputElement;
      if (r.dataset.k === "sens") {
        hooks.setting("sens", Number(r.value));
        r.nextElementSibling!.textContent = `${Number(r.value).toFixed(1)}×`;
      }
    });
  }

  private set(sel: string, html: string): void {
    if (this.last.get(sel) === html) return;
    this.last.set(sel, html);
    this.q(sel).innerHTML = html;
  }

  // ---------------------------------------------------------- per frame ---

  update(o: {
    s: FrontlineState;
    hp: number | null;
    weapon: WeaponId;
    reloading: number;
    ads: number;
    scoped: boolean;
    spread: number;
    /** The aim assist holds an enemy: the crosshair turns red. */
    onEnemy: boolean;
    secs: number;
    supply: boolean;
    prompt: string;
    army: Record<"blue" | "red", number>;
    hq: Record<"blue" | "red", number>;
    team: { kind: UnitKind; hp: number }[];
    dt: number;
  }): void {
    const { s } = o;
    // vitals
    const hp = o.hp ?? 0;
    const hpBar = this.q(".fps-hp i");
    hpBar.style.width = `${Math.round(hp * 100)}%`;
    hpBar.className = hp < 0.3 ? "low" : hp < 0.6 ? "mid" : "";
    const plating = level(s, "plating");
    this.set(".fps-hp span", `${Math.round(hp * 100)}${plating ? ` <em>${"▰".repeat(plating)}</em>` : ""}`);
    this.q(".fps-vignette").style.opacity = String(o.hp === null ? 0 : Math.max(0, (0.45 - hp) * 1.8));
    this.set(".fps-rp", `<b>${Math.floor(s.rp)}</b> RP${o.supply ? ` <span class="sup">⛽ supply</span>` : ""}`);
    // weapon
    const mag = s.mag[o.weapon];
    const reserve = o.weapon === "launcher" ? String(s.rockets) : "∞";
    this.set(".fps-ammo", o.reloading > 0 ? `<b class="rl">RELOADING</b>` : `<b class="${mag === 0 ? "empty" : ""}">${mag}</b><span>/ ${reserve}</span>`);
    this.set(".fps-wname", esc(WEAPONS[o.weapon].name));
    this.set(
      ".fps-slots",
      WEAPON_IDS.map((w, i) => `<span class="${w === o.weapon ? "on" : ""} ${ownsWeapon(s, w) ? "" : "locked"}">${i + 1}</span>`).join("")
    );
    this.set(".fps-kit", `💣 ${s.grenades}/${maxGrenades(s)}${maxRockets(s) ? ` · 🚀 ${s.rockets + s.mag.launcher}/${maxRockets(s)}` : ""}`);
    // crosshair: the gap follows the spread
    const gap = Math.round(6 + o.spread * 420 * (1 - o.ads * 0.6));
    const cross = this.q(".fps-cross");
    cross.style.setProperty("--gap", `${gap}px`);
    cross.hidden = o.scoped || o.hp === null;
    cross.classList.toggle("on", o.onEnemy);
    this.q(".fps-scope").hidden = !o.scoped;
    // match
    this.set(".fps-clock", clock(o.secs));
    for (const f of ["blue", "red"] as const) {
      this.q(`.fps-side.${f} .hq i`).style.width = `${Math.round(o.hq[f] * 100)}%`;
      this.set(`.fps-side.${f} .army`, `⚔ ${Math.round(o.army[f] / 100) / 10}k`);
    }
    // fireteam
    this.set(".fps-mode", MODE_LABEL[s.mode]);
    this.set(
      ".fps-members",
      o.team.length
        ? o.team.map((m) => `<div class="mem"><span>${ICON[m.kind] ?? "•"} ${esc(UNITS[m.kind].name.replace(" Squad", "").replace(" Team", ""))}</span><i style="width:${Math.round(m.hp * 100)}%"></i></div>`).join("")
        : `<div class="mem none">No fireteam: call one in (B)</div>`
    );
    const inb = s.inbound ? Math.max(0, (s.inbound.due - this.world.tick) / 10) : null;
    this.set(".fps-inbound", inb !== null && s.inbound ? `📡 ${esc(UNITS[s.inbound.kind].name)} inbound ${Math.ceil(inb)}s` : "");
    this.set(".fps-prompt", o.prompt);
    this.hitT = Math.max(0, this.hitT - o.dt);
    this.q(".fps-hit").style.opacity = String(Math.min(1, this.hitT * 6));
    if (this.armoryOpen) this.renderArmory(s);
  }

  hit(kill = false): void {
    this.hitT = kill ? 0.35 : 0.18;
    this.q(".fps-hit").classList.toggle("kill", kill);
  }

  /** Damage from `angle` (radians, 0 = straight ahead, clockwise). */
  hurt(angle: number, k: number): void {
    const el = this.q(".fps-hurt");
    el.style.setProperty("--a", `${angle}rad`);
    el.style.transition = "none";
    el.style.opacity = String(Math.min(1, 0.4 + k * 3));
    void el.offsetWidth;
    el.style.transition = "opacity 700ms ease-out";
    el.style.opacity = "0";
  }

  feed(html: string, tone: "good" | "bad" | "info" | "gold" = "info"): void {
    const box = this.q(".fps-feed");
    const line = document.createElement("div");
    line.className = `ln ${tone}`;
    line.innerHTML = html;
    box.prepend(line);
    while (box.children.length > 6) box.lastElementChild!.remove();
    setTimeout(() => line.classList.add("fade"), 3800);
    setTimeout(() => line.remove(), 4600);
  }

  markers(list: Marker[]): void {
    const box = this.q(".fps-markers");
    while (this.markerEls.length < list.length) {
      const m = document.createElement("div");
      box.appendChild(m);
      this.markerEls.push(m);
    }
    this.markerEls.forEach((m, i) => {
      const k = list[i];
      if (!k) {
        m.hidden = true;
        return;
      }
      m.hidden = false;
      if (m.className !== `mk ${k.cls}`) m.className = `mk ${k.cls}`;
      if (m.dataset.l !== k.label) {
        m.dataset.l = k.label;
        m.innerHTML = k.label;
      }
      m.style.transform = `translate(${k.x.toFixed(1)}px, ${k.y.toFixed(1)}px)`;
    });
  }

  /** The radar: the whole map north-up, everything blue knows of, and the player's view cone. */
  radar(o: {
    me: { x: number; y: number; yaw: number } | null;
    team: Set<number>;
    seen: (x: number, y: number) => boolean;
    side: Faction;
  }): void {
    const w = this.world;
    const c = this.mapCtx;
    const S = 150;
    const k = S / Math.max(w.width, w.height);
    c.clearRect(0, 0, S, S);
    c.globalAlpha = 0.85;
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mapBase, 0, 0, w.width * k, w.height * k);
    c.globalAlpha = 1;
    for (const l of w.objectives.uplinks) {
      c.fillStyle = l.owner ? SIDE_CSS[l.owner] : "#e8c66a";
      c.beginPath();
      c.arc(l.x * k, l.y * k, 4, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "#000a";
      c.stroke();
    }
    for (const b of w.buildings.values()) {
      if (b.faction !== o.side && !w.fog[o.side].known.has(b.id) && !o.seen(b.tx + 0.5, b.ty + 0.5)) continue;
      const size = BUILDINGS[b.kind].size;
      c.fillStyle = SIDE_CSS[b.faction];
      c.fillRect(b.tx * k, b.ty * k, size * k, size * k);
    }
    for (const u of w.units.values()) {
      if (u.avatar) continue;
      const mine = o.team.has(u.id);
      if (u.faction !== o.side && !o.seen(u.x, u.y)) continue;
      c.fillStyle = mine ? "#7ef29b" : SIDE_CSS[u.faction];
      const r = mine ? 2.6 : UNITS[u.kind].domain === "air" ? 1.6 : 2;
      c.fillRect(u.x * k - r, u.y * k - r, r * 2, r * 2);
    }
    if (o.me) {
      const { x, y, yaw } = o.me;
      c.fillStyle = "#ffffff22";
      c.beginPath();
      c.moveTo(x * k, y * k);
      c.arc(x * k, y * k, 26, yaw - Math.PI / 2 - 0.6, yaw - Math.PI / 2 + 0.6);
      c.fill();
      c.save();
      c.translate(x * k, y * k);
      c.rotate(yaw);
      c.fillStyle = "#fff";
      c.beginPath();
      c.moveTo(0, -5);
      c.lineTo(3.5, 4);
      c.lineTo(-3.5, 4);
      c.closePath();
      c.fill();
      c.restore();
    }
  }

  // ----------------------------------------------------------- screens ---

  intro(o: { map: string; enemy: string; difficulty: string }): void {
    const box = this.q(".fps-intro");
    const keys = this.touch
      ? `<li><b>Left thumb</b> move (push to the rim to sprint) · <b>right thumb</b> look</li>
         <li><b>🔥</b> fire (drag it to aim) · <b>◎</b> sights · <b>⟳</b> reload · <b>💣</b> grenade · <b>⇄</b> weapon · <b>⤒</b> jump</li>
         <li><b>⚑ ✋ 🎯</b> fireteam: follow · hold where you aim · attack what you aim at · <b>🛒</b> armory</li>`
      : `<li><b>WASD</b> move · <b>Shift</b> sprint · <b>Space</b> jump · <b>mouse</b> look · <b>left click</b> fire · <b>right click</b> sights</li>
         <li><b>R</b> reload · <b>G</b> grenade · <b>1 2 3</b>, wheel or <b>Q</b> weapons</li>
         <li>Fireteam: <b>F</b> follow me · <b>H</b> hold where I aim · <b>T</b> attack what I aim at</li>
         <li><b>B</b> armory and reinforcements · <b>Esc</b> pause</li>`;
    box.innerHTML = `<div class="fps-card">
      <h2>🎯 FRONTLINE</h2>
      <p class="fsub">${esc(o.map)} · enemy commander: ${esc(o.enemy)} (${esc(o.difficulty)})</p>
      <p>You are one combat robot in Blue's army. Your commander fights the war; you, and the fireteam at your back, are the edge it needs.
      The enemy out-earns your side, so <b>without you Blue loses</b>.</p>
      <ul class="tips">
        <li>Kills, damage, Uplink captures and supply crates earn <b>Requisition (RP)</b>.</li>
        <li>Spend it at a <b>supply point</b> (any Blue building, or an Uplink Blue holds) on guns and upgrades, or radio for <b>reinforcements</b> anywhere.</li>
        <li>Carbine for robots, rail for snipers, <b>rockets for tanks and bombers</b>. Woods halve the damage you take.</li>
        <li>Stand in an Uplink's ring to capture it: robots count double.</li>
      </ul>
      <ul class="keys">${keys}</ul>
      <button class="cta big" data-do="start">▶ Deploy</button>
      <button class="cta alt" data-do="menu">Menu</button>
    </div>`;
    box.hidden = false;
  }

  hideIntro(): void {
    this.q(".fps-intro").hidden = true;
  }

  respawn(o: { by: string | null; left: number; squad: string | null; rp: number } | null): void {
    const box = this.q(".fps-respawn");
    if (!o) {
      box.hidden = true;
      this.last.delete("respawn");
      return;
    }
    const ready = o.left <= 0;
    const html = `<div class="fps-card small">
      <h2 class="bad">DESTROYED</h2>
      <p class="fsub">${o.by ? `by an enemy ${esc(o.by)}` : "in action"}</p>
      <p class="big">${ready ? "Ready to deploy" : `Redeploy in ${Math.ceil(o.left)}`}</p>
      <div class="row">
        <button class="cta" data-do="hq" ${ready ? "" : "disabled"}>⌂ Deploy at HQ</button>
        <button class="cta" data-do="squad" ${ready && o.squad ? "" : "disabled"}>⚑ Deploy on ${o.squad ? esc(o.squad) : "fireteam"}</button>
      </div>
      <p class="fsub">${this.touch ? "Tap 🛒 to shop while you wait" : "B: shop while you wait · Space or Enter: deploy"} · ${Math.floor(o.rp)} RP</p>
    </div>`;
    if (this.last.get("respawn") !== html) {
      this.last.set("respawn", html);
      box.innerHTML = html;
    }
    box.hidden = false;
  }

  pause(on: boolean, set?: FpsSettings): void {
    const box = this.q(".fps-pause");
    box.hidden = !on;
    if (!on || !set) return;
    const toggle = (k: "assist" | "autoFire" | "haptics", label: string, note: string) =>
      `<button class="fps-opt${set[k] ? " on" : ""}" data-do="toggle" data-k="${k}"><b>${label}</b><span>${note}</span><i>${set[k] ? "On" : "Off"}</i></button>`;
    box.innerHTML = `<div class="fps-card small">
      <h2>PAUSED</h2>
      <div class="fps-opts">
        <label class="fps-opt"><b>Look sensitivity</b><input type="range" min="0.4" max="2.5" step="0.1" value="${set.sens}" data-k="sens" /><i>${set.sens.toFixed(1)}×</i></label>
        ${toggle("assist", "Aim assist", "The crosshair slows and settles on enemies")}
        ${toggle("autoFire", "Auto-fire", "Shoots while the crosshair is on an enemy (not rockets)")}
        ${this.touch ? toggle("haptics", "Vibration", "Buzz on hits taken and kills") : ""}
      </div>
      <button class="cta big" data-do="resume">▶ Resume</button>
      <button class="cta alt" data-do="menu">Quit to menu</button>
    </div>`;
  }

  end(o: { won: boolean | null; s: FrontlineState; secs: number }): void {
    const box = this.q(".fps-end");
    const st = o.s.stats;
    const acc = st.shots ? Math.round((100 * st.hits) / st.shots) : 0;
    const title = o.won === null ? "DRAW" : o.won ? "VICTORY" : "DEFEAT";
    box.innerHTML = `<div class="fps-card">
      <h2 class="${o.won ? "good" : "bad"}">${title}</h2>
      <p class="fsub">${o.won ? "Red's HQ is rubble. Your fireteam made the difference." : o.won === null ? "Neither side broke." : "Blue's HQ has fallen."} · ${clock(o.secs)}</p>
      <div class="stats">
        <div><b>${st.kills}</b><span>kills</span></div>
        <div><b>${st.squadKills}</b><span>fireteam kills</span></div>
        <div><b>${Math.round(st.damage)}</b><span>damage</span></div>
        <div><b>${st.deaths}</b><span>deaths</span></div>
        <div><b>${acc}%</b><span>accuracy</span></div>
        <div><b>${st.captures}</b><span>Uplinks taken</span></div>
        <div><b>${Math.round(o.s.rpEarned)}</b><span>RP earned</span></div>
        <div><b>${Object.values(o.s.upgrades).reduce((a, b) => a + (b ?? 0), 0)}</b><span>upgrades</span></div>
      </div>
      <button class="cta big" data-do="again">↻ Play again</button>
      <button class="cta alt" data-do="menu">Menu</button>
    </div>`;
    box.hidden = false;
  }

  get armoryShown(): boolean {
    return this.armoryOpen;
  }

  armory(on: boolean, s?: FrontlineState): void {
    this.armoryOpen = on;
    this.q(".fps-armory").hidden = !on;
    this.last.delete("armory");
    if (on && s) this.renderArmory(s);
  }

  private renderArmory(s: FrontlineState): void {
    const w = this.world;
    const group = (g: string, title: string) =>
      `<h3>${title}</h3>` +
      UPGRADES.filter((u) => u.group === g)
        .map((u) => {
          const lv = level(s, u.id);
          const why = upgradeBlocker(w, u.id);
          const owned = why === "Owned";
          const cost = owned ? "✓" : `${u.cost[lv]} RP`;
          const pips = u.cost.length > 1 ? `<em>${"●".repeat(lv)}${"○".repeat(u.cost.length - lv)}</em>` : "";
          return `<button class="up${owned ? " owned" : ""}" data-do="buy" data-id="${u.id}" ${why ? "disabled" : ""}>
            <b>${esc(u.name)} ${pips}</b><span>${esc(u.desc)}</span><i>${why && !owned ? esc(why) : cost}</i></button>`;
        })
        .join("");
    const req = (Object.keys(REINFORCEMENTS) as TeamKind[])
      .map((k) => {
        const why = requestBlocker(w, k);
        return `<button class="up" data-do="req" data-id="${k}" ${why ? "disabled" : ""}>
          <b>${ICON[k] ?? ""} ${esc(UNITS[k].name)}</b><span>${esc(REINFORCEMENTS[k].blurb)}</span><i>${why ? esc(why) : `${REINFORCEMENTS[k].cost} RP`}</i></button>`;
      })
      .join("");
    const html = `<div class="fps-card wide">
      <div class="hd"><h2>🛒 ARMORY</h2><b class="rp">${Math.floor(s.rp)} RP</b><button class="x" data-do="close">✕</button></div>
      <p class="fsub">${s.respawnAt !== null ? "Redeploying: shop anything." : "Upgrades at a supply point (any Blue building, or an Uplink Blue holds). Reinforcements anywhere."}</p>
      <div class="cols">
        <div>${group("carbine", "Pulse Carbine")}${group("rail", "Rail Rifle")}</div>
        <div>${group("launcher", "Rocket Launcher")}${group("kit", "Kit")}</div>
        <div><h3>Reinforcements</h3>${req}<p class="fsub">Your fireteam holds up to 4. Reinforcements land beside you.</p></div>
      </div>
    </div>`;
    if (this.last.get("armory") !== html) {
      this.last.set("armory", html);
      this.q(".fps-armory").innerHTML = html;
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
