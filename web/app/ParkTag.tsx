import { getParkProfile } from "@/lib/constants";

/**
 * Ambient park-profile tag shown in game card headers.
 *
 * Display-only — reads the home team's hits park factor from the
 * frontend's PARK_FACTORS_HITS table (which mirrors engine/constants.py).
 * Neutral parks (factor in [0.96, 1.04]) render nothing so the header
 * stays uncluttered for the average half of the league. Hitter / pitcher
 * leaning parks render a muted pill with an up/down arrow and a tooltip
 * carrying the exact factor.
 */
export default function ParkTag({ homeTeam }: { homeTeam: string | null | undefined }) {
  if (!homeTeam) return null;
  const { factor, label, direction } = getParkProfile(homeTeam);

  if (direction === "neutral") return null;

  const isUp = direction === "up";
  const arrow = isUp ? "↑" : "↓";
  const text = isUp ? "Hitter park" : "Pitcher park";
  // Muted emerald / sky — visually congruent with the existing K/H prop chips
  // (rounded, slate-toned border + tinted background) but deliberately dim so
  // it doesn't compete with the matchup heading.
  const palette = isUp
    ? "border-emerald-900/50 bg-emerald-950/30 text-emerald-400/80"
    : "border-sky-900/50 bg-sky-950/30 text-sky-400/80";
  const title = `${label} park (factor ${factor.toFixed(2)})`;

  return (
    <span
      title={title}
      className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide tabular-nums ${palette}`}
    >
      {text} {arrow}
    </span>
  );
}
