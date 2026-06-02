// Shared wind-tag display logic — the SINGLE source of the wind clause used on
// HR cards, total-bases cards, and game-header park tags. Reuses the wind math
// in wind.ts (windRelativeAngle / windBucket); never reimplements it.
//
// Two entry points off one core:
//   - windTag()    : the full HR-card line — directional wind, else the static
//                    park label ("Neutral park" / "· calm"). Self-contained
//                    (it's the card's only park/wind indicator).
//   - windClause() : the directional wind clause ONLY (or "Dome · neutral"),
//                    null when there's no usable wind. Used where a static park
//                    label is already shown elsewhere (game header's ParkTag,
//                    total-bases cards under a header) so we don't duplicate it.
// Both share identical arrow + mph + direction text and colors (out=green,
// in=red, cross=slate) so every surface reads the same.

import { getParkBearing, PARK_FACTORS_HITS } from "./constants";
import { windBucket, windRelativeAngle } from "./wind";

export type WindInput = {
  homeTeam: string | null | undefined;
  windSpeed: number | null | undefined;
  windDirDeg: number | null | undefined;
  isDome: boolean | null | undefined;
};

export type WindTagResult = { text: string; arrow: string; tone: string; tooltip?: string };

// Park label + arrow from the hit park factor (>=1.04 hitter, <=0.96 pitcher).
// Exported so FeaturedPlays' "Park ↑ 1.12" line uses the same thresholds.
export function parkLabel(factor: number): { text: string; arrow: string; tone: string } {
  if (factor >= 1.04) return { text: "Hitter-friendly", arrow: "↑", tone: "text-emerald-400" };
  if (factor <= 0.96) return { text: "Pitcher-friendly", arrow: "↓", tone: "text-sky-400" };
  return { text: "Neutral", arrow: "·", tone: "text-slate-400" };
}

// Directional wind clause, or null when not applicable. windDirDeg is OWM's
// meteorological FROM direction → +180 to the blowing-TOWARD bearing (via
// windRelativeAngle) before comparing to the park's home→CF bearing.
function directionalClause(i: WindInput): WindTagResult | null {
  if (i.isDome) return { text: "Dome · neutral", arrow: "", tone: "text-slate-400" };
  const bearing = i.homeTeam ? getParkBearing(i.homeTeam) : null;
  if (i.windSpeed == null || bearing == null || i.windDirDeg == null) return null;
  if (i.windSpeed < 5) return null; // calm — too light to matter
  const rel = windRelativeAngle(i.windDirDeg, bearing);
  const bucket = windBucket(rel);
  const mph = Math.round(i.windSpeed);
  const tip =
    `Wind ${mph} mph from ${Math.round(i.windDirDeg)}° · ` +
    `CF bearing ${bearing}° · field-relative ${Math.round(rel)}°`;
  // rel>0 leans to the RF side, rel<0 to LF (facing CF, right is clockwise).
  if (bucket === "out") {
    const side = rel < -15 ? "LF" : rel > 15 ? "RF" : "CF";
    return { text: `${mph} mph Out to ${side}`, arrow: "↑", tone: "text-emerald-400", tooltip: tip };
  }
  if (bucket === "in") {
    return { text: `${mph} mph In from CF`, arrow: "↓", tone: "text-red-400", tooltip: tip };
  }
  const side = rel > 0 ? "RF" : "LF";
  return { text: `${mph} mph Cross to ${side}`, arrow: "→", tone: "text-slate-400", tooltip: tip };
}

// Wind clause only (or "Dome · neutral"); null when no usable wind / calm /
// unknown bearing. For surfaces that already show the static park label.
export function windClause(i: WindInput): WindTagResult | null {
  return directionalClause(i);
}

// Full HR-card line: directional wind clause, else the static park label
// (with "· calm" when the wind is too light). Always returns something.
export function windTag(i: WindInput): WindTagResult {
  const dir = directionalClause(i);
  if (dir) return dir; // directional wind, or dome
  const pf = i.homeTeam ? PARK_FACTORS_HITS[i.homeTeam] ?? 1.0 : 1.0;
  const pl = parkLabel(pf);
  const calm = !i.isDome && i.windSpeed != null && i.windSpeed < 5;
  return { text: `${pl.text} park${calm ? " · calm" : ""}`, arrow: "", tone: pl.tone };
}
