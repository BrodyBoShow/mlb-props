// Shared wind geometry — the SINGLE source of the field-relative wind math.
// Used by BOTH the HR-card wind tag (FeaturedPlays.tsx, display) and the HR
// composite ranking (hrComposite.ts, selection) so the two never diverge.
//
// windDirDeg is OpenWeatherMap's METEOROLOGICAL direction — the way the wind
// blows FROM (0 = N). We convert to the blowing-TOWARD bearing (+180) before
// comparing to the park's home-plate→center-field bearing.

import { HR_COMPOSITE } from "./constants";

// Field-relative wind angle in (-180, 180].
//   0   → blowing straight out to center (tailwind)
//   ±180→ blowing straight in from center (headwind)
//   ±90 → blowing across the field
// rel > 0 leans toward the RF side, rel < 0 toward LF (facing CF, right is CW).
export function windRelativeAngle(windDirDeg: number, bearing: number): number {
  const windToward = (windDirDeg + 180) % 360; // direction wind blows TOWARD
  return ((windToward - bearing + 540) % 360) - 180;
}

export type WindBucket = "out" | "in" | "cross";

// Bucket the relative angle: out (tailwind) / in (headwind) / cross.
export function windBucket(rel: number): WindBucket {
  const a = Math.abs(rel);
  if (a <= 45) return "out";
  if (a >= 135) return "in";
  return "cross";
}

// Multiplier the wind applies to a park's hit factor for the HR composite.
// Tailwind out → > 1 (scale up); headwind in → < 1 (scale down); cross → 1.0.
// Magnitude scales with wind speed, saturating at WIND_STRONG_MPH. Pure ranking
// heuristic — NOT a calibrated probability.
export function windParkMultiplier(rel: number, speedMph: number): number {
  const bucket = windBucket(rel);
  if (bucket === "cross") return 1;
  const strength = Math.min(speedMph / HR_COMPOSITE.WIND_STRONG_MPH, 1);
  const delta = HR_COMPOSITE.WIND_WEIGHT * strength;
  return bucket === "out" ? 1 + delta : 1 - delta;
}
