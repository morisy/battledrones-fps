/**
 * Frontline's player settings (the pause menu), kept in localStorage. Touch
 * screens start with aim assist and auto-fire on, as phone shooters do; a
 * mouse starts with both off.
 */
export interface FpsSettings {
  /** Look sensitivity multiplier (0.4–2.5). */
  sens: number;
  /** Aim slows and drifts onto an enemy near the crosshair. */
  assist: boolean;
  /** Fire on its own while the crosshair is on an enemy. */
  autoFire: boolean;
  /** Buzz the phone on hits taken and kills. */
  haptics: boolean;
}

const KEY = "battledrones.fps";

export function loadFpsSettings(touch: boolean): FpsSettings {
  const s: FpsSettings = { sens: 1, assist: touch, autoFire: touch, haptics: true };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<FpsSettings>;
    if (typeof raw.sens === "number" && raw.sens >= 0.4 && raw.sens <= 2.5) s.sens = raw.sens;
    for (const k of ["assist", "autoFire", "haptics"] as const) if (typeof raw[k] === "boolean") s[k] = raw[k]!;
  } catch {
    /* storage blocked: defaults */
  }
  return s;
}

export function saveFpsSettings(s: FpsSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** A short buzz (phones that can; nothing elsewhere). */
export function buzz(s: FpsSettings, ms: number | number[]): void {
  if (!s.haptics) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}
