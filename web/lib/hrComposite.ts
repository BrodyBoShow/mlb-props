// HR MATCHUPS section — composite RANKING heuristic (selection only).
//
// Decides WHICH 3 HR matchups to surface and the score they're ranked on. It is
// NOT a model feature (FEATURE_COLS stays 11), NOT a calibrated probability, NOT
// an edge, and it does NOT change the displayed HR projection — it only drives
// the top-3 selection.
//
// composite = projection × windAdjPark × powerFactor × platoonFactor
//   - base         : the HR projection (keeps real power hitters on top)
//   - windAdjPark  : park hit-factor scaled by today's wind (reuses the shared
//                    windRelativeAngle / windParkMultiplier helpers)
//   - powerFactor  : recent batted-ball quality (sweet-spot % + avg exit velo)
//   - platoonFactor: hitter bats vs opposing SP hand
//
// HONESTY: every factor degrades to 1.0 (neutral) when its data is missing — the
// hitter is never dropped and nothing is fabricated. With all three neutral the
// composite reduces EXACTLY to the old projection × parkFactor ranking.

import { getParkBearing, HR_COMPOSITE, PARK_FACTORS_HITS } from "./constants";
import { windParkMultiplier, windRelativeAngle } from "./wind";

export type HrCompositeInput = {
  projection: number;
  homeTeam: string;
  windSpeed: number | null;
  windDirDeg: number | null;
  isDome: boolean | null;
  sweetSpotPct: number | null;
  avgExitVelo: number | null;
  hitterBats: string | null; // "L" | "R" | "S"
  oppPitcherThrows: string | null; // "L" | "R"
  oppSpHr9: number | null; // opposing starter HR/9, last 5 starts
};

export type HrCompositeResult = {
  score: number;
  base: number; // = projection (unchanged display value)
  parkFactor: number;
  windAdjPark: number;
  powerFactor: number;
  platoonFactor: number;
  hr9Factor: number;
  // term availability — for auditing which terms were live vs degraded-to-neutral
  windAvailable: boolean;
  powerAvailable: boolean;
  platoonAvailable: boolean;
  hr9Available: boolean;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function hrComposite(i: HrCompositeInput): HrCompositeResult {
  const parkFactor = PARK_FACTORS_HITS[i.homeTeam] ?? 1.0;

  // ── wind-adjusted park factor (reuses windRelativeAngle / windParkMultiplier) ──
  let windMult = 1;
  let windAvailable = false;
  if (!i.isDome && i.windSpeed != null && i.windDirDeg != null && i.windSpeed >= 5) {
    const bearing = getParkBearing(i.homeTeam);
    if (bearing != null) {
      const rel = windRelativeAngle(i.windDirDeg, bearing);
      windMult = windParkMultiplier(rel, i.windSpeed);
      windAvailable = windMult !== 1; // cross/calm leave it at 1.0
    }
  }
  const windAdjPark = parkFactor * windMult;

  // ── recent power contact (sweet-spot % + avg exit velo) ──
  let powerFactor = 1;
  let powerAvailable = false;
  if (i.sweetSpotPct != null && i.avgExitVelo != null) {
    const ss = clamp01(
      (i.sweetSpotPct - HR_COMPOSITE.POWER_SWEET_FLOOR) /
        (HR_COMPOSITE.POWER_SWEET_ELITE - HR_COMPOSITE.POWER_SWEET_FLOOR),
    );
    const ev = clamp01(
      (i.avgExitVelo - HR_COMPOSITE.POWER_EV_FLOOR) /
        (HR_COMPOSITE.POWER_EV_ELITE - HR_COMPOSITE.POWER_EV_FLOOR),
    );
    const power01 = 0.5 * ss + 0.5 * ev; // 0..1, ~0.5 ≈ league-average contact
    powerFactor = 1 + HR_COMPOSITE.POWER_WEIGHT * (2 * power01 - 1);
    powerAvailable = true;
  }

  // ── platoon edge (hitter bats vs opposing SP hand) ──
  let platoonFactor = 1;
  let platoonAvailable = false;
  const b = i.hitterBats;
  const t = i.oppPitcherThrows;
  if (b && t) {
    const favorable = b === "S" || (b === "L" && t === "R") || (b === "R" && t === "L");
    const sameHand = (b === "L" && t === "L") || (b === "R" && t === "R");
    platoonFactor = favorable
      ? 1 + HR_COMPOSITE.PLATOON_WEIGHT
      : sameHand
        ? 1 - HR_COMPOSITE.PLATOON_WEIGHT
        : 1;
    platoonAvailable = true;
  }

  // ── opposing-starter HR/9 (last 5 starts) ──
  // Higher opp HR/9 = the hitter faces a homer-prone arm → boost; lower = a
  // stingy arm → suppression. Normalized floor→elite, bounded ±HR9_WEIGHT.
  let hr9Factor = 1;
  let hr9Available = false;
  if (i.oppSpHr9 != null) {
    const h = clamp01(
      (i.oppSpHr9 - HR_COMPOSITE.HR9_FLOOR) /
        (HR_COMPOSITE.HR9_ELITE - HR_COMPOSITE.HR9_FLOOR),
    );
    hr9Factor = 1 + HR_COMPOSITE.HR9_WEIGHT * (2 * h - 1);
    hr9Available = true;
  }

  return {
    score: i.projection * windAdjPark * powerFactor * platoonFactor * hr9Factor,
    base: i.projection,
    parkFactor,
    windAdjPark,
    powerFactor,
    platoonFactor,
    hr9Factor,
    windAvailable,
    powerAvailable,
    platoonAvailable,
    hr9Available,
  };
}
