import * as THREE from "three";
import type { WeaponId } from "../sim/modes/frontline";

/**
 * Frontline's first-person viewmodel: the soldier's three guns, low-poly in
 * the vehicles' painted style (gunmetal bodies, a royal-blue team panel,
 * amber lights), carried at the lower right of the view. It rides the camera:
 * sway with the look, bob with the stride, kick on each shot, slide to the
 * centre aiming down sights, dip out of view to reload or swap.
 *
 * World units are tiles; a robot stands about half a tile tall, so a gun is
 * a few hundredths of a tile long and sits just past the camera's near plane.
 */

const GM = 0x3a4250;
const GM_D = 0x252b35;
const GM_L = 0x5b6576;
const TEAM = 0x2f6fe0;
const AMBER = 0xffb43c;

const mat = (color: number, emissive = 0, rough = 0.55, metal = 0.6) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: emissive ? 1.6 : 0 });

interface GunModel {
  root: THREE.Group;
  /** Muzzle, in the model's space. */
  muzzle: THREE.Vector3;
}

function box(g: THREE.Group, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}

function tube(g: THREE.Group, m: THREE.Material, r: number, len: number, x: number, y: number, z: number, seg = 10): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), m);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}

/** The guns, each pointing down -Z with its grip at the origin. */
function buildGuns(): Record<WeaponId, GunModel> {
  const body = mat(GM);
  const dark = mat(GM_D, 0, 0.7, 0.4);
  const light = mat(GM_L, 0, 0.45, 0.7);
  const team = mat(TEAM, 0, 0.5, 0.3);
  const glow = mat(0x221400, AMBER);
  const cyan = mat(0x001822, 0x5fd8ff);

  const carbine = new THREE.Group();
  box(carbine, body, 0.022, 0.026, 0.11, 0, 0.012, -0.04); // receiver
  box(carbine, team, 0.023, 0.01, 0.05, 0, 0.022, -0.03); // team stripe
  box(carbine, dark, 0.016, 0.03, 0.02, 0, -0.012, 0.0); // grip
  box(carbine, dark, 0.014, 0.032, 0.018, 0, -0.01, -0.045); // magazine
  box(carbine, light, 0.02, 0.018, 0.05, 0, 0.004, 0.035); // stock
  tube(carbine, light, 0.006, 0.07, 0, 0.016, -0.125); // barrel
  box(carbine, dark, 0.012, 0.012, 0.03, 0, 0.032, -0.05); // sight rail
  box(carbine, glow, 0.004, 0.004, 0.004, 0, 0.04, -0.05); // sight dot
  box(carbine, glow, 0.024, 0.004, 0.01, 0, 0.0, -0.09); // amber muzzle ring light

  const rail = new THREE.Group();
  box(rail, body, 0.022, 0.024, 0.13, 0, 0.012, -0.05);
  box(rail, team, 0.023, 0.008, 0.07, 0, 0.022, -0.04);
  box(rail, dark, 0.016, 0.03, 0.02, 0, -0.012, 0.0);
  box(rail, light, 0.02, 0.02, 0.06, 0, 0.004, 0.04);
  // twin rails with a cyan charge glow between them
  box(rail, light, 0.006, 0.006, 0.14, -0.007, 0.016, -0.17);
  box(rail, light, 0.006, 0.006, 0.14, 0.007, 0.016, -0.17);
  box(rail, cyan, 0.003, 0.003, 0.12, 0, 0.016, -0.165);
  tube(rail, dark, 0.011, 0.07, 0, 0.044, -0.05); // scope
  box(rail, glow, 0.004, 0.004, 0.004, 0, 0.044, -0.088);

  const launcher = new THREE.Group();
  tube(launcher, body, 0.024, 0.22, 0, 0.03, -0.06, 14); // tube
  tube(launcher, team, 0.0255, 0.05, 0, 0.03, -0.02, 14); // team band
  tube(launcher, dark, 0.028, 0.03, 0, 0.03, -0.165, 14); // muzzle bell
  box(launcher, dark, 0.016, 0.03, 0.02, 0, -0.008, 0.0);
  box(launcher, light, 0.014, 0.022, 0.035, 0.026, 0.035, -0.04); // sight box
  box(launcher, glow, 0.005, 0.005, 0.005, 0.026, 0.05, -0.04);

  return {
    carbine: { root: carbine, muzzle: new THREE.Vector3(0, 0.016, -0.165) },
    rail: { root: rail, muzzle: new THREE.Vector3(0, 0.016, -0.24) },
    launcher: { root: launcher, muzzle: new THREE.Vector3(0, 0.03, -0.18) }
  };
}

/** Hip and sights positions of the gun in camera space. */
const HIP = new THREE.Vector3(0.075, -0.07, -0.13);
const ADS = new THREE.Vector3(0, -0.04, -0.1);

export class Viewmodel {
  readonly group = new THREE.Group();
  private guns = buildGuns();
  private current: WeaponId = "carbine";
  private kick = 0;
  private dip = 0;
  private swayX = 0;
  private swayY = 0;
  private flash: THREE.Mesh;
  private flashT = 0;
  private light: THREE.PointLight;

  constructor(camera: THREE.Camera) {
    camera.add(this.group);
    for (const g of Object.values(this.guns)) {
      g.root.visible = false;
      g.root.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      });
      this.group.add(g.root);
    }
    this.guns.carbine.root.visible = true;
    const fm = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), fm);
    this.flash.frustumCulled = false;
    this.group.add(this.flash);
    this.light = new THREE.PointLight(0xffc070, 0, 1.2, 2);
    this.group.add(this.light);
  }

  set(id: WeaponId): void {
    if (id === this.current) return;
    this.guns[this.current].root.visible = false;
    this.current = id;
    this.guns[id].root.visible = true;
    this.dip = 1;
  }

  /** A shot: kick back and flash. */
  fired(scale = 1): void {
    this.kick = Math.min(1.4, this.kick + scale);
    this.flashT = 1;
  }

  /** Muzzle position in world space. */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    const g = this.guns[this.current];
    g.root.updateWorldMatrix(true, false);
    return out.copy(g.muzzle).applyMatrix4(g.root.matrixWorld);
  }

  /**
   * Per frame: `ads` 0–1 toward the sights, `reload` 0–1 (dipped out of view),
   * look deltas for sway, `bob` the stride phase and `stride` how hard it bobs.
   * `hidden` (scoped in) puts the gun away.
   */
  update(dt: number, o: { ads: number; reload: number; lookX: number; lookY: number; bob: number; stride: number; hidden: boolean }): void {
    this.kick = Math.max(0, this.kick - dt * 9);
    this.dip = Math.max(0, this.dip - dt * 4);
    this.swayX += (-o.lookX * 0.6 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (o.lookY * 0.6 - this.swayY) * Math.min(1, dt * 10);
    const g = this.guns[this.current].root;
    g.visible = !o.hidden;
    const p = g.position.lerpVectors(HIP, ADS, o.ads);
    const still = 1 - o.ads * 0.85;
    p.x += (Math.sin(o.bob) * 0.006 * o.stride + this.swayX * 0.02) * still;
    p.y += (-Math.abs(Math.cos(o.bob)) * 0.005 * o.stride + this.swayY * 0.02 - Math.max(o.reload > 0 ? Math.sin(Math.min(1, o.reload) * Math.PI) : 0, this.dip) * 0.06) * 1;
    p.z += this.kick * 0.02;
    g.rotation.set(this.kick * 0.12 + (o.reload > 0 ? Math.sin(Math.min(1, o.reload) * Math.PI) * 0.5 : 0), this.swayX * 0.05, -o.reload * 0.3 * (o.reload > 0 ? 1 : 0));
    // muzzle flash
    this.flashT = Math.max(0, this.flashT - dt * 22);
    const fm = this.flash.material as THREE.MeshBasicMaterial;
    fm.opacity = this.flashT;
    this.flash.visible = this.flashT > 0 && !o.hidden;
    if (this.flash.visible) {
      const m = this.guns[this.current];
      this.flash.position.copy(m.muzzle).add(g.position);
      this.flash.rotation.z = Math.random() * Math.PI;
      this.flash.scale.setScalar(0.7 + Math.random() * 0.6);
    }
    this.light.intensity = this.flashT * 0.6;
    this.light.position.copy(this.flash.position);
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

/** Tracers, rockets and grenades the player's own guns put in the world. */
export class Shots {
  readonly group = new THREE.Group();
  private tracers: { mesh: THREE.Mesh; t: number; life: number }[] = [];
  private tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  private tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private railMat = new THREE.MeshBasicMaterial({ color: 0x7fe6ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private rocketGeo = new THREE.CylinderGeometry(0.008, 0.012, 0.06, 8).rotateX(Math.PI / 2);
  private rocketMat = new THREE.MeshStandardMaterial({ color: 0x5b6576, emissive: 0xff7a20, emissiveIntensity: 0.6 });
  private nadeGeo = new THREE.SphereGeometry(0.014, 8, 6);
  private nadeMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, emissive: 0xffb43c, emissiveIntensity: 0.8 });

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, rail = false): void {
    const len = from.distanceTo(to);
    if (len < 0.05) return;
    const mesh = new THREE.Mesh(this.tracerGeo, rail ? this.railMat.clone() : this.tracerMat.clone());
    const w = rail ? 0.012 : 0.006;
    mesh.scale.set(w, w, rail ? len : Math.min(len, 1.6));
    mesh.position.copy(rail ? from.clone().lerp(to, 0.5) : from.clone().lerp(to, Math.min(1, 0.8 / len) * 0.5 + 0.25));
    mesh.lookAt(to);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.tracers.push({ mesh, t: 0, life: rail ? 0.35 : 0.06 });
  }

  rocket(): THREE.Mesh {
    const m = new THREE.Mesh(this.rocketGeo, this.rocketMat);
    this.group.add(m);
    return m;
  }

  grenade(): THREE.Mesh {
    const m = new THREE.Mesh(this.nadeGeo, this.nadeMat);
    this.group.add(m);
    return m;
  }

  remove(m: THREE.Object3D): void {
    this.group.remove(m);
  }

  update(dt: number): void {
    this.tracers = this.tracers.filter((tr) => {
      tr.t += dt;
      const k = 1 - tr.t / tr.life;
      if (k <= 0) {
        this.group.remove(tr.mesh);
        (tr.mesh.material as THREE.Material).dispose();
        return false;
      }
      (tr.mesh.material as THREE.MeshBasicMaterial).opacity = k;
      return true;
    });
  }
}
