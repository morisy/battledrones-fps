/**
 * Frontline's controls. Desktop: mouse look under pointer lock, WASD, the
 * mouse buttons and a handful of keys. Phones and tablets: a move stick on
 * the left half of the screen, drag to look on the right half, and buttons
 * (fire, sights, reload, grenade, weapon, squad orders, armory).
 *
 * The scene reads one snapshot per frame (poll): held state, look deltas
 * since the last poll and the actions pressed since then.
 */

export type Action =
  | "reload" | "grenade" | "weapon1" | "weapon2" | "weapon3" | "nextWeapon" | "prevWeapon" | "lastWeapon"
  | "follow" | "hold" | "attack" | "armory" | "pause" | "deploy" | "jump";

const KEYS: Record<string, Action> = {
  KeyR: "reload", KeyG: "grenade", Digit1: "weapon1", Digit2: "weapon2", Digit3: "weapon3", KeyQ: "lastWeapon",
  KeyF: "follow", KeyH: "hold", KeyT: "attack", KeyB: "armory", Escape: "pause", Space: "jump", Enter: "deploy"
};

export interface InputFrame {
  /** Move intent: x right, y forward, length ≤ 1. */
  move: { x: number; y: number };
  /** Look deltas (radians) since the last poll. */
  lookX: number;
  lookY: number;
  fire: boolean;
  ads: boolean;
  sprint: boolean;
  actions: Set<Action>;
}

/** Radians per mouse pixel (a touch drag turns this much per CSS px, times TOUCH_K). */
const MOUSE_SENS = 0.0022;
const TOUCH_K = 2.4;

export class FpsInput {
  readonly touch: boolean;
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private mouseFire = false;
  private mouseAds = false;
  private actions = new Set<Action>();
  private off: (() => void)[] = [];
  /** Touch: the move stick (its pointer, centre and current offset), the look pointer, and held buttons. */
  private stick: { id: number; cx: number; cy: number; dx: number; dy: number } | null = null;
  private look: { id: number; x: number; y: number } | null = null;
  private touchFire = false;
  private touchAds = false;
  private stickEl: HTMLElement | null = null;
  private knobEl: HTMLElement | null = null;
  /** Mouse look only counts under pointer lock (or while a touch drags). */
  locked = false;
  private lockedAt = 0;
  enabled = true;
  /** Look sensitivity multiplier (the pause menu's slider). */
  sens = 1;

  constructor(private canvas: HTMLElement, private root: HTMLElement) {
    this.touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const on = <K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void, o?: AddEventListenerOptions) => {
      window.addEventListener(t, f, o);
      this.off.push(() => window.removeEventListener(t, f, o));
    };
    on("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.code);
      const a = KEYS[e.code];
      if (a && !e.repeat) this.actions.add(a);
      if (e.code === "Tab" || e.code === "Space") e.preventDefault();
    });
    on("keyup", (e) => this.keys.delete(e.code));
    on("blur", () => {
      this.keys.clear();
      this.mouseFire = this.mouseAds = false;
    });
    on("mousemove", (e) => {
      if (!this.locked || !this.enabled) return;
      // (Chrome reports the jump to the centre as one huge movement as the lock engages: drop it)
      if (performance.now() - this.lockedAt < 120 || Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
      this.lookX += e.movementX * MOUSE_SENS * this.sens;
      this.lookY += e.movementY * MOUSE_SENS * this.sens;
    });
    on("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.mouseAds = true;
    });
    on("mouseup", (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseAds = false;
    });
    on("wheel", (e) => {
      if (!this.locked) return;
      this.actions.add(e.deltaY > 0 ? "nextWeapon" : "prevWeapon");
    });
    const lockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.lockedAt = performance.now();
      if (!this.locked) this.mouseFire = this.mouseAds = false;
    };
    document.addEventListener("pointerlockchange", lockChange);
    this.off.push(() => document.removeEventListener("pointerlockchange", lockChange));
    if (this.touch) this.mountTouch();
  }

  /** Ask for pointer lock (desktop; must come from a click). */
  lock(): void {
    if (this.touch) {
      this.locked = true;
      return;
    }
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        /* the browser said no (too soon after leaving it): the next click tries again */
      });
    } catch {
      /* no pointer lock: mouse look won't work, keys still do */
    }
  }

  unlock(): void {
    if (this.touch) {
      this.locked = false;
      return;
    }
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** This frame's controls; look deltas and pressed actions are consumed. */
  poll(): InputFrame {
    const k = this.keys;
    let mx = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    let my = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    let sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    if (this.stick) {
      const R = 46;
      mx = this.stick.dx / R;
      my = -this.stick.dy / R;
      const len = Math.hypot(mx, my);
      if (len > 1) (mx /= len), (my /= len);
      // pushed to the rim: sprint
      sprint = len > 1.25 && my > 0.5;
    }
    const len = Math.hypot(mx, my);
    if (len > 1) (mx /= len), (my /= len);
    const out: InputFrame = {
      move: { x: mx, y: my },
      lookX: this.enabled ? this.lookX : 0,
      lookY: this.enabled ? this.lookY : 0,
      fire: this.enabled && (this.mouseFire || this.touchFire),
      ads: this.enabled && (this.mouseAds || this.touchAds),
      sprint,
      actions: this.actions
    };
    this.lookX = this.lookY = 0;
    this.actions = new Set();
    return out;
  }

  /** Trigger an action from a HUD button. */
  press(a: Action): void {
    this.actions.add(a);
  }

  // ------------------------------------------------------------- touch ---

  private mountTouch(): void {
    const pad = document.createElement("div");
    pad.className = "fps-touch";
    pad.innerHTML = `
      <div class="fps-stick-hint" aria-hidden="true">move</div>
      <div class="fps-look-hint" aria-hidden="true">look</div>
      <div class="fps-stick" hidden><div class="fps-knob"></div></div>
      <button class="fps-tb fire" data-hold="fire">🔥</button>
      <button class="fps-tb ads" data-toggle="ads">◎</button>
      <button class="fps-tb reload" data-act="reload">⟳</button>
      <button class="fps-tb nade" data-act="grenade">💣</button>
      <button class="fps-tb swap" data-act="nextWeapon">⇄</button>
      <button class="fps-tb jump" data-act="jump" title="Jump">⤒</button>
      <div class="fps-orders">
        <button class="fps-tb sm" data-act="follow" title="Fireteam: follow me">⚑</button>
        <button class="fps-tb sm" data-act="hold" title="Fireteam: hold where I aim">✋</button>
        <button class="fps-tb sm" data-act="attack" title="Fireteam: attack what I aim at">🎯</button>
        <button class="fps-tb sm" data-act="armory" title="Armory and reinforcements">🛒</button>
        <button class="fps-tb sm" data-act="pause" title="Pause">⏸</button>
      </div>`;
    this.root.appendChild(pad);
    this.stickEl = pad.querySelector(".fps-stick");
    this.knobEl = pad.querySelector(".fps-knob");
    this.off.push(() => pad.remove());
    for (const b of pad.querySelectorAll<HTMLElement>("[data-act]"))
      b.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.press(b.dataset.act as Action);
      });
    const fire = pad.querySelector<HTMLElement>("[data-hold=fire]")!;
    fire.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.touchFire = true;
      // the fire button also looks: drag it to track a target while shooting
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
      fire.setPointerCapture(e.pointerId);
    });
    fire.addEventListener("pointermove", (e) => this.lookMove(e));
    const fireUp = (e: PointerEvent) => {
      this.touchFire = false;
      if (this.look?.id === e.pointerId) this.look = null;
    };
    fire.addEventListener("pointerup", fireUp);
    fire.addEventListener("pointercancel", fireUp);
    const ads = pad.querySelector<HTMLElement>("[data-toggle=ads]")!;
    ads.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.touchAds = !this.touchAds;
      ads.classList.toggle("on", this.touchAds);
    });
    const down = (e: PointerEvent) => {
      if (!this.enabled || (e.target as HTMLElement).closest("button, .fps-modal, .fps-overlay")) return;
      if (e.clientX < window.innerWidth * 0.45) {
        if (this.stick) return;
        this.stick = { id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
        pad.classList.add("used");
        if (this.stickEl) {
          this.stickEl.hidden = false;
          this.stickEl.style.left = `${e.clientX}px`;
          this.stickEl.style.top = `${e.clientY}px`;
        }
      } else if (!this.look) this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (this.stick?.id === e.pointerId) {
        this.stick.dx = e.clientX - this.stick.cx;
        this.stick.dy = e.clientY - this.stick.cy;
        const d = Math.hypot(this.stick.dx, this.stick.dy);
        const k = d > 60 ? 60 / d : 1;
        if (this.knobEl) this.knobEl.style.transform = `translate(${this.stick.dx * k}px, ${this.stick.dy * k}px)`;
      } else this.lookMove(e);
    };
    const up = (e: PointerEvent) => {
      if (this.stick?.id === e.pointerId) {
        this.stick = null;
        if (this.stickEl) this.stickEl.hidden = true;
        if (this.knobEl) this.knobEl.style.transform = "";
      }
      if (this.look?.id === e.pointerId) this.look = null;
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    this.off.push(() => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    });
  }

  private lookMove(e: PointerEvent): void {
    if (this.look?.id !== e.pointerId) return;
    this.lookX += (e.clientX - this.look.x) * MOUSE_SENS * TOUCH_K * this.sens;
    this.lookY += (e.clientY - this.look.y) * MOUSE_SENS * TOUCH_K * this.sens;
    this.look.x = e.clientX;
    this.look.y = e.clientY;
  }

  destroy(): void {
    for (const f of this.off) f();
    this.unlock();
  }
}
