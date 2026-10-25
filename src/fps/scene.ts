import * as THREE from "three";
import { createAiState, DIFFICULTY, tickAi, type AiState, type Difficulty } from "../sim/ai/commander";
import { BUILDINGS, TICK_RATE, UNITS } from "../sim/balance";
import { isVisible, tickFog } from "../sim/fog";
import { concealedFrom } from "../sim/infantry";
import { createMapWorld, mapById } from "../sim/maps";
import {
  FRONTLINE, UPGRADES, WEAPONS, WEAPON_IDS, applyHandicap, atSupply, avatarBlast, avatarOf, avatarShot, buyUpgrade,
  filterAiCommands, isFoe, lookAvatar, moveAvatar, noteShot, ownsWeapon, requestSquad, respawn, setupFrontline,
  squadSpawn, teamOrder, teamUnits, terrainPace, weaponStats, type FrontlineEvent, type TeamKind, type UpgradeId, type WeaponId
} from "../sim/modes/frontline";
import { allowedOpener, applyOpener, pickAiOpener } from "../sim/openers";
import { step } from "../sim/sim";
import type { Faction, FxEvent, World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";
import { sfx } from "../game/audio";
import { gameMode } from "../game/mode";
import { music } from "../game/music";
import { BattleMood } from "../game/score";
import { EntityRenderer } from "../game/render/entities";
import { Fx } from "../game/render/fx";
import { WreckRenderer } from "../game/render/wrecks";
import { PowerRenderer } from "../game/render/powers";
import { ObjectiveRenderer } from "../game/render/objectives";
import { Stage } from "../game/three/stage";
import { Terrain3D, type TerrainArt } from "../game/three/terrain";
import { Particles, TEX, type EmitCfg } from "../game/three/particles";
import { GroundGfx } from "../game/three/ground-gfx";
import { Tweens } from "../game/three/tween";
import { AIR_H, type P3, type View } from "../game/three/view";
import { FpsHud, type Marker } from "./hud";
import { FpsInput } from "./input";
import { Shots, Viewmodel } from "./gun";
import { buzz, loadFpsSettings, saveFpsSettings, type FpsSettings } from "./settings";

/**
 * Frontline (FRONTLINE.md): the RTS battle seen and fought from inside one of
 * Blue's robots. Two AI commanders play the whole match as in AI vs AI (Blue
 * a Balanced commander on Normal, Red the menu's difficulty with the mode's
 * income edge); the player walks, aims and shoots their soldier by hand, and
 * leads a fireteam the commander leaves alone (sim/modes/frontline.ts).
 *
 * The same renderers as the RTS view draw the battlefield (units, wrecks,
 * Uplinks, calldowns, effects); this scene swaps the RTS camera for a
 * first-person one, adds a sky and haze for a view along the ground, and does
 * the player's aiming and ballistics in 3D: hitscan rounds and rockets tested
 * against the drawn units and buildings and the terrain, their hits handed to
 * the sim.
 */

const SIDE: Faction = "blue";
const FOE: Faction = "red";
const TICK_MS = 1000 / TICK_RATE;
/** Eye height above the ground (tiles; a robot stands about half a tile tall). */
const EYE = 0.4;
const FOV = 72;
/** Max pitch either way (radians). */
const PITCH_MAX = 1.35;
const GRAVITY = 7;
/** A jump: take-off speed and the pull back down (tiles/s, tiles/s²): a hop of about 0.4 tiles, most of a robot's height, 0.6 s in the air. */
const JUMP_SPEED = 2.8;
const JUMP_GRAVITY = 9.5;
/** Extra aim cone while airborne (radians): a shot from mid-jump goes wide. */
const AIR_SPREAD = 0.045;

/** Horizon haze and zenith per biome (sky dome, fog and the void past the map). */
const SKY: Record<World["biome"], { horizon: number; zenith: number; near: number; far: number }> = {
  temperate: { horizon: 0xbfd2e2, zenith: 0x4f86cf, near: 26, far: 90 },
  desert: { horizon: 0xe9d9bb, zenith: 0x6a9bd6, near: 28, far: 95 },
  arctic: { horizon: 0xd9e5ef, zenith: 0x7aa3d6, near: 22, far: 80 },
  volcanic: { horizon: 0x7a5248, zenith: 0x2a1f26, near: 18, far: 70 },
  tropical: { horizon: 0xcdeef9, zenith: 0x3d98e0, near: 28, far: 95 }
};

interface Hit {
  t: number;
  id: number | null;
  air: boolean;
  point: THREE.Vector3;
}

interface Rocket {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
}

interface Grenade {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fuse: number;
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Vector3();

export class FpsScene {
  readonly world: World;
  private stage: Stage;
  private view: View;
  private terrain: Terrain3D;
  private entities: EntityRenderer;
  private fx: Fx;
  private wrecks: WreckRenderer;
  private powerFx: PowerRenderer;
  private objFx: ObjectiveRenderer;
  private mood: BattleMood;
  private blueAi: AiState;
  private redAi: AiState;
  private hud: FpsHud;
  private input: FpsInput;
  private gun: Viewmodel;
  private shots: Shots;
  private cam: THREE.PerspectiveCamera;
  private sky: THREE.Mesh;
  private prev = new Map<number, { x: number; y: number }>();
  private acc = 0;
  private simSeconds = 0;
  private raf = 0;
  private lastFrame = 0;

  private started = false;
  private paused = false;
  private ended = false;
  private yaw = 0;
  private pitch = 0;
  private recoil = 0;
  private bob = 0;
  private stride = 0;
  private eyeH = 0;
  /** The jump: height above the ground, vertical speed, and the dip the view takes on landing. */
  private jumpH = 0;
  private jumpV = 0;
  private landDip = 0;
  private shake = 0;
  private weapon: WeaponId = "carbine";
  private lastWeapon: WeaponId = "carbine";
  private cooldown = 0;
  private reloading = 0;
  private reloadTotal = 1;
  private bloom = 0;
  private ads = 0;
  private nadeCd = 0;
  private rockets: Rocket[] = [];
  private grenades: Grenade[] = [];
  private lastHp = UNITS.trooper.hp;
  private deathAt: { x: number; y: number; by: string | null } | null = null;
  private uplinkNames = new Map<number, string>();
  private difficulty: Difficulty;
  private settings: FpsSettings;
  /** The enemy the aim assist is holding on (null: none near the crosshair). */
  private assistId: number | null = null;
  private lastBuzz = 0;

  constructor(parent: HTMLElement, dpr: number, art: TerrainArt | null) {
    document.getElementById("loading")?.remove();
    const seed = (Math.random() * 0x7fffffff) | 0;
    this.difficulty = gameMode.difficulty;
    const w = (this.world = createMapWorld(gameMode.mapId, { seed, objectives: true }));
    this.blueAi = createAiState("balanced", "normal", (seed + 2) | 0);
    this.redAi = createAiState(undefined, this.difficulty, (seed + 1) | 0);
    for (const [f, ai] of [[SIDE, this.blueAi], [FOE, this.redAi]] as const) {
      const o = allowedOpener(w, f, pickAiOpener(ai.strategy.name, seed, f));
      if (o) applyOpener(w, f, o);
    }
    const s = setupFrontline(w, { side: SIDE, enemyIncome: FRONTLINE.enemyIncome[this.difficulty] });
    this.yaw = s.yaw;
    tickFog(w);
    [...w.objectives.uplinks].sort((a, b) => a.id - b.id).forEach((l, i) => this.uplinkNames.set(l.id, String.fromCharCode(65 + i)));

    // ---- the 3D view, with a first-person camera
    this.stage = new Stage(parent, dpr);
    this.stage.setBiome(w.biome);
    const look = SKY[w.biome];
    this.stage.scene.background = new THREE.Color(look.horizon);
    this.stage.scene.fog = new THREE.Fog(look.horizon, look.near, look.far);
    this.cam = this.stage.rig.camera;
    this.cam.fov = FOV;
    this.cam.near = 0.02;
    // (nothing past the haze is seen: drawing the land out to the skirt's far rim costs a lot for nothing)
    this.cam.far = look.far + 10;
    this.cam.rotation.order = "YXZ";
    this.cam.updateProjectionMatrix();
    this.stage.scene.add(this.cam);
    this.sky = skyDome(look.horizon, look.zenith);
    this.stage.scene.add(this.sky);
    this.terrain = new Terrain3D(w, SIDE, art);
    this.stage.scene.add(this.terrain.group);
    const particles = new Particles();
    this.stage.scene.add(particles.group);
    const heightAt = (x: number, y: number) => this.terrain.surfaceAt(x, y);
    const rig = this.stage.rig;
    const ground = new GroundGfx(rig, heightAt, { fog: true });
    const over = new GroundGfx(rig, heightAt, { order: 9 });
    const top = new GroundGfx(rig, heightAt, { onTop: true });
    this.stage.scene.add(ground.mesh, over.mesh, top.mesh);
    this.view = { stage: this.stage, scene: this.stage.scene, rig, tweens: new Tweens(), particles, terrain: this.terrain, screen: this.stage.screen, ground, over, top, dpr };
    const v = this.view;
    const earshot = (x: number, y: number) => this.earshot(x, y);
    this.fx = new Fx(v, w.biome, earshot);
    this.entities = new EntityRenderer(
      v, w, this.fx,
      () => true,
      () => true,
      (f) => f === SIDE,
      // (no fog in first person: you see what's in front of you, except a Sniper Team hidden in the woods)
      (u) => !concealedFrom(w, SIDE, u)
    );
    this.wrecks = new WreckRenderer(v, w, this.fx, {
      visibleAt: () => true,
      pose: (id) => this.entities.pose(id),
      player: SIDE,
      spectator: false,
      hint: () => {}
    });
    this.powerFx = new PowerRenderer(v, w, this.fx, {
      player: SIDE,
      spectator: false,
      visibleAt: () => true,
      earshot,
      pos: (id) => this.entities.pos(id),
      isShown: (id) => this.entities.isShown(id),
      alert: (msg) => this.hud.feed(`⚠ ${msg}`, "bad"),
      ping: () => {}
    });
    this.objFx = new ObjectiveRenderer(v, w, this.fx, {
      player: SIDE,
      spectator: false,
      visibleAt: () => true,
      seesUnit: (u) => !concealedFrom(w, SIDE, u),
      earshot,
      alert: (msg) => this.hud.feed(`⚠ ${msg}`, "bad"),
      notify: (msg, tone) => this.hud.feed(msg, tone ?? "info"),
      ping: () => {},
      hint: () => {}
    });
    this.mood = new BattleMood({
      player: SIDE, spectator: false, earshot, sees: () => true,
      factionOf: (id) => (w.units.get(id) ?? w.buildings.get(id))?.faction ?? null
    });
    this.shots = new Shots(this.stage.scene);
    this.gun = new Viewmodel(this.cam);

    const hudRoot = document.getElementById("hud")!;
    this.input = new FpsInput(this.stage.canvas, hudRoot);
    this.settings = loadFpsSettings(this.input.touch);
    this.input.sens = this.settings.sens;
    this.hud = new FpsHud(hudRoot, w, {
      start: () => this.start(),
      resume: () => this.resume(),
      menu: () => location.reload(),
      again: () => {
        try {
          sessionStorage.setItem("battledrones.rematch", "1");
        } catch {
          /* ignore */
        }
        location.reload();
      },
      deploy: (at) => this.deploy(at),
      buy: (id) => this.buy(id),
      request: (k) => this.request(k),
      closeArmory: () => this.armory(false),
      pause: () => this.pause(true),
      setting: (k, v) => {
        (this.settings as unknown as Record<string, unknown>)[k] = v;
        this.input.sens = this.settings.sens;
        saveFpsSettings(this.settings);
      }
    }, this.input.touch);
    this.hud.intro({
      map: mapById(gameMode.mapId).name,
      enemy: this.redAi.strategy.label,
      difficulty: DIFFICULTY[this.difficulty].label
    });
    this.stage.canvas.addEventListener("click", () => {
      if (this.started && !this.paused && !this.ended && !this.hud.armoryShown && avatarOf(w)) this.input.lock();
    });
    document.addEventListener("pointerlockchange", this.onLockChange);

    // debug/testing handle (harmless in production), as the RTS scene's window.__bd
    (window as unknown as Record<string, unknown>).__fps = { world: w, scene: this, input: this.input, THREE };

    music.play("battle", w.biome);
    this.placeCamera(0);
    this.stage.shadowFocus = { x: this.cam.position.x, y: this.cam.position.z, half: 14 };
    this.stage.precompile();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  resize(): void {
    this.stage.resize();
  }

  /** Testing: run `n` frames of `ms` each without waiting in real time (tools/fps-smoke.mjs). */
  advance(ms: number, n = 1): void {
    for (let i = 0; i < n; i++) this.update(ms / 1000);
  }

  /** Testing: the look direction (yaw, pitch in radians). */
  aim(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  // --------------------------------------------------------------- flow ---

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.hud.hideIntro();
    sfx.unlock();
    sfx.play("squad", 0.6);
    this.input.lock();
    this.hud.feed("Deployed. Fireteam: <em>follow me</em>", "good");
    if (this.input.touch) {
      // phones play sideways: ask for landscape (Android, in full screen), and say so where it can't be forced
      try {
        const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        o.lock?.("landscape").catch(() => {});
      } catch {
        /* no orientation lock */
      }
      if (this.stage.rig.height > this.stage.rig.width) this.hud.feed("↻ Turn your phone sideways for a wider view", "gold");
    }
  }

  private onLockChange = (): void => {
    const locked = document.pointerLockElement === this.stage.canvas;
    // Esc (or the browser) took the mouse back mid-fight: pause
    if (!locked && this.started && !this.ended && !this.paused && !this.hud.armoryShown && avatarOf(this.world) && !this.input.touch) this.pause(true);
  };

  private pause(on: boolean): void {
    if (on && (!this.started || this.ended)) return;
    this.paused = on;
    this.hud.pause(on, this.settings);
    if (on) this.input.unlock();
  }

  private resume(): void {
    this.pause(false);
    this.input.lock();
  }

  private armory(on: boolean): void {
    if (on === this.hud.armoryShown) return;
    this.hud.armory(on, this.world.frontline!);
    this.input.enabled = !on;
    if (on) this.input.unlock();
    else if (avatarOf(this.world) && !this.ended) this.input.lock();
    sfx.play("click", 0.5);
  }

  private buy(id: UpgradeId): void {
    const why = buyUpgrade(this.world, id);
    if (why) {
      sfx.play("deny", 0.6);
      return;
    }
    sfx.play("coin", 0.7);
    if (id === "rail" || id === "launcher") this.equip(id);
    this.hud.feed(`Armory: <em>${UPGRADES.find((u) => u.id === id)!.name}</em>`, "gold");
  }

  private request(kind: TeamKind): void {
    const why = requestSquad(this.world, kind);
    if (why) {
      sfx.play("deny", 0.6);
      this.hud.feed(why, "bad");
      return;
    }
    sfx.play("inbound", 0.7);
    this.hud.feed(`📡 ${UNITS[kind].name} requested: inbound ${FRONTLINE.inbound}s`, "gold");
  }

  private deploy(at: "hq" | "squad"): void {
    if (!respawn(this.world, at) && !(at === "squad" && respawn(this.world, "hq"))) return;
    const a = avatarOf(this.world)!;
    this.lastHp = a.hp;
    this.deathAt = null;
    this.jumpH = this.jumpV = this.landDip = 0;
    this.hud.respawn(null);
    this.armory(false);
    this.reloading = 0;
    this.input.lock();
    sfx.play("pod", 0.6);
  }

  // ---------------------------------------------------------- the frame ---

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const raw = now - this.lastFrame;
    this.lastFrame = now;
    if (raw < 1000) this.stage.adapt(raw);
    this.update(Math.min(100, Math.max(1, raw)) / 1000);
  };

  private update(dt: number): void {
    const w = this.world;
    const s = w.frontline!;
    const inp = this.input.poll();
    const running = this.started && !this.paused && !this.ended;
    // (Esc also ends the pointer lock, which pauses on its own: Esc only ever pauses, Resume resumes)
    if (inp.actions.has("pause") && this.started && !this.ended) {
      if (this.hud.armoryShown) this.armory(false);
      else if (!this.paused) this.pause(true);
    }
    if (running) {
      if (inp.actions.has("armory")) this.armory(!this.hud.armoryShown);
      const a = avatarOf(w);
      if (a) this.play(dt, inp);
      else if (inp.actions.has("deploy") || inp.actions.has("jump")) this.deploy(squadSpawn(w) ? "squad" : "hq");
      // the sim, at 10 Hz
      this.acc += dt * 1000;
      let n = 0;
      while (this.acc >= TICK_MS && n++ < 4 && !w.winner) {
        this.acc -= TICK_MS;
        this.tick();
      }
      if (this.acc > TICK_MS * 4) this.acc = 0;
    }
    this.updateProjectiles(running ? dt : 0);
    this.drainFeed(s.feed.splice(0));
    if (!avatarOf(w) && this.started && !this.ended) this.showRespawn();
    if (w.winner && !this.ended) this.finish();
    this.render(dt, running);
  }

  /** One sim tick: both commanders (the fireteam and the soldier kept from Blue's), the handicap, the step. */
  private tick(): void {
    const w = this.world;
    this.prev.clear();
    for (const u of w.units.values()) this.prev.set(u.id, { x: u.x, y: u.y });
    for (const p of w.projectiles) this.prev.set(p.id, { x: p.x, y: p.y });
    const blue = filterAiCommands(w, tickAi(w, SIDE, this.blueAi));
    const red = tickAi(w, FOE, this.redAi);
    applyHandicap(w);
    step(w, [...blue, ...red]);
    this.simSeconds += 1 / TICK_RATE;
    for (const ev of w.fx) {
      this.onFx(ev);
      this.wrecks.onFx(ev);
      this.entities.onFx(ev);
      this.powerFx.onFx(ev);
      this.objFx.onFx(ev);
    }
    this.mood.events(w.fx, this.simSeconds);
  }

  /** The player's controls for one frame: look, walk, shoot, orders. */
  private play(dt: number, inp: ReturnType<FpsInput["poll"]>): void {
    const w = this.world;
    const s = w.frontline!;
    const a = avatarOf(w)!;
    const zoom = 1 + (weaponStats(s, this.weapon).zoom - 1) * this.ads;
    // aim assist (touch by default): the crosshair slows over an enemy and drifts onto it
    const held = this.settings.assist ? this.assist(dt) : false;
    const friction = held ? 0.55 : 1;
    this.yaw += (inp.lookX * friction) / zoom;
    this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch - (inp.lookY * friction) / zoom));
    lookAvatar(w, this.yaw, this.pitch);

    // walk (no sprinting while aiming or shooting)
    const sprint = inp.sprint && inp.move.y > 0.3 && !inp.fire && this.ads < 0.3;
    const fx = Math.sin(this.yaw);
    const fy = -Math.cos(this.yaw);
    const mx = fx * inp.move.y - fy * inp.move.x;
    const my = fy * inp.move.y + fx * inp.move.x;
    const slow = 1 - this.ads * 0.45;
    const moving = Math.hypot(inp.move.x, inp.move.y) > 0.05 && moveAvatar(w, mx * slow, my * slow, dt, sprint);
    const pace = moving ? Math.hypot(inp.move.x, inp.move.y) * terrainPace(w, a.x, a.y) * (sprint ? FRONTLINE.sprint : 1) * slow : 0;
    this.stride += (pace - this.stride) * Math.min(1, dt * 8);
    // (no stride bob in the air)
    if (this.jumpH <= 0) this.bob += dt * 9.5 * this.stride;

    // jump: a hop straight up, from the ground only (a sprinting take-off goes a little higher)
    if (inp.actions.has("jump") && this.jumpH <= 0 && this.jumpV <= 0) {
      this.jumpV = JUMP_SPEED * (sprint ? 1.08 : 1);
      this.jumpH = 1e-4;
      sfx.play("thrust", 0.25);
    }
    if (this.jumpH > 0) {
      this.jumpV -= JUMP_GRAVITY * dt;
      this.jumpH += this.jumpV * dt;
      if (this.jumpH <= 0) {
        // landed: the view dips, dust kicks up
        const hard = Math.min(1, -this.jumpV / JUMP_SPEED);
        this.jumpH = 0;
        this.jumpV = 0;
        this.landDip = 0.035 * hard;
        sfx.play("stomp", 0.18 * hard);
        this.fx.dust(a.x, a.y, 2);
      }
    }

    // weapons
    const pick = (id: WeaponId) => ownsWeapon(s, id) && this.equip(id);
    if (inp.actions.has("weapon1")) pick("carbine");
    if (inp.actions.has("weapon2")) pick("rail");
    if (inp.actions.has("weapon3")) pick("launcher");
    if (inp.actions.has("lastWeapon")) pick(this.lastWeapon);
    if (inp.actions.has("nextWeapon") || inp.actions.has("prevWeapon")) {
      const owned = WEAPON_IDS.filter((id) => ownsWeapon(s, id));
      const i = owned.indexOf(this.weapon);
      const k = inp.actions.has("nextWeapon") ? 1 : -1;
      this.equip(owned[(i + k + owned.length) % owned.length]!);
    }
    this.ads += ((inp.ads && this.reloading <= 0 && !sprint ? 1 : 0) - this.ads) * Math.min(1, dt * 12);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.nadeCd = Math.max(0, this.nadeCd - dt);
    this.bloom = Math.max(0, this.bloom - dt * 0.12);
    this.recoil = Math.max(0, this.recoil - dt * this.recoil * 7 - dt * 0.01);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.finishReload();
    }
    const st = weaponStats(s, this.weapon);
    if (inp.actions.has("reload")) this.startReload();
    // auto-fire: the trigger pulls itself while the crosshair is on an enemy in range (not with rockets: they're precious)
    const auto = this.settings.autoFire && this.weapon !== "launcher" && this.onTarget(st.range);
    if ((inp.fire || auto) && !sprint && this.reloading <= 0 && this.cooldown <= 0) {
      if (s.mag[this.weapon] > 0) this.fire(st, moving);
      else this.startReload();
    } else if (!inp.fire && this.settings.autoFire && s.mag[this.weapon] === 0 && this.reloading <= 0 && this.weapon !== "launcher") {
      this.startReload();
    }
    if (inp.actions.has("grenade")) this.throwGrenade();

    // fireteam orders
    if (inp.actions.has("follow")) {
      teamOrder(w, "follow");
      this.hud.feed("Fireteam: <em>follow me</em>", "good");
      sfx.play("squad", 0.5);
    }
    if (inp.actions.has("hold")) {
      const hit = this.aimRay(30, true);
      const p = hit ? { x: hit.point.x, y: hit.point.z } : { x: a.x, y: a.y };
      teamOrder(w, "hold", p);
      this.fx.marker(p.x, p.y, 0xffe066);
      this.hud.feed("Fireteam: <em>hold there</em>", "good");
      sfx.play("squad", 0.5);
    }
    if (inp.actions.has("attack")) {
      const hit = this.aimRay(30, false);
      if (hit?.id !== null && hit && isFoe(w, hit.id) && teamOrder(w, "attack", null, hit.id)) {
        this.hud.feed(`Fireteam: <em>attack that ${(w.units.get(hit.id) ? UNITS[w.units.get(hit.id)!.kind] : BUILDINGS[w.buildings.get(hit.id)!.kind]).name}</em>`, "good");
        this.fx.marker(hit.point.x, hit.point.z, 0xff5a4a);
        sfx.play("squad", 0.5);
      } else {
        this.hud.feed("No target under the crosshair", "bad");
        sfx.play("deny", 0.4);
      }
    }

    // damage taken: a red flash toward whoever did it
    if (a.hp < this.lastHp - 0.5) {
      const src = a.lastAttackerId !== null ? w.units.get(a.lastAttackerId) ?? w.buildings.get(a.lastAttackerId) : null;
      const at = src ? ("tx" in src ? buildingCenter(src) : src) : null;
      const ang = at ? Math.atan2(at.x - a.x, -(at.y - a.y)) - this.yaw : Math.PI;
      this.hud.hurt(ang, (this.lastHp - a.hp) / UNITS.trooper.hp);
      const now = performance.now();
      if (now - this.lastBuzz > 350) {
        this.lastBuzz = now;
        buzz(this.settings, Math.min(60, 15 + (this.lastHp - a.hp) * 2));
      }
      this.shake = Math.min(1, this.shake + (this.lastHp - a.hp) / 60);
    }
    this.lastHp = a.hp;
  }

  /**
   * Aim assist: the enemy nearest the crosshair within a small cone (wider up
   * close), in range and in sight. The view drifts onto it, a little faster
   * the further off it is; returns whether one is held (the look then slows).
   */
  private assist(dt: number): boolean {
    const w = this.world;
    const c = this.cam.position;
    const range = weaponStats(w.frontline!, this.weapon).range;
    let best: { id: number; yaw: number; pitch: number; err: number } | null = null;
    for (const u of w.units.values()) {
      if (u.faction === SIDE || u.hp <= 0 || concealedFrom(w, SIDE, u)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const dx = p.x - c.x;
      const dz = p.y - c.z;
      const flat = Math.hypot(dx, dz);
      if (flat > range || flat < 0.3) continue;
      const yaw = Math.atan2(dx, -dz);
      const pitch = Math.atan2((p.h + p.top) / 2 - c.y, flat);
      let dy = yaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const err = Math.hypot(dy, pitch - this.pitch);
      const cone = Math.min(0.2, 0.06 + 0.5 / flat);
      if (err > cone || (best && err >= best.err)) continue;
      best = { id: u.id, yaw: this.yaw + dy, pitch, err };
    }
    if (best) {
      // in sight? (not through a hill)
      _d.set(Math.sin(best.yaw) * Math.cos(best.pitch), Math.sin(best.pitch), -Math.cos(best.yaw) * Math.cos(best.pitch));
      const ground = this.raycast(c, _d, range, true);
      const u = w.units.get(best.id)!;
      if (ground && ground.t < Math.hypot(u.x - c.x, u.y - c.z) - 0.4) best = null;
    }
    this.assistId = best?.id ?? null;
    if (!best) return false;
    const k = Math.min(1, dt * (2.5 + best.err * 20));
    let dy = best.yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * k * 0.5;
    this.pitch += (best.pitch - this.pitch) * k * 0.5;
    return true;
  }

  /** Is the crosshair (no spread) on an enemy within `range`? */
  private onTarget(range: number): boolean {
    const hit = this.aimRay(range, false);
    return !!hit && hit.id !== null && isFoe(this.world, hit.id) && !!this.world.units.get(hit.id);
  }

  private equip(id: WeaponId): boolean {
    if (id === this.weapon) return false;
    this.lastWeapon = this.weapon;
    this.weapon = id;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.35);
    this.gun.set(id);
    sfx.play("clank", 0.35);
    return true;
  }

  private startReload(): void {
    const s = this.world.frontline!;
    const st = weaponStats(s, this.weapon);
    if (this.reloading > 0 || s.mag[this.weapon] >= st.mag) return;
    if (this.weapon === "launcher" && s.rockets <= 0) {
      this.hud.feed("Out of rockets: resupply at a supply point", "bad");
      sfx.play("deny", 0.4);
      return;
    }
    this.reloading = this.reloadTotal = st.reload;
    sfx.play("clank", 0.4);
  }

  private finishReload(): void {
    const s = this.world.frontline!;
    this.reloading = 0;
    if (this.weapon === "launcher") {
      if (s.rockets > 0 && s.mag.launcher === 0) {
        s.rockets--;
        s.mag.launcher = 1;
      }
    } else s.mag[this.weapon] = weaponStats(s, this.weapon).mag;
  }

  /** Current aim cone (radians): moving or settled, bloom from sustained fire, tighter down the sights. */
  private spread(moving: boolean): number {
    const st = WEAPONS[this.weapon];
    const base = moving ? st.spread : st.settledSpread + (st.spread - st.settledSpread) * 0.25;
    return (base + this.bloom + (this.jumpH > 0 ? AIR_SPREAD : 0)) * (1 - this.ads * 0.7);
  }

  private fire(st: ReturnType<typeof weaponStats>, moving: boolean): void {
    const w = this.world;
    const s = w.frontline!;
    s.mag[this.weapon]--;
    this.cooldown = st.interval;
    const cone = this.spread(moving);
    if (this.weapon === "carbine") this.bloom = Math.min(0.03, this.bloom + 0.0025);
    this.recoil += st.kick * (1 - this.ads * 0.5);
    this.gun.fired(this.weapon === "carbine" ? 0.5 : 1.2);
    const dir = this.aimDir(_d, cone);
    const eye = this.cam.position;
    const muzzle = this.gun.muzzle(_m);
    sfx.play(this.weapon === "carbine" ? "rifle" : this.weapon === "rail" ? "snipe" : "rocket", this.weapon === "carbine" ? 0.3 : 0.6);
    if (this.weapon === "launcher") {
      noteShot(w, false);
      const mesh = this.shots.rocket();
      const pos = muzzle.clone();
      mesh.position.copy(pos);
      this.rockets.push({ mesh, pos, vel: dir.clone().multiplyScalar(st.speed!), life: st.range / st.speed!, damage: st.damage });
      this.fx.emit(ROCKET_SMOKE, { x: pos.x, y: pos.z, h: pos.y }, 4);
      return;
    }
    const hit = this.raycast(eye, dir, st.range, false);
    const end = hit ? hit.point : _v.copy(eye).addScaledVector(dir, st.range);
    this.shots.tracer(muzzle, end, this.weapon === "rail");
    let dealt = 0;
    if (hit?.id !== null && hit) {
      const target = w.units.get(hit.id) ?? w.buildings.get(hit.id);
      dealt = avatarShot(w, hit.id, this.weapon, hit.t);
      if (dealt > 0) {
        this.hud.hit((target?.hp ?? 1) <= 0);
        this.fx.sparks({ x: hit.point.x, y: hit.point.z, h: hit.point.y }, this.weapon === "rail" ? 8 : 3, this.weapon === "rail" ? [0x7fe6ff, 0xffffff] : undefined);
      }
    } else if (hit) this.fx.dust(hit.point.x, hit.point.z, 1);
    noteShot(w, dealt > 0);
  }

  private throwGrenade(): void {
    const s = this.world.frontline!;
    if (s.grenades <= 0 || this.nadeCd > 0) {
      if (s.grenades <= 0) sfx.play("deny", 0.4);
      return;
    }
    s.grenades--;
    this.nadeCd = 0.8;
    const dir = this.aimDir(_d, 0);
    const pos = this.cam.position.clone().addScaledVector(dir, 0.1);
    const vel = dir.clone().multiplyScalar(FRONTLINE.grenade.throwSpeed);
    vel.y += 2;
    this.grenades.push({ mesh: this.shots.grenade(), pos, vel, fuse: FRONTLINE.grenade.fuse });
    this.gun.fired(0.6);
    sfx.play("clank", 0.5);
    noteShot(this.world, false);
  }

  private updateProjectiles(dt: number): void {
    if (dt <= 0) return;
    const w = this.world;
    this.rockets = this.rockets.filter((r) => {
      const step = r.vel.length() * dt;
      _d.copy(r.vel).normalize();
      const hit = this.raycast(r.pos, _d, step, false);
      r.life -= dt;
      if (hit || r.life <= 0) {
        const p = hit ? hit.point : r.pos;
        const ground = this.terrain.surfaceAt(p.x, p.z);
        const air = hit ? hit.air : p.y - ground > 0.6;
        const st = weaponStats(w.frontline!, "launcher");
        const dealt = avatarBlast(w, p.x, p.z, r.damage, st.splash!, st.dmgType, { air, airMult: st.airMult });
        if (dealt > 0) this.hud.hit(false);
        this.blast(p, st.splash!, air);
        this.shots.remove(r.mesh);
        return false;
      }
      r.pos.addScaledVector(r.vel, dt);
      r.mesh.position.copy(r.pos);
      r.mesh.lookAt(_v.copy(r.pos).add(r.vel));
      if (Math.random() < 0.7) this.fx.emit(ROCKET_SMOKE, { x: r.pos.x, y: r.pos.z, h: r.pos.y }, 1);
      return true;
    });
    this.grenades = this.grenades.filter((g) => {
      g.vel.y -= GRAVITY * dt;
      g.pos.addScaledVector(g.vel, dt);
      const ground = this.terrain.surfaceAt(g.pos.x, g.pos.z) + 0.014;
      if (g.pos.y < ground) {
        g.pos.y = ground;
        g.vel.y = Math.abs(g.vel.y) * 0.3;
        g.vel.x *= 0.5;
        g.vel.z *= 0.5;
      }
      g.mesh.position.copy(g.pos);
      g.fuse -= dt;
      if (g.fuse > 0) return true;
      const G = FRONTLINE.grenade;
      const dealt = avatarBlast(w, g.pos.x, g.pos.z, G.damage, G.splash, "explosive");
      if (dealt > 0) this.hud.hit(false);
      this.blast(g.pos, G.splash, false);
      this.shots.remove(g.mesh);
      return false;
    });
  }

  private blast(p: THREE.Vector3, size: number, air: boolean): void {
    this.fx.explosion({ type: "explosion", x: p.x, y: p.z, size, air, kind: "impact" }, { x: p.x, y: p.z, h: p.y });
    this.fx.sound("explosion", p.x, p.z, 0.9);
    const a = avatarOf(this.world);
    if (a) this.shake = Math.min(1, this.shake + Math.max(0, 0.5 - Math.hypot(a.x - p.x, a.y - p.z) / 8));
  }

  /** The look direction, jittered within a cone of `cone` radians, recoil included. */
  private aimDir(out: THREE.Vector3, cone: number): THREE.Vector3 {
    const r = cone * Math.sqrt(Math.random());
    const t = Math.random() * Math.PI * 2;
    const e = new THREE.Euler(this.pitch + this.recoil + Math.sin(t) * r, -this.yaw + Math.cos(t) * r, 0, "YXZ");
    return out.set(0, 0, -1).applyEuler(e);
  }

  private aimRay(max: number, groundOnly: boolean): Hit | null {
    return this.raycast(this.cam.position, this.aimDir(_d, 0), max, groundOnly);
  }

  /**
   * The first thing along a ray: the terrain, an enemy unit (a vertical
   * cylinder round where it is drawn), or a building of either side (its
   * footprint box). Friendly units don't stop a round (no friendly fire).
   */
  private raycast(o: THREE.Vector3, d: THREE.Vector3, max: number, groundOnly: boolean): Hit | null {
    const w = this.world;
    let best: Hit | null = null;
    // terrain: march, then refine
    const STEP = 0.12;
    for (let t = 0.05; t <= max + STEP; t += STEP) {
      const tt = Math.min(t, max);
      const x = o.x + d.x * tt;
      const z = o.z + d.z * tt;
      const y = o.y + d.y * tt;
      if (y < this.terrain.surfaceAt(x, z)) {
        let lo = Math.max(0, tt - STEP);
        let hi = tt;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          if (o.y + d.y * mid < this.terrain.surfaceAt(o.x + d.x * mid, o.z + d.z * mid)) hi = mid;
          else lo = mid;
        }
        best = { t: hi, id: null, air: false, point: new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi) };
        break;
      }
      if (tt >= max) break;
    }
    if (groundOnly) return best;
    const limit = () => (best ? best.t : max);
    for (const u of w.units.values()) {
      if (u.faction === SIDE || u.hp <= 0 || concealedFrom(w, SIDE, u)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const air = UNITS[u.kind].domain === "air";
      const r = UNITS[u.kind].radius * (air ? 1.05 : 0.9);
      const lo = air ? p.h - 0.12 : p.h - 0.02;
      const hi = Math.max(p.top, lo + 0.25) + 0.02;
      const t = rayCylinder(o, d, p.x, p.y, r, lo, hi, limit());
      if (t !== null) best = { t, id: u.id, air, point: new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t) };
    }
    for (const b of w.buildings.values()) {
      const p = this.entities.pos(b.id);
      const size = BUILDINGS[b.kind].size;
      const base = this.terrain.surfaceAt(b.tx + size / 2, b.ty + size / 2) - 0.1;
      const topH = p ? p.top : base + 0.8;
      const t = rayBox(o, d, b.tx + 0.08, base, b.ty + 0.08, b.tx + size - 0.08, topH, b.ty + size - 0.08, limit());
      if (t !== null)
        best = { t, id: b.faction === SIDE ? null : b.id, air: false, point: new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t) };
    }
    return best;
  }

  // ------------------------------------------------------------- events ---

  private onFx(ev: FxEvent): void {
    const w = this.world;
    switch (ev.type) {
      case "shot": {
        const src = w.units.get(ev.sourceId) ?? w.buildings.get(ev.sourceId);
        const faction = src?.faction ?? FOE;
        this.entities.fired(ev.sourceId, Math.atan2(ev.tx - ev.x, -(ev.ty - ev.y)), ev.fx);
        const from = this.entities.muzzle(ev.sourceId, ev.fx) ?? this.at(ev.x, ev.y, ev.fromAir);
        const a = avatarOf(w);
        // a round at the soldier zips past the camera
        const atMe = a && Math.abs(ev.tx - a.x) < 0.05 && Math.abs(ev.ty - a.y) < 0.05;
        const jitter = () => (Math.random() - 0.5) * (atMe ? 0.5 : 0.22);
        const to = atMe
          ? { x: this.cam.position.x + jitter(), y: this.cam.position.z + jitter(), h: this.cam.position.y + (Math.random() - 0.5) * 0.15 }
          : this.at(ev.tx + jitter(), ev.ty + jitter(), ev.air, 0.22);
        this.fx.shot(ev, from, to, faction);
        break;
      }
      case "explosion":
        this.fx.explosion(ev, this.at(ev.x, ev.y, ev.air, ev.kind === "building" ? 0.4 : 0.2));
        if (ev.kind !== "impact") {
          const a = avatarOf(w);
          if (a) this.shake = Math.min(1, this.shake + Math.max(0, ev.size * 0.25 - Math.hypot(a.x - ev.x, a.y - ev.y) / 12));
        }
        break;
      case "heal": {
        const from = this.entities.pos(ev.sourceId);
        const to = this.entities.pos(ev.targetId);
        if (from && to) this.fx.heal({ x: from.x, y: from.y, h: from.h - 0.05 }, { x: to.x, y: to.y, h: (to.h + to.top) / 2 });
        break;
      }
      case "death":
        if (ev.id === w.frontline?.avatarId) {
          this.deathAt = { x: ev.x, y: ev.y, by: ev.killerKind ? UNITS[ev.killerKind].name : null };
          this.reloading = 0;
          this.ads = 0;
          this.input.unlock();
          this.armory(false);
          sfx.play("lost", 0.8);
        }
        break;
      case "uplinkFlip":
        if (ev.owner === SIDE) this.hud.feed(`📡 Uplink ${this.uplinkNames.get(ev.id) ?? ""} taken`, "good");
        else if (ev.prev === SIDE) this.hud.feed(`📡 Uplink ${this.uplinkNames.get(ev.id) ?? ""} lost`, "bad");
        break;
      case "calldown":
        if (ev.faction !== SIDE) {
          const a = avatarOf(w);
          if (a && Math.hypot(a.x - ev.x, a.y - ev.y) < ev.radius + 4) this.hud.feed("⚠ Incoming strike: <em>get clear of the circle</em>", "bad");
        }
        break;
      default:
        break;
    }
  }

  private drainFeed(evs: FrontlineEvent[]): void {
    for (const e of evs)
      switch (e.type) {
        case "kill":
          this.hud.feed(`✖ ${e.name} <em>+${e.rp} RP</em>`, "good");
          buzz(this.settings, [12, 40, 12]);
          sfx.play("kill", 0.5);
          break;
        case "teamKill":
          this.hud.feed(`⚑ Fireteam got a ${e.name} <em>+${e.rp}</em>`, "info");
          break;
        case "rp":
          this.hud.feed(`${e.why} <em>+${e.amount} RP</em>`, "gold");
          break;
        case "captured":
          sfx.play("capture", 0.7);
          break;
        case "crate":
          sfx.play("crate", 0.7);
          this.hud.feed("📦 Ammo refilled", "gold");
          break;
        case "reinforced":
          this.hud.feed(`📡 ${UNITS[e.kind].name} joined the fireteam`, "good");
          sfx.play("drop", 0.7);
          break;
        case "teamLost":
          this.hud.feed(`⚑ Lost a ${UNITS[e.kind].name}`, "bad");
          break;
        case "respawned":
          this.hud.feed(e.at === "squad" ? "Deployed with the fireteam" : "Deployed at HQ", "info");
          break;
        case "died":
          break;
      }
  }

  private showRespawn(): void {
    const s = this.world.frontline!;
    const left = s.respawnAt === null ? 0 : Math.max(0, (s.respawnAt - this.world.tick) / TICK_RATE);
    const m = squadSpawn(this.world);
    this.hud.respawn({ by: this.deathAt?.by ?? null, left, squad: m ? UNITS[m.kind].name : null, rp: s.rp });
  }

  private finish(): void {
    this.ended = true;
    const won = this.world.winner === "draw" ? null : this.world.winner === SIDE;
    this.input.unlock();
    this.armory(false);
    this.hud.respawn(null);
    this.hud.end({ won, s: this.world.frontline!, secs: this.simSeconds });
    const played = music.finale(won === null ? "draw" : won ? "victory" : "defeat");
    if (!played && won !== null) sfx.play(won ? "victory" : "defeat");
  }

  // ------------------------------------------------------------- render ---

  private at(x: number, y: number, air: boolean, lift = 0.25): P3 {
    const g = this.terrain.surfaceAt(x, y);
    return { x, y, h: air ? g * 0.3 + AIR_H : g + lift };
  }

  /** Volume for a sound at (x, y): by distance from the soldier (or the death cam). */
  private earshot(x: number, y: number): number {
    const c = this.cam.position;
    return Math.max(0, 1 - Math.hypot(c.x - x, c.z - y) / 18);
  }

  private placeCamera(dt: number): void {
    const w = this.world;
    const a = avatarOf(w);
    const c = this.cam;
    if (a) {
      const g = this.terrain.groundAt(a.x, a.y);
      this.eyeH = dt > 0 && Math.abs(this.eyeH - g) < 0.6 ? this.eyeH + (g - this.eyeH) * Math.min(1, dt * 14) : g;
      const bobY = Math.abs(Math.sin(this.bob)) * 0.012 * this.stride;
      this.landDip = Math.max(0, this.landDip - dt * 0.18);
      c.position.set(a.x, this.eyeH + EYE + bobY + this.jumpH - this.landDip, a.y);
      const sh = this.shake * 0.012;
      c.rotation.set(this.pitch + this.recoil + (Math.random() - 0.5) * sh, -this.yaw + (Math.random() - 0.5) * sh, Math.sin(this.bob * 0.5) * 0.004 * this.stride);
    } else {
      // the death cam: up and back over where the soldier fell, looking down at it
      const d = this.deathAt ?? { x: c.position.x, y: c.position.z };
      const fx = Math.sin(this.yaw);
      const fy = -Math.cos(this.yaw);
      const g = this.terrain.surfaceAt(d.x, d.y);
      _v.set(d.x - fx * 2.4, g + 2.6, d.y - fy * 2.4);
      c.position.lerp(_v, dt > 0 ? Math.min(1, dt * 2) : 1);
      c.lookAt(d.x, g + 0.2, d.y);
    }
    const zoom = 1 + (weaponStats(w.frontline!, this.weapon).zoom - 1) * this.ads;
    const sprintKick = 1 + Math.max(0, this.stride - 1) * 0.08;
    // a tall (portrait) screen keeps a playable width of view: about 80° across
    const aspect = this.stage.rig.width / Math.max(1, this.stage.rig.height);
    const base = aspect < 1.25 ? Math.min(100, (2 * Math.atan(Math.tan((80 * Math.PI) / 360) / aspect) * 180) / Math.PI) : FOV;
    const fov = base / zoom * sprintKick;
    if (Math.abs(c.fov - fov) > 0.01) {
      c.fov = fov;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld(true);
  }

  private render(dt: number, running: boolean): void {
    const w = this.world;
    const s = w.frontline!;
    const dtMs = running ? dt * 1000 : 0;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.placeCamera(dt);
    const c = this.cam.position;
    this.sky.position.copy(c);
    const fx = Math.sin(this.yaw);
    const fy = -Math.cos(this.yaw);
    this.stage.shadowFocus = { x: c.x + fx * 7, y: c.z + fy * 7, half: 15 };
    const alpha = running ? Math.min(1, this.acc / TICK_MS) : 1;
    const v = this.view;
    v.ground.clear();
    v.over.clear();
    v.top.clear();
    hideSoldier(this.entities, s.avatarId);
    v.tweens.update(dtMs);
    this.terrain.update(dtMs, false);
    this.entities.sync(alpha, this.prev, dtMs);
    this.wrecks.sync(dtMs);
    this.powerFx.sync(dtMs, alpha, null);
    this.objFx.sync(dtMs, alpha);
    this.fx.projectiles(w.projectiles, alpha, this.prev);
    this.fx.update(dtMs);
    v.particles.update(dtMs);
    this.shots.update(running ? dt : 0);
    const a = avatarOf(w);
    const scoped = this.weapon === "rail" && this.ads > 0.85 && !!a;
    this.gun.group.visible = !!a;
    this.gun.update(dt, {
      ads: this.ads,
      reload: this.reloading > 0 ? 1 - this.reloading / this.reloadTotal : 0,
      lookX: 0,
      lookY: 0,
      bob: this.bob,
      stride: Math.min(1.5, this.stride),
      hidden: scoped
    });
    v.ground.flush();
    v.over.flush();
    v.top.flush();
    this.stage.render();
    this.hudFrame(dt, scoped);
    music.update({ intensity: this.mood.update(dt, this.simSeconds), alarm: this.mood.alarm(this.simSeconds), paused: !running });
  }

  private hudFrame(dt: number, scoped: boolean): void {
    const w = this.world;
    const s = w.frontline!;
    const a = avatarOf(w);
    const army = { blue: 0, red: 0 };
    for (const u of w.units.values()) if ((u.faction === "blue" || u.faction === "red") && u.kind !== "harvester") army[u.faction] += UNITS[u.kind].cost * (u.hp / UNITS[u.kind].hp);
    const hqHp = (f: Faction) => {
      const h = hqOf(w, f);
      return h ? h.hp / BUILDINGS.hq.hp : 0;
    };
    const supply = !!a && atSupply(w);
    let prompt = "";
    if (a && supply && !this.hud.armoryShown) prompt = this.input.touch ? "⛽ Supply point · 🛒 Armory" : "⛽ Supply point · <b>B</b> Armory";
    if (a && this.weapon === "launcher" && s.mag.launcher === 0 && s.rockets === 0) prompt = "Out of rockets: visit a supply point";
    const team = teamUnits(w);
    this.hud.update({
      s,
      hp: a ? a.hp / UNITS.trooper.hp : null,
      weapon: this.weapon,
      reloading: this.reloading,
      ads: this.ads,
      scoped,
      spread: this.spread(this.stride > 0.2),
      onEnemy: !!a && this.assistId !== null,
      secs: this.simSeconds,
      supply,
      prompt,
      army,
      hq: { blue: hqHp("blue"), red: hqHp("red") },
      team: team.map((u) => ({ kind: u.kind, hp: u.hp / UNITS[u.kind].hp })),
      dt
    });
    // markers over the fireteam, the Uplinks, the focus target and the hold point
    const rig = this.stage.rig;
    const list: Marker[] = [];
    const put = (x: number, y: number, h: number, label: string, cls: string) => {
      const p = rig.project(x, y, h);
      if (p.behind || p.x < -40 || p.y < -40 || p.x > rig.width + 40 || p.y > rig.height + 40) return;
      list.push({ x: p.x, y: p.y, label, cls });
    };
    for (const u of team) {
      const p = this.entities.pos(u.id);
      if (p) put(p.x, p.y, p.top + 0.08, "", "team");
    }
    const me = this.cam.position;
    for (const l of w.objectives.uplinks) {
      const d = Math.hypot(l.x - me.x, l.y - me.z);
      const cls = `uplink ${l.owner ?? ""}${l.contested ? " contested" : ""}`;
      put(l.x, l.y, this.terrain.surfaceAt(l.x, l.y) + 1.1, `◆ ${this.uplinkNames.get(l.id) ?? ""} <small>${Math.round(d)}</small>`, cls);
    }
    if (s.mode === "attack" && s.attackId !== null) {
      const p = this.entities.pos(s.attackId);
      if (p) put(p.x, p.y, p.top + 0.15, "⌖", "target");
    }
    if (s.mode === "hold" && s.holdAt) put(s.holdAt.x, s.holdAt.y, this.terrain.surfaceAt(s.holdAt.x, s.holdAt.y) + 0.3, "✋", "inbound");
    this.hud.markers(list);
    this.hud.radar({
      me: a ? { x: a.x, y: a.y, yaw: this.yaw } : null,
      team: new Set(s.team),
      seen: (x, y) => isVisible(w, SIDE, Math.floor(x), Math.floor(y)),
      side: SIDE
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    this.input.destroy();
    this.hud.destroy();
    this.gun.dispose();
    this.fx.destroy();
    this.stage.destroy();
  }
}

/** Keep the soldier's own body out of the view (its id changes with every respawn). */
function hideSoldier(entities: EntityRenderer, id: number | null): void {
  entities.hidden.clear();
  if (id !== null) entities.hidden.add(id);
}

/** The rocket's exhaust trail. */
const ROCKET_SMOKE: EmitCfg = {
  tex: TEX.puff, tex2: TEX.puff2, life: [350, 650], speed: [0.02, 0.08], up: [0.02, 0.1], size: [0.04, 0.07], grow: [2, 3],
  alpha: [0.5, 0], tints: [0xd8d2c8], drag: 0.8, fadeIn: 0.1, easeOut: true
};

/** A big gradient sphere around the camera: haze at the horizon, blue overhead. */
function skyDome(horizon: number, zenith: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(60, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    // (drawn first, renderOrder -10, behind everything: no depth test or write)
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: { uH: { value: new THREE.Color(horizon) }, uZ: { value: new THREE.Color(zenith) } },
    vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: [
      "uniform vec3 uH;",
      "uniform vec3 uZ;",
      "varying vec3 vP;",
      "void main() {",
      "  float k = smoothstep(-0.02, 0.55, vP.y);",
      "  gl_FragColor = vec4(mix(uH, uZ, k), 1.0);",
      "  #include <colorspace_fragment>",
      "}"
    ].join("\n")
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -10;
  m.frustumCulled = false;
  return m;
}

/** Ray vs a vertical cylinder (centre x, z; radius r; from y0 to y1): the entry distance, or null. */
function rayCylinder(o: THREE.Vector3, d: THREE.Vector3, cx: number, cz: number, r: number, y0: number, y1: number, max: number): number | null {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return null;
  const b = 2 * (ox * d.x + oz * d.z);
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < 0 || t > max) continue;
    const y = o.y + d.y * t;
    if (y >= y0 && y <= y1) return t;
  }
  return null;
}

/** Ray vs an axis-aligned box: the entry distance, or null. */
function rayBox(o: THREE.Vector3, d: THREE.Vector3, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, max: number): number | null {
  let tmin = 0;
  let tmax = max;
  for (const [oo, dd, lo, hi] of [[o.x, d.x, x0, x1], [o.y, d.y, y0, y1], [o.z, d.z, z0, z1]] as const) {
    if (Math.abs(dd) < 1e-9) {
      if (oo < lo || oo > hi) return null;
      continue;
    }
    let t0 = (lo - oo) / dd;
    let t1 = (hi - oo) / dd;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return null;
  }
  // (starting inside the box: not a hit — the camera never stands in a building)
  return tmin > 0 ? tmin : null;
}
