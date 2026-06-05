"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useWatchlist } from "./useWatchlist";
import DateNav from "./DateNav";
import FeaturedPlays from "./FeaturedPlays";
import ParkTag from "./ParkTag";
import SharpBadge from "./SharpBadge";
import { getParkProfile } from "@/lib/constants";
import { windClause } from "@/lib/windTag";
import { useLiveGameStatus } from "./useLiveGameStatus";
import { useLiveBoxScores } from "./useLiveBoxScores";
import {
  useFirstInningStats,
  type FirstInningGame,
  type FirstInningMap,
} from "./useFirstInningStats";
import type {
  ByProp,
  FeaturedSection,
  GameGroup,
  GameStatus,
  Pitcher,
  PropType,
  StatLine,
  Trends,
  TrendWindow,
} from "@/lib/types";
import { BOOK_DISPLAY, EDGE_THRESHOLD, HITTER_PROPS, MIN_LINE, REAL_BOOKS } from "@/lib/constants";
import { fmt, formatShortDate } from "@/lib/format";
import {
  hitterFantasyScore,
  isQualityStart,
  PITCHER_OUT_PTS,
  PITCHER_STRIKEOUT_PTS,
  PITCHER_EARNED_RUN_PTS,
  PITCHER_QUALITY_START_PTS,
} from "@/lib/fantasyScore";

// Re-export types so existing `import {…} from "./PropBoard"` keeps working.
export type { ByProp, GameGroup, Pitcher, PropType } from "@/lib/types";

// ── prop metadata ─────────────────────────────────────────────────────────────

// `label` is the long filter-chip text (carries a Pitcher/Hitter prefix so the
// two "Fantasy Score" props are distinguishable). `short` is the compact chip
// label used in the all-props game-first matrix.
const PROPS: { key: PropType; label: string; unit: string; short: string }[] = [
  // pitcher props
  { key: "strikeouts",            label: "Pitcher Strikeouts",    unit: "K",    short: "K"    },
  { key: "hits_allowed",          label: "Pitcher Hits Allowed",  unit: "HA",   short: "HA"   },
  { key: "walks",                 label: "Pitcher Walks",         unit: "BB",   short: "BB"   },
  { key: "earned_runs",           label: "Pitcher Earned Runs",   unit: "ER",   short: "ER"   },
  { key: "outs_recorded",         label: "Pitcher Outs Recorded", unit: "outs", short: "Outs" },
  { key: "pitcher_first_inning_pitches", label: "Pitcher 1st-Inning Pitches", unit: "P", short: "1stP" },
  { key: "pitcher_first_inning_strikeouts", label: "Pitcher 1st-Inning Ks", unit: "K", short: "1stK" },
  { key: "pitcher_fantasy_score", label: "Pitcher Fantasy Score", unit: "FP",   short: "FP"   },
  // hitter props
  { key: "hitter_hits",           label: "Hitter Hits",           unit: "H",    short: "H"    },
  { key: "hitter_total_bases",    label: "Hitter Total Bases",    unit: "TB",   short: "TB"   },
  { key: "hitter_hits_runs_rbis", label: "Hitter Hits+Runs+RBIs", unit: "HRR",  short: "HRR"  },
  { key: "hitter_rbis",           label: "Hitter RBIs",           unit: "RBI",  short: "RBI"  },
  { key: "hitter_runs",           label: "Hitter Runs",           unit: "R",    short: "R"    },
  { key: "hitter_home_runs",      label: "Hitter Home Runs",      unit: "HR",   short: "HR"   },
  { key: "hitter_fantasy_score",  label: "Hitter Fantasy Score",  unit: "FP",   short: "FP"   },
];

const PROP_META = Object.fromEntries(PROPS.map((p) => [p.key, p])) as Record<
  PropType,
  { key: PropType; label: string; unit: string; short: string }
>;
const PITCHER_PROP_KEYS: PropType[] = PROPS.filter((p) => !HITTER_PROPS.has(p.key)).map((p) => p.key);
const HITTER_PROP_KEYS: PropType[] = PROPS.filter((p) => HITTER_PROPS.has(p.key)).map((p) => p.key);

// EDGE_THRESHOLD and HITTER_PROPS now live in @/lib/constants — imported above.

// Minimum proj-vs-line gap before we call a model lean on a DFS (PrizePicks)
// line. Mirrors NO_LEAN_THRESHOLD in /results so the board's lean direction
// and the results-page grading agree on what counts as "~Even".
const LINE_LEAN_THRESHOLD = 0.1;

// Under All Props, an expanded game shows its edge-hitters by default and folds
// the rest behind "Show N more". When NO hitter has a qualifying edge, we still
// surface this many so the hitting lineup is never fully hidden (the lineup must
// be visible in the card, not one click away). The rest stay behind the expander.
const DEFAULT_HITTER_COUNT = 3;

// ── Watchlist (localStorage, no accounts) ────────────────────────────────────
// Cross-cutting user state shared via context so the star toggles + the filter
// don't need to be threaded through every component.
type WatchlistApi = {
  has: (id: number) => boolean;
  toggle: (id: number) => void;
  onlyWatched: boolean; // the "★ Watchlist" filter is active
};
const WatchlistCtx = createContext<WatchlistApi>({
  has: () => false,
  toggle: () => {},
  onlyWatched: false,
});

// A star toggle for a player. stopPropagation so it never opens a row/drawer.
function StarButton({ playerId, className }: { playerId: number; className?: string }) {
  const { has, toggle } = useContext(WatchlistCtx);
  const watched = has(playerId);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle(playerId);
      }}
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      title={watched ? "Watching — click to remove" : "Add to watchlist"}
      className={[
        "shrink-0 leading-none transition-colors",
        watched ? "text-amber-400" : "text-slate-600 hover:text-amber-400/70",
        className ?? "",
      ].join(" ")}
    >
      {watched ? "★" : "☆"}
    </button>
  );
}

// Grade the PROJECTION'S LEAN against the line vs the actual — i.e. if you'd
// bet the side the projection points to (over if proj > line, under if proj <
// line), did that bet WIN. green = win money, red = lose money. This is the
// canonical grading for the (monetized) tool; it matches the /results page so
// the board and the results page always agree.
//   lean   = sign(projection − line)   (|gap| < LINE_LEAN_THRESHOLD ⇒ no lean)
//   result = sign(actual − line)
//   "win" when the lean matched the result, "loss" when it didn't.
//
// Canonical spec examples (these MUST keep producing these colors):
//   proj 10, line 7.5, actual 9 → over lean,  actual over  → WIN  (green)
//   proj 10, line 7.5, actual 7 → over lean,  actual under → LOSS (red)
//   proj  6, line 7.5, actual 7 → under lean, actual under → WIN  (green)
//   proj  6, line 7.5, actual 9 → under lean, actual over  → LOSS (red)
//   proj ≈ line (|proj − line| < threshold)                → no mark
//
// (This is NOT the de-vigged edge direction — that's a separate forward-looking
// pre-game signal.) Every stat only counts UP during a game, so a line already
// crossed (over) is LOCKED even mid-game; an actual still under the line is
// "alive" (the bet hasn't settled — could still cross) while live, and is only
// graded win/loss once the game is final.
type LeanGrade = "win" | "loss" | "push" | "alive" | "none";
function gradeLean(
  projection: number,
  line: number,
  actual: number,
  isFinal: boolean,
): LeanGrade {
  const leanDiff = projection - line;
  if (Math.abs(leanDiff) < LINE_LEAN_THRESHOLD) return "none"; // model had no lean (≈ /results skip)
  const leanOver = leanDiff > 0;
  if (actual > line) return leanOver ? "win" : "loss"; // over the line — locked even live
  if (actual < line) {
    if (!isFinal) return "alive"; // could still cross the line
    return leanOver ? "loss" : "win";
  }
  return isFinal ? "push" : "alive"; // actual === line
}
function gradeTextColor(g: LeanGrade): string {
  return g === "win" ? "text-emerald-400" : g === "loss" ? "text-red-400" : "text-slate-200";
}

// Whether a prop's actual can no longer change (so a sub-line result is decided,
// not "alive"). Most props lock only at final; the 1st-inning props lock the
// moment the 1st inning ends — even while the game continues — so their result
// shows as soon as the game reaches the 2nd.
const FIRST_INNING_PROPS = new Set<PropType>([
  "pitcher_first_inning_pitches",
  "pitcher_first_inning_strikeouts",
]);
function actualLocked(prop: PropType, status: GameStatus | undefined): boolean {
  if (status?.state === "final") return true;
  if (FIRST_INNING_PROPS.has(prop)) return (status?.currentInning ?? 0) >= 2;
  return false;
}

// Map each SIMPLE prop type to the StatLine field it reads. Fantasy-score
// props are computed across multiple StatLine fields, not mapped 1:1 here —
// handled in liveActualFor below.
const PROP_STAT_KEY: Partial<Record<PropType, keyof StatLine>> = {
  strikeouts:         "strikeOuts",
  hits_allowed:       "hitsAllowed",
  walks:              "baseOnBalls",
  earned_runs:        "earnedRuns",
  outs_recorded:      "outs",
  hitter_hits:        "hits",
  hitter_total_bases: "totalBases",
  hitter_rbis:        "rbi",
  hitter_runs:        "runs",
  hitter_home_runs:   "homeRuns",
};

// Compute the live actual for the active prop from a single StatLine row.
// Returns undefined when the player hasn't accumulated any of the required
// fields yet (e.g. hasn't batted; hasn't taken the mound). For fantasy-score
// props we synthesize from components via the shared scoring constants.
//
// Pitcher fantasy score during LIVE games intentionally omits the W and QS
// bonuses -- both are not final until the game ends. Once isFinal=true the
// QS bonus is included (derivable from outs + ER). The W bonus stays omitted
// because the box score doesn't carry the decision; the user accepts the
// same ~6-FP-low bias the baseline projection already has.
function liveActualFor(
  propType: PropType,
  stat: StatLine | undefined,
  isFinal: boolean,
  firstInning?: FirstInningGame,
  playerId?: number,
): number | undefined {
  // 1st-inning pitcher props come from the play-by-play (the boxscore carries
  // only game totals), keyed by personId in the firstInning map. Checked before
  // the StatLine guard so they work even when a player has no boxscore line yet.
  if (propType === "pitcher_first_inning_pitches") {
    return playerId !== undefined ? firstInning?.pitches.get(playerId) : undefined;
  }
  if (propType === "pitcher_first_inning_strikeouts") {
    return playerId !== undefined ? firstInning?.strikeouts.get(playerId) : undefined;
  }

  if (!stat) return undefined;

  if (propType === "hitter_fantasy_score") {
    if (stat.hits === undefined) return undefined;
    return hitterFantasyScore({
      hits:        stat.hits,
      doubles:     stat.doubles ?? 0,
      triples:     stat.triples ?? 0,
      homeRuns:    stat.homeRuns ?? 0,
      runs:        stat.runs ?? 0,
      rbis:        stat.rbi ?? 0,
      walks:       stat.baseOnBalls ?? 0,
      hitByPitch:  stat.hitByPitch ?? 0,
      stolenBases: stat.stolenBases ?? 0,
    });
  }

  // Combo prop: hits + runs + RBIs, synthesized from the box-score line.
  if (propType === "hitter_hits_runs_rbis") {
    if (stat.hits === undefined) return undefined;
    return (stat.hits ?? 0) + (stat.runs ?? 0) + (stat.rbi ?? 0);
  }

  if (propType === "pitcher_fantasy_score") {
    if (stat.outs === undefined) return undefined;
    const outs = stat.outs;
    const er = stat.earnedRuns ?? 0;
    let fp =
      outs * PITCHER_OUT_PTS +
      (stat.strikeOuts ?? 0) * PITCHER_STRIKEOUT_PTS +
      er * PITCHER_EARNED_RUN_PTS;
    if (isFinal && isQualityStart(outs, er)) {
      fp += PITCHER_QUALITY_START_PTS;
    }
    return fp;
  }

  const key = PROP_STAT_KEY[propType];
  if (!key) return undefined;
  return stat[key] as number | undefined;
}

// Render the right-side badge. When a live actual exists, show "{actual} {unit}
// · proj {projection}"; otherwise just the projection (existing behavior).
function ProjectionBadge({
  pitcher,
  unit,
  liveActual,
  locked,
}: {
  pitcher: Pitcher;
  unit: string;
  liveActual: number | undefined;
  locked: boolean;
}) {
  if (liveActual === undefined) {
    return (
      <span className="ml-3 shrink-0 rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400 tabular-nums">
        {pitcher.projection.toFixed(1)} {unit}
      </span>
    );
  }
  // Color the actual by whether the projection's lean vs the line is winning
  // (same grading as /results), not by raw actual-vs-projection — so a high ER
  // on an under lean reads red, not green. `locked` = the actual can't change
  // anymore (game final, or 1st inning over for the 1st-inning props).
  const g =
    pitcher.line !== undefined
      ? gradeLean(pitcher.projection, pitcher.line, liveActual, locked)
      : "none";
  const color = g === "win" ? "text-emerald-400" : g === "loss" ? "text-red-400" : "text-slate-300";
  return (
    <span className="ml-3 shrink-0 rounded-md bg-slate-800/80 px-2.5 py-1 text-sm font-semibold tabular-nums">
      <span className={color}>
        {liveActual} {unit}
      </span>
      {g === "win" && <span className="ml-1 text-emerald-400">✓</span>}
      {g === "loss" && <span className="ml-1 text-red-400">✗</span>}
      <span className="ml-1.5 font-normal text-slate-500">
        · proj {pitcher.projection.toFixed(1)}
      </span>
    </span>
  );
}

// American odds → implied probability (with vig). −120 → 0.545, +110 → 0.476.
function americanToImplied(price: number): number {
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

// ── edge / result sub-component ─────────────────────────────────────────────
// Pure display. Pre-game it shows the line + de-vigged edge (forward-looking).
// Once the game has started (an `actual` is passed) it switches to the RESULT:
// the projection's lean vs the line and whether it hit — the same grading as
// /results, since the pre-game edge arrow is stale once the game is underway.

function EdgeDetail({
  pitcher,
  actual,
  isFinal,
}: {
  pitcher: Pitcher;
  actual?: number;
  isFinal?: boolean;
}) {
  // No line for this player → render nothing (the common case).
  if (pitcher.line === undefined) {
    return null;
  }

  // ── POST-GAME / LIVE: proj-vs-line LEAN + result (mirrors /results) ──
  if (actual !== undefined) {
    const g = gradeLean(pitcher.projection, pitcher.line, actual, !!isFinal);
    let node;
    if (g === "none") {
      node = <span className="text-slate-500">~Even (no lean)</span>;
    } else {
      const leanOver = pitcher.projection - pitcher.line > 0;
      const leanLabel = leanOver ? "▲ Over" : "▼ Under";
      const leanColor = leanOver ? "text-emerald-400/70" : "text-red-400/70";
      const result =
        g === "win" ? (
          <span className="text-emerald-400">✓ hit</span>
        ) : g === "loss" ? (
          <span className="text-red-400">✗ miss</span>
        ) : g === "push" ? (
          <span className="text-slate-500">push</span>
        ) : (
          <span className="text-slate-500">live</span>
        );
      node = (
        <>
          <span className={leanColor}>proj {leanLabel}</span>
          <span className="mx-1.5 text-slate-600">·</span>
          {result}
        </>
      );
    }
    return (
      <div className="mt-1 text-xs tabular-nums">
        <span className="text-slate-500">Line {pitcher.line}</span>
        <span className="mx-1.5 text-slate-600">·</span>
        {node}
      </div>
    );
  }

  // Two-sided book line WITH a de-vigged edge (every prop tab except the two
  // fantasy-score props): show "Line X · ▲ Edge ±Y" as before.
  if (pitcher.edge !== undefined) {
    const edge = pitcher.edge;
    const signed = `${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(2)}`;

    let edgeNode;
    if (edge > EDGE_THRESHOLD) {
      edgeNode = <span className="text-emerald-400">▲ Edge {signed}</span>;
    } else if (edge < -EDGE_THRESHOLD) {
      edgeNode = <span className="text-red-400">▼ Edge {signed}</span>;
    } else {
      edgeNode = <span className="text-slate-500">~Even</span>;
    }

    return (
      <>
        <div className="mt-1 text-xs tabular-nums">
          <span className="text-slate-500">Line {pitcher.line}</span>
          <span className="mx-1.5 text-slate-600">·</span>
          {edgeNode}
        </div>
        {/* De-vig (sharp books): the market's no-vig fair % for the over vs the
            book's raw implied % (with vig). The gap is the juice; the edge above
            is the model vs Fair. For a PrizePicks DFS line the "fair" is a flat
            ~50% coin flip, so instead of a redundant "Fair 50% · Book 50%" we
            show the model's no-vig probability of the leaned side. */}
        {pitcher.bookmaker === "prizepicks" ? (
          pitcher.modelOverProb !== undefined && (
            <div
              className="mt-0.5 text-[10px] tabular-nums text-slate-500"
              title="Model's no-vig probability of this side. PrizePicks posts a flat pick'em (~50% implied), so the edge is the model beating that coin flip."
            >
              model{" "}
              <span className="text-slate-300">
                {Math.round(
                  (edge >= 0 ? pitcher.modelOverProb : 1 - pitcher.modelOverProb) * 100,
                )}
                %
              </span>{" "}
              {edge >= 0 ? "over" : "under"} PrizePicks line
            </div>
          )
        ) : (
          pitcher.fairOverProb !== undefined && (
            <div
              className="mt-0.5 text-[10px] tabular-nums text-slate-500"
              title="Fair = de-vigged (no-vig) market probability of the over. Book = the over price's raw implied probability (includes the vig)."
            >
              Fair{" "}
              <span className="text-slate-300">{Math.round(pitcher.fairOverProb * 100)}%</span>
              {pitcher.overPrice !== undefined && (
                <>
                  <span className="mx-1 text-slate-600">·</span>
                  Book {Math.round(americanToImplied(pitcher.overPrice) * 100)}%
                </>
              )}
            </div>
          )
        )}
      </>
    );
  }

  // Line present but NO edge — the PrizePicks fantasy-score case. DFS lines
  // carry no two-sided vig to de-vig, so there's no edge number; instead we
  // surface the model's LEAN vs the line (the exact proj-vs-line comparison
  // the /results page scores: over if proj > line, under if proj < line).
  // This is the same correctness rule used to grade these props on /results,
  // shown live on the board.
  const diff = pitcher.projection - pitcher.line;
  let leanNode;
  if (diff > LINE_LEAN_THRESHOLD) {
    leanNode = <span className="text-emerald-400">▲ Over</span>;
  } else if (diff < -LINE_LEAN_THRESHOLD) {
    leanNode = <span className="text-red-400">▼ Under</span>;
  } else {
    leanNode = <span className="text-slate-500">~Even</span>;
  }

  return (
    <div className="mt-1 text-xs tabular-nums">
      <span className="text-slate-500">Line {pitcher.line}</span>
      <span className="mx-1.5 text-slate-600">·</span>
      {leanNode}
    </div>
  );
}

// ── confidence bar sub-component ─────────────────────────────────────────────
// Renders only when confidence is defined (not undefined/null). Shows nothing
// for the vast majority of players who don't yet have enough graded history.

function ConfidenceBar({ confidence }: { confidence: number | undefined }) {
  if (confidence === undefined) return null;

  const pct = Math.round(confidence * 100);
  const filled = Math.round(confidence * 10);   // 0–10 filled blocks out of 10

  // Color thresholds: <40% red, 40–60% slate, >60% emerald.
  let barColor: string;
  let textColor: string;
  if (confidence < 0.4) {
    barColor = "bg-red-500/60";
    textColor = "text-red-400";
  } else if (confidence <= 0.6) {
    barColor = "bg-slate-500/60";
    textColor = "text-slate-400";
  } else {
    barColor = "bg-emerald-500/60";
    textColor = "text-emerald-400";
  }

  return (
    <div className="mt-1.5 flex items-center gap-2">
      {/* segmented bar: 10 equal blocks */}
      <div className="flex gap-px">
        {Array.from({ length: 10 }, (_, i) => (
          <div
            key={i}
            className={[
              "h-1.5 w-3 rounded-sm",
              i < filled ? barColor : "bg-slate-700",
            ].join(" ")}
          />
        ))}
      </div>
      <span className={`text-xs tabular-nums ${textColor}`}>
        {pct}% hit rate
      </span>
    </div>
  );
}

// ── hit-rate trends row (props.cash-style) ───────────────────────────────────
// Focused-card ONLY (the deep-dive view), so it adds nothing to the dense scan
// grid. One quiet tabular line: L5 / L10 / L15 / SZN over-rate vs the line, the
// recent-avg-minus-line gap, and the current streak. Each window tones emerald
// (lean-over ≥60%), red (≤40%), else slate — same restrained palette as the
// rest of the card. Returns null when there's no trend data.
function trendTone(pct: number): string {
  return pct >= 0.6 ? "text-emerald-400/80" : pct <= 0.4 ? "text-red-400/80" : "text-slate-300";
}
function TrendCell({ label, w }: { label: string; w: TrendWindow | undefined }) {
  if (!w) return null;
  return (
    <span title={`${w.over}/${w.total} over the line in the ${label}`}>
      <span className="text-slate-600">{label} </span>
      <span className={`tabular-nums ${trendTone(w.pct)}`}>{Math.round(w.pct * 100)}</span>
    </span>
  );
}
function TrendRow({ trends }: { trends: Trends | undefined }) {
  if (!trends) return null;
  const { l5, l10, l15, szn, diff, streak } = trends;
  if (!l5 && !l10 && !l15 && !szn) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
      <span className="text-[9px] uppercase tracking-wider text-slate-600">Hit&nbsp;%</span>
      <TrendCell label="L5" w={l5} />
      <TrendCell label="L10" w={l10} />
      <TrendCell label="L15" w={l15} />
      <TrendCell label="SZN" w={szn} />
      {diff !== undefined && (
        <span
          className="tabular-nums text-slate-500"
          title="Average over the last 10 games minus tonight's line"
        >
          ·{" "}
          <span className={diff > 0 ? "text-emerald-400/70" : diff < 0 ? "text-red-400/70" : ""}>
            {diff >= 0 ? "+" : "−"}
            {Math.abs(diff).toFixed(1)} vs line
          </span>
        </span>
      )}
      {streak !== undefined && Math.abs(streak) >= 2 && (
        <span
          className={`tabular-nums ${streak > 0 ? "text-emerald-400/70" : "text-red-400/70"}`}
          title={`On a ${Math.abs(streak)}-game ${streak > 0 ? "over" : "under"} streak`}
        >
          · {streak > 0 ? "▲" : "▼"}
          {Math.abs(streak)}
        </span>
      )}
    </div>
  );
}

// ── opposing-lineup context line (feature 4) ─────────────────────────────────
// Shows the opponent team's season K rate as "Facing a X% K lineup". Only the
// K% number carries a tone accent: league avg team K rate ~22%, so a high-K
// lineup (>=24%) is FAVORABLE for a strikeout over (emerald), a contact-heavy
// lineup (<=20%) is a TOUGHER matchup (amber — not red; it's not "bad", just
// harder). Rendered on the Strikeouts focus only. Renders nothing when kRate
// is missing — never "Facing a null% lineup".
function OppContextLine({ kRate }: { kRate: number | null | undefined }) {
  if (kRate === null || kRate === undefined) return null;

  const pct = kRate * 100;
  const toneColor =
    kRate >= 0.24
      ? "text-emerald-400/70"
      : kRate <= 0.2
        ? "text-amber-400/70"
        : "text-slate-400";

  return (
    <div
      className="mt-1 flex items-center gap-1.5 overflow-hidden text-[10px] text-slate-500"
      title={`Opponent team strikeout rate: ${pct.toFixed(1)}% (league avg ~22%). Higher = more strikeout-prone.`}
    >
      <span className="text-[9px] uppercase tracking-wider text-slate-600">
        VS
      </span>
      <span className="truncate">
        Facing a{" "}
        <span className={`tabular-nums ${toneColor}`}>{pct.toFixed(1)}%</span> K
        lineup
      </span>
    </div>
  );
}

// Wind tag line for total-bases cards (hitter_total_bases focus ONLY). Same
// arrow + mph + direction + colors as the HR cards (out=green, in=red,
// cross=slate). Returns null when there's no usable wind (calm / unknown
// bearing / no data) — the game header already carries the static park label.
function WindCardLine({
  homeTeam,
  windSpeed,
  windDirDeg,
  isDome,
}: {
  homeTeam: string;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
}) {
  const wc = windClause({ homeTeam, windSpeed, windDirDeg, isDome });
  if (!wc) return null;
  return (
    <div className="mt-1 text-[11px] font-medium leading-tight" title={wc.tooltip}>
      <span className={wc.tone}>
        {wc.arrow ? `${wc.arrow} ` : ""}
        {wc.text}
      </span>
    </div>
  );
}

// ── game header bits ─────────────────────────────────────────────────────────

function LiveDot() {
  // Tailwind's animate-ping gives a built-in expanding-ring pulse.
  // Two layers: a static solid dot + an animated ring on top.
  return (
    <span className="relative inline-flex h-2 w-2" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

function Score({ status }: { status: GameStatus }) {
  const a = status.awayScore ?? 0;
  const h = status.homeScore ?? 0;
  return (
    <span className="tabular-nums text-slate-300">
      {status.awayAbbr} {a} @ {status.homeAbbr} {h}
    </span>
  );
}

function StatusLine({ status }: { status: GameStatus | undefined }) {
  if (!status) return null;

  if (status.state === "live") {
    return (
      <span className="flex items-center gap-1.5">
        <LiveDot />
        <span className="font-semibold tracking-wide text-emerald-400">LIVE</span>
        <span className="text-slate-600">·</span>
        <Score status={status} />
        {status.inningOrdinal && (
          <>
            <span className="text-slate-600">·</span>
            <span className="text-slate-300">
              ▶ {status.inningHalf === "Top" ? "▲" : status.inningHalf === "Bottom" ? "▼" : ""}{" "}
              {status.inningOrdinal}
            </span>
          </>
        )}
      </span>
    );
  }

  if (status.state === "final") {
    return (
      <span className="flex items-center gap-1.5">
        <span className="font-medium text-slate-300">Final</span>
        <span className="text-slate-600">·</span>
        <Score status={status} />
      </span>
    );
  }

  if (status.state === "scheduled") {
    return <span>{status.startTimeET ?? "Scheduled"}</span>;
  }

  // "other" — postponed, delayed, etc. Show the raw detailedState if we have it.
  return <span>{status.detailedState || "—"}</span>;
}

// ── game-first data model ────────────────────────────────────────────────────
// The DB feeds prop -> game -> [player rows]. To browse GAME-first we invert it
// into game -> {pitchers, hitters} where each player carries ALL their props.
// Pure client-side restructure of the existing byProp payload — page.tsx and
// the queries are untouched; the frontend still does ZERO projection math.

type PlayerRow = {
  player_id: number;
  name: string;
  kind: "pitcher" | "hitter";
  props: Partial<Record<PropType, Pitcher>>;
};

type GameView = {
  game_id: number;
  matchup: string;
  startTime: string | null;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
  firstInningRuns?: number;   // P(YRFI) — game-level NRFI/YRFI read
  pitchers: PlayerRow[];
  hitters: PlayerRow[];
};

// Classify one player+prop row's edge/lean — the single source the chips, the
// collapsed summary, the "has edge" filter, and the hitter ordering all share.
//
// IMPORTANT: only a REAL two-sided book edge (pinnacle/draftkings/fanduel/
// bet365/caesars — the REAL_BOOKS set, same standard Featured Plays uses) counts
// as an "edge" (qualifiesEdge) for the structural decisions (best-play, ordering,
// hitters-with-edges). Two weaker signals are SHOWN on the chip but never drive
// those decisions:
//   * CONSENSUS edges (qualifiesConsensus) — de-vigged against a synthetic
//     consensus line, not a real book. These inflate (a hitter HR can read
//     +0.85) and would dominate the headline if counted.
//   * DFS fantasy LEANS (qualifiesLean) — proj-vs-line in fantasy POINTS
//     (|proj−line| can be ~25), not comparable to an edge probability (~0–0.6).
// Letting either in made every game's headline a fantasy/consensus play with
// absurd "+50 more" counts.
type RowEval = {
  hasLine: boolean;
  isEdge: boolean; // a de-vigged edge number exists (real OR consensus)
  isRealBook: boolean; // the edge's baseline book is in REAL_BOOKS
  edge?: number;
  magnitude: number; // |edge| for edges — the only cross-prop-comparable signal
  direction: "over" | "under" | "even";
  qualifiesEdge: boolean; // real-book edge over threshold — the structural "edge"
  qualifiesConsensus: boolean; // consensus edge over threshold — chip number only (muted)
  qualifiesLean: boolean; // DFS lean over threshold — chip arrow only
};
function evalRow(row: Pitcher, prop: PropType): RowEval {
  if (row.line === undefined) {
    return {
      hasLine: false,
      isEdge: false,
      isRealBook: false,
      magnitude: 0,
      direction: "even",
      qualifiesEdge: false,
      qualifiesConsensus: false,
      qualifiesLean: false,
    };
  }
  if (row.edge !== undefined) {
    const mag = Math.abs(row.edge);
    const isRealBook = !!row.bookmaker && REAL_BOOKS.includes(row.bookmaker);
    const overThresh = mag > EDGE_THRESHOLD;
    // A real edge must also be on the prop's MAIN market line — the same floor
    // /results + Featured Plays use — so low-value alt lines (e.g. a 0.5
    // total-bases alt) and the noisy non-betting props (earned_runs/walks, which
    // aren't in MIN_LINE) never show as hot edges or top the sort. The number is
    // still shown MUTED below; it just doesn't count as a structural edge.
    const floor = MIN_LINE[prop];
    const meetsFloor = floor !== undefined && (row.line as number) >= floor;
    return {
      hasLine: true,
      isEdge: true,
      isRealBook,
      edge: row.edge,
      magnitude: mag,
      direction: row.edge > EDGE_THRESHOLD ? "over" : row.edge < -EDGE_THRESHOLD ? "under" : "even",
      qualifiesEdge: overThresh && isRealBook && meetsFloor,
      qualifiesConsensus: overThresh && !isRealBook,
      qualifiesLean: false,
    };
  }
  const diff = row.projection - row.line;
  const mag = Math.abs(diff);
  return {
    hasLine: true,
    isEdge: false,
    isRealBook: false,
    magnitude: mag,
    direction: diff > LINE_LEAN_THRESHOLD ? "over" : diff < -LINE_LEAN_THRESHOLD ? "under" : "even",
    qualifiesEdge: false,
    qualifiesConsensus: false,
    qualifiesLean: mag > LINE_LEAN_THRESHOLD,
  };
}

function playerHasEdge(pl: PlayerRow): boolean {
  return PROPS.some((p) => {
    const r = pl.props[p.key];
    return !!r && evalRow(r, p.key).qualifiesEdge;
  });
}

function playerBestMag(pl: PlayerRow): number {
  let m = 0;
  for (const p of PROPS) {
    const r = pl.props[p.key];
    if (r) {
      const e = evalRow(r, p.key);
      if (e.qualifiesEdge && e.magnitude > m) m = e.magnitude;
    }
  }
  return m;
}

function buildGameViews(byProp: ByProp): GameView[] {
  const games = new Map<number, { meta: GameGroup; players: Map<number, PlayerRow> }>();

  for (const { key: prop } of PROPS) {
    const kind: "pitcher" | "hitter" = HITTER_PROPS.has(prop) ? "hitter" : "pitcher";
    for (const g of byProp[prop] ?? []) {
      let entry = games.get(g.game_id);
      if (!entry) {
        entry = { meta: g, players: new Map() };
        games.set(g.game_id, entry);
      }
      for (const p of g.pitchers) {
        let pr = entry.players.get(p.player_id);
        if (!pr) {
          pr = { player_id: p.player_id, name: p.name, kind, props: {} };
          entry.players.set(p.player_id, pr);
        }
        pr.props[prop] = p;
      }
    }
  }

  const out: GameView[] = [];
  for (const { meta, players } of games.values()) {
    const pitchers: PlayerRow[] = [];
    const hitters: PlayerRow[] = [];
    for (const pr of players.values()) {
      (pr.kind === "pitcher" ? pitchers : hitters).push(pr);
    }
    // Strongest edge first within each section (so the edge plays lead).
    const byMag = (a: PlayerRow, b: PlayerRow) => playerBestMag(b) - playerBestMag(a);
    pitchers.sort(byMag);
    hitters.sort(byMag);
    out.push({
      game_id: meta.game_id,
      matchup: meta.matchup,
      startTime: meta.startTime,
      windSpeed: meta.windSpeed,
      windDirDeg: meta.windDirDeg,
      isDome: meta.isDome,
      firstInningRuns: meta.firstInningRuns,
      pitchers,
      hitters,
    });
  }
  return out;
}

// ── per-game summary (collapsed row) ─────────────────────────────────────────

type BestPlay = {
  name: string;
  propShort: string;
  line: number;
  edge?: number; // undefined for DFS lean-only props
  direction: "over" | "under" | "even";
};

type GameSummary = {
  bestPlay: BestPlay | null; // strongest qualifying play (null = none qualify)
  qualifyingCount: number;
  hasAnyLine: boolean;
  topMagnitude: number; // strongest qualifying |edge| in the game (0 = none) — for sorting
};

// Summarize a game for its collapsed row. In "all" mode this scans every prop
// of every player; focused on a prop, it scans only that prop.
function summarizeGameView(gv: GameView, focus: PropType | "all"): GameSummary {
  let bestPlay: BestPlay | null = null;
  let bestMag = -1;
  let qualifyingCount = 0;
  let hasAnyLine = false;

  const consider = (prop: PropType, row: Pitcher) => {
    if (row.line === undefined) return;
    hasAnyLine = true;
    const e = evalRow(row, prop);
    if (e.qualifiesEdge) {
      qualifyingCount += 1;
      if (e.magnitude > bestMag) {
        bestMag = e.magnitude;
        bestPlay = {
          name: row.name,
          propShort: PROP_META[prop].short,
          line: row.line,
          edge: e.edge,
          direction: e.direction,
        };
      }
    }
  };

  if (focus === "all") {
    for (const pl of gv.pitchers) for (const p of PITCHER_PROP_KEYS) {
      const r = pl.props[p];
      if (r) consider(p, r);
    }
    for (const pl of gv.hitters) for (const p of HITTER_PROP_KEYS) {
      const r = pl.props[p];
      if (r) consider(p, r);
    }
  } else {
    const players = HITTER_PROPS.has(focus) ? gv.hitters : gv.pitchers;
    for (const pl of players) {
      const r = pl.props[focus];
      if (r) consider(focus, r);
    }
  }

  return { bestPlay, qualifyingCount, hasAnyLine, topMagnitude: Math.max(bestMag, 0) };
}

// Does a game match the search query (player name or either team)?
function gameMatchesQuery(gv: GameView, q: string): boolean {
  if (!q) return true;
  if (gv.matchup.toLowerCase().includes(q)) return true;
  return [...gv.pitchers, ...gv.hitters].some((pl) =>
    pl.name.toLowerCase().includes(q),
  );
}

// Today's live model record across FINAL games on this slate — counts each
// graded prop (line present + final actual) as a win/loss via the same gradeLean
// the chips use. Pushes/no-lean are excluded. Returns null when nothing is
// graded yet so the banner stays hidden.
function computeSlateRecord(
  games: GameView[],
  liveStatus: Map<number, GameStatus>,
  liveStats: Map<number, Map<number, StatLine>>,
  firstInningStats: FirstInningMap,
): { wins: number; losses: number } | null {
  let wins = 0;
  let losses = 0;
  for (const gv of games) {
    if (liveStatus.get(gv.game_id)?.state !== "final") continue;
    const stats = liveStats.get(gv.game_id);
    const fi = firstInningStats.get(gv.game_id);
    for (const pl of [...gv.pitchers, ...gv.hitters]) {
      for (const prop of PROPS) {
        const row = pl.props[prop.key];
        if (!row || row.line === undefined) continue;
        const actual = liveActualFor(
          prop.key,
          stats?.get(pl.player_id),
          true,
          fi,
          pl.player_id,
        );
        if (actual === undefined) continue;
        const g = gradeLean(row.projection, row.line, actual, true);
        if (g === "win") wins += 1;
        else if (g === "loss") losses += 1;
      }
    }
  }
  return wins + losses > 0 ? { wins, losses } : null;
}

// Default open/closed: a game with a qualifying edge starts EXPANDED (its plays
// are why you opened the app); an all-even game collapses to a thin row; final
// games collapse (they're results — /results covers that view).
function defaultExpanded(summary: GameSummary, status: GameStatus | undefined): boolean {
  if (status?.state === "final") return false;
  return summary.qualifyingCount > 0;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-1 inline-block shrink-0 text-[10px] text-slate-500 transition-transform ${
        expanded ? "rotate-90" : ""
      }`}
    >
      ▶
    </span>
  );
}

// One-line summary shown when a game is collapsed: its single best play inline
// (name · prop line · edge/lean) + a "+N more" count. Falls back to a muted
// "No edge" / "No lines yet" so a collapsed game is never blank.
function CollapsedSummary({ summary }: { summary: GameSummary }) {
  const { bestPlay, qualifyingCount, hasAnyLine } = summary;

  if (!bestPlay) {
    return (
      <div className="mt-1.5 pl-5 text-xs text-slate-600">
        {hasAnyLine ? "No edge" : "No lines yet"}
      </div>
    );
  }

  const arrow =
    bestPlay.direction === "over" ? "▲" : bestPlay.direction === "under" ? "▼" : "";
  const tone =
    bestPlay.direction === "over"
      ? "text-emerald-400"
      : bestPlay.direction === "under"
        ? "text-red-400"
        : "text-slate-500";
  const value =
    bestPlay.edge !== undefined
      ? `${bestPlay.edge >= 0 ? "+" : "−"}${Math.abs(bestPlay.edge).toFixed(2)}`
      : bestPlay.direction === "over"
        ? "Over"
        : "Under";

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-xs tabular-nums">
      <span className="font-medium text-slate-200">{bestPlay.name}</span>
      <span className="text-slate-500">
        {bestPlay.propShort} {fmt(bestPlay.line)}
      </span>
      <span className={`font-semibold ${tone}`}>
        {arrow} {value}
      </span>
      {qualifyingCount > 1 && (
        <span className="text-slate-600">+{qualifyingCount - 1} more</span>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="bg-slate-900/40 px-5 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
      {children}
    </div>
  );
}

// ── all-props matrix: one compact chip per (player, prop) ─────────────────────
// label + projection (or live actual), tinted/badged when the model has an
// edge. Tapping a chip FOCUSES that prop (switches the filter), which reveals
// the rich per-prop context (confidence, recent form, sharp agreement, etc.).
// The chip is PHASE-AWARE — it shows different things before vs during vs after
// a game (a finished game's pre-game edge arrow is stale; what matters then is
// actual vs the line and whether the play hit):
//   * pre-game (live === undefined): projection + the edge/consensus/lean badge,
//     with a colored border tint on real edges so you can scan for them.
//   * live: actual-so-far · line (the target), pace-colored, no verdict yet.
//   * final: actual · line + a ✓/✗ on whether the model's lean won. Color of the
//     actual = won (emerald) / lost (red) / push or no-lean (slate).
function PropChip({
  prop,
  row,
  live,
  locked,
  active,
  onTap,
}: {
  prop: PropType;
  row: Pitcher;
  live: number | undefined;
  locked: boolean;       // actual can't change anymore (final, or 1st inning over)
  active: boolean;       // this chip's inline detail is open
  onTap: () => void;
}) {
  const meta = PROP_META[prop];
  const e = evalRow(row, prop);
  const hasLine = row.line !== undefined;

  let valueText: string;
  let valueColor = "text-slate-200";
  let trailing: JSX.Element | null = null;
  let tint = "border-slate-700/70 bg-slate-800/40";

  if (live === undefined) {
    // ── pre-game (or a player who hasn't accumulated yet): projection + edge ──
    valueText = fmt(row.projection);
    if (e.qualifiesEdge && e.edge !== undefined) {
      // Real-book de-vigged edge — colored chip + signed number (the eye-catcher).
      const signed = `${e.edge >= 0 ? "+" : "−"}${Math.abs(e.edge).toFixed(2)}`;
      if (e.direction === "over") {
        trailing = <span className="text-emerald-400">▲{signed}</span>;
        tint = "border-emerald-500/40 bg-emerald-500/10";
      } else if (e.direction === "under") {
        trailing = <span className="text-red-400">▼{signed}</span>;
        tint = "border-red-500/40 bg-red-500/10";
      }
    } else if (e.edge !== undefined) {
      // A de-vigged edge that doesn't structurally qualify — consensus line OR a
      // real-book edge below the prop's main-line floor (e.g. a 0.5 TB alt).
      // Shown as a number but MUTED, no tint, so it never reads as a hot edge.
      const signed = `${e.edge >= 0 ? "+" : "−"}${Math.abs(e.edge).toFixed(2)}`;
      trailing = (
        <span className="text-slate-400">
          {e.direction === "over" ? "▲" : e.direction === "under" ? "▼" : ""}
          {signed}
        </span>
      );
    } else if (e.qualifiesLean) {
      // DFS (PrizePicks fantasy) lean — muted ARROW only.
      if (e.direction === "over") trailing = <span className="text-emerald-400/70">▲</span>;
      else if (e.direction === "under") trailing = <span className="text-red-400/70">▼</span>;
    }
  } else {
    // ── game started (live OR final): grade the projection's lean vs the line,
    //    exactly like /results. Actual is colored win/loss; ✓/✗ once the play is
    //    decided (line crossed, or final). An "alive" play stays neutral. ──
    valueText = fmt(live);
    if (hasLine) {
      const line = row.line as number;
      const g = gradeLean(row.projection, line, live, locked);
      valueColor = gradeTextColor(g);
      trailing = (
        <>
          <span className="text-slate-500">· {fmt(line)}</span>
          {g === "win" && <span className="text-emerald-400">✓</span>}
          {g === "loss" && <span className="text-red-400">✗</span>}
        </>
      );
    }
    // no line → neutral actual, no benchmark to grade against
  }

  const title =
    `${meta.label}` +
    `${hasLine ? ` · line ${row.line}` : " · no line"}` +
    `${row.edge !== undefined && row.bookmaker ? ` (${row.bookmaker})` : ""}` +
    `${live !== undefined ? ` · actual ${fmt(live)}` : ` · proj ${fmt(row.projection)}`}` +
    `${active ? " — tap to close" : " — tap for detail"}`;

  return (
    <button
      type="button"
      onClick={onTap}
      title={title}
      className={[
        "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums transition hover:brightness-125",
        tint,
        active ? "ring-1 ring-emerald-400/60" : "",
      ].join(" ")}
    >
      <span className="text-slate-500">{meta.short}</span>
      <span className={`font-semibold ${valueColor}`}>{valueText}</span>
      {/* pre-game: show the line next to the projection so the board reads as
          proj-vs-line at a glance (live/final already show actual·line). */}
      {live === undefined && hasLine && (
        <span className="text-slate-500">· {fmt(row.line as number)}</span>
      )}
      {trailing}
    </button>
  );
}

// ── inline prop detail (props.cash-style detail-on-demand) ───────────────────
// Opens directly under a player's chip row when a chip is tapped — so you get
// the full play detail (Fair%/Book%, edge, trends, confidence, sharp badge, live
// pace) WITHOUT leaving the All-props overview. Only one is open board-wide at a
// time (clean, never congests). Composes the same leaf components the focused
// card uses, so there's no logic duplication. "all <prop> →" jumps to the
// cross-game focused view for that prop.
function InlinePropDetail({
  player,
  prop,
  gameStats,
  status,
  firstInning,
  homeTeam,
  windSpeed,
  windDirDeg,
  isDome,
  onViewAll,
}: {
  player: PlayerRow;
  prop: PropType;
  gameStats: Map<number, StatLine> | undefined;
  status: GameStatus | undefined;
  firstInning?: FirstInningGame;
  homeTeam: string;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
  onViewAll: () => void;
}) {
  const row = player.props[prop];
  if (!row) return null;
  const isHitter = HITTER_PROPS.has(prop);
  const meta = PROP_META[prop];
  const showActual = status?.state === "live" || status?.state === "final";
  const liveActual = showActual
    ? liveActualFor(
        prop,
        gameStats?.get(player.player_id),
        status?.state === "final",
        firstInning,
        player.player_id,
      )
    : undefined;

  return (
    <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {meta.label}
            </span>
            {!isHitter && <SharpBadge sharp={row.sharpAgreement} />}
          </div>
          <EdgeDetail pitcher={row} actual={liveActual} isFinal={actualLocked(prop, status)} />
          <ConfidenceBar confidence={row.confidence} />
          <TrendRow trends={row.trends} />
          {prop === "strikeouts" && <OppContextLine kRate={row.oppContext?.kRate} />}
          {prop === "hitter_total_bases" && (
            <WindCardLine
              homeTeam={homeTeam}
              windSpeed={windSpeed}
              windDirDeg={windDirDeg}
              isDome={isDome}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ProjectionBadge
            pitcher={row}
            unit={meta.unit}
            liveActual={liveActual}
            locked={actualLocked(prop, status)}
          />
          <button
            type="button"
            onClick={onViewAll}
            className="text-[10px] text-slate-500 transition-colors hover:text-slate-300"
          >
            all {meta.short} →
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerChipsRow({
  player,
  propKeys,
  gameStats,
  status,
  firstInning,
  openDetail,
  onToggleDetail,
  onViewAll,
  homeTeam,
  windSpeed,
  windDirDeg,
  isDome,
}: {
  player: PlayerRow;
  propKeys: PropType[];
  gameStats: Map<number, StatLine> | undefined;
  status: GameStatus | undefined;
  firstInning?: FirstInningGame;
  openDetail: string | null;             // `${playerId}|${prop}` open board-wide
  onToggleDetail: (key: string) => void;
  onViewAll: (p: PropType) => void;
  homeTeam: string;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
}) {
  const showActual = status?.state === "live" || status?.state === "final";
  const isFinal = status?.state === "final";
  const stat = gameStats?.get(player.player_id);

  const chips = propKeys
    .map((prop) => ({ prop, row: player.props[prop] }))
    .filter((c): c is { prop: PropType; row: Pitcher } => !!c.row);

  if (chips.length === 0) return null;

  // Which of this player's props (if any) is the open inline detail.
  const openProp = chips.find(
    (c) => openDetail === `${player.player_id}|${c.prop}`,
  )?.prop;

  return (
    <li className="px-5 py-2.5">
      <div className="flex items-center gap-1.5 text-sm text-slate-100">
        <StarButton playerId={player.player_id} />
        <span>{player.name}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {chips.map(({ prop, row }) => {
          const live = showActual
            ? liveActualFor(prop, stat, !!isFinal, firstInning, player.player_id)
            : undefined;
          const key = `${player.player_id}|${prop}`;
          return (
            <PropChip
              key={prop}
              prop={prop}
              row={row}
              live={live}
              locked={actualLocked(prop, status)}
              active={openDetail === key}
              onTap={() => onToggleDetail(key)}
            />
          );
        })}
      </div>
      {openProp && (
        <InlinePropDetail
          player={player}
          prop={openProp}
          gameStats={gameStats}
          status={status}
          firstInning={firstInning}
          homeTeam={homeTeam}
          windSpeed={windSpeed}
          windDirDeg={windDirDeg}
          isDome={isDome}
          onViewAll={() => onViewAll(openProp)}
        />
      )}
    </li>
  );
}

// ── focused single-prop card (the rich per-prop view, preserved) ─────────────
// Identical to the old per-prop card: EdgeDetail line, confidence bar, recent
// form, opp-K context, wind tag, sharp badge, and the live/projection chip.
function FocusedPlayerCard({
  row,
  prop,
  isHitter,
  unit,
  gameStats,
  status,
  firstInning,
  homeTeam,
  windSpeed,
  windDirDeg,
  isDome,
}: {
  row: Pitcher;
  prop: PropType;
  isHitter: boolean;
  unit: string;
  gameStats: Map<number, StatLine> | undefined;
  status: GameStatus | undefined;
  firstInning?: FirstInningGame;
  homeTeam: string;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
}) {
  const showActual = status?.state === "live" || status?.state === "final";
  const liveActual = showActual
    ? liveActualFor(
        prop,
        gameStats?.get(row.player_id),
        status?.state === "final",
        firstInning,
        row.player_id,
      )
    : undefined;

  return (
    <li className="flex items-start justify-between px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StarButton playerId={row.player_id} />
          <span className="text-slate-100">{row.name}</span>
          {!isHitter && <SharpBadge sharp={row.sharpAgreement} />}
        </div>
        <EdgeDetail pitcher={row} actual={liveActual} isFinal={status?.state === "final"} />
        <ConfidenceBar confidence={row.confidence} />
        <TrendRow trends={row.trends} />
        {prop === "strikeouts" && <OppContextLine kRate={row.oppContext?.kRate} />}
        {prop === "hitter_total_bases" && (
          <WindCardLine
            homeTeam={homeTeam}
            windSpeed={windSpeed}
            windDirDeg={windDirDeg}
            isDome={isDome}
          />
        )}
      </div>
      <ProjectionBadge
        pitcher={row}
        unit={unit}
        liveActual={liveActual}
        locked={actualLocked(prop, status)}
      />
    </li>
  );
}

// ── one collapsible game card ────────────────────────────────────────────────
function GameCard({
  gv,
  summary,
  status,
  expanded,
  onToggle,
  focus,
  gameStats,
  firstInning,
  date,
  onFocus,
  openDetail,
  onToggleDetail,
  query,
}: {
  gv: GameView;
  summary: GameSummary;
  status: GameStatus | undefined;
  expanded: boolean;
  onToggle: () => void;
  focus: PropType | "all";
  gameStats: Map<number, StatLine> | undefined;
  firstInning?: FirstInningGame;
  date: string;
  onFocus: (p: PropType) => void;
  openDetail: string | null;
  onToggleDetail: (key: string) => void;
  query?: string;
}) {
  const [showAllHitters, setShowAllHitters] = useState(false);

  const homeTeam = gv.matchup.includes(" @ ") ? gv.matchup.split(" @ ")[1] : "";
  const wc = windClause({
    homeTeam,
    windSpeed: gv.windSpeed,
    windDirDeg: gv.windDirDeg,
    isDome: gv.isDome,
  });
  const parkShown = !!homeTeam && getParkProfile(homeTeam).direction !== "neutral";

  // Search: when a player name matches, narrow the lists to the matches (jump
  // straight to them); a team-only match shows the whole game. Force the card
  // open while searching so the matches are visible.
  const q = (query ?? "").trim().toLowerCase();
  const { has: isWatched, onlyWatched } = useContext(WatchlistCtx);
  // A player passes the active filters (search AND/OR watchlist). When either
  // filter is on, the card narrows to passing players and force-opens.
  const filtering = q.length > 0 || onlyWatched;
  const playerVisible = (pl: PlayerRow) =>
    (!q || pl.name.toLowerCase().includes(q)) &&
    (!onlyWatched || isWatched(pl.player_id));
  const matchedPitchers = filtering ? gv.pitchers.filter(playerVisible) : gv.pitchers;
  const matchedHitters = filtering ? gv.hitters.filter(playerVisible) : gv.hitters;
  const playerSearchHit =
    filtering && (matchedPitchers.length > 0 || matchedHitters.length > 0);
  const pitchersShown = playerSearchHit ? matchedPitchers : gv.pitchers;
  const hittersAll = playerSearchHit ? matchedHitters : gv.hitters;
  const open = expanded || filtering;

  const edgeHitters = hittersAll.filter(playerHasEdge);
  // Default-visible hitters: when searching, ALL matches (no folding); otherwise
  // those with a real edge, or (if none) the top few so the lineup is never an
  // empty section. The rest fold behind the "Show N more" expander.
  const defaultHitters = playerSearchHit
    ? hittersAll
    : edgeHitters.length > 0
      ? edgeHitters
      : hittersAll.slice(0, DEFAULT_HITTER_COUNT);
  const hittersToShow = showAllHitters ? hittersAll : defaultHitters;
  const moreHitters = hittersAll.length - defaultHitters.length;

  const isHitterFocus = focus !== "all" && HITTER_PROPS.has(focus);
  const focusedPlayers =
    focus === "all"
      ? []
      : (isHitterFocus ? hittersAll : pitchersShown).filter((pl) => pl.props[focus]);
  const focusUnit = focus !== "all" ? PROP_META[focus].unit : "";

  return (
    <section className="surface overflow-hidden rounded-2xl">
      {/* clickable header — role=button keeps the <h2> heading semantics. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={[
          "cursor-pointer px-5 py-3 transition-colors hover:bg-slate-900",
          open ? "border-b border-slate-800 bg-slate-900" : "",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <Chevron expanded={open} />
            <div className="min-w-0">
              <h2 className="font-semibold text-slate-200">{gv.matchup}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span>{formatShortDate(date)}</span>
                {status && <span className="text-slate-600">·</span>}
                <StatusLine status={status} />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
            <ParkTag homeTeam={homeTeam} />
            {parkShown && wc && <span className="text-[10px] text-slate-600">·</span>}
            {wc && (
              <span
                title={wc.tooltip}
                className={`text-[11px] font-medium tabular-nums ${wc.tone}`}
              >
                {wc.arrow ? `${wc.arrow} ` : ""}
                {wc.text}
              </span>
            )}
            {gv.firstInningRuns != null && (() => {
              const p = gv.firstInningRuns;          // P(YRFI), 0-1
              const modelYrfi = p >= 0.5;
              const sep = parkShown || wc ? (
                <span className="text-[10px] text-slate-600">·</span>
              ) : null;
              // Once the 1st inning is complete (final, or game has reached the
              // 2nd), show the ACTUAL NRFI/YRFI outcome + whether the model's
              // lean was right — same grading idea as the prop chips.
              const settled =
                status?.state === "final" || (status?.currentInning ?? 0) >= 2;
              const fiRuns = firstInning?.runs;
              if (settled && fiRuns != null) {
                const actualYrfi = fiRuns >= 1;
                const correct = actualYrfi === modelYrfi;
                return (
                  <>
                    {sep}
                    <span
                      title={`1st-inning runs: ${fiRuns} — model leaned ${modelYrfi ? "YRFI" : "NRFI"} (${correct ? "correct" : "miss"})`}
                      className={`text-[11px] font-medium tabular-nums ${correct ? "text-emerald-400" : "text-red-400"}`}
                    >
                      {actualYrfi ? "YRFI" : "NRFI"} {fiRuns}R {correct ? "✓" : "✗"}
                    </span>
                  </>
                );
              }
              const shown = Math.round((modelYrfi ? p : 1 - p) * 100);
              return (
                <>
                  {sep}
                  <span
                    title={`Model: ${Math.round(p * 100)}% chance a run scores in the 1st inning`}
                    className={`text-[11px] font-medium tabular-nums ${modelYrfi ? "text-amber-400" : "text-sky-400"}`}
                  >
                    {modelYrfi ? "YRFI" : "NRFI"} {shown}%
                  </span>
                </>
              );
            })()}
          </div>
        </div>
        {!open && <CollapsedSummary summary={summary} />}
      </div>

      {open &&
        (focus === "all" ? (
          <div>
            {pitchersShown.length > 0 && (
              <>
                <SectionLabel>Pitchers</SectionLabel>
                <ul className="divide-y divide-slate-800/60">
                  {pitchersShown.map((pl) => (
                    <PlayerChipsRow
                      key={pl.player_id}
                      player={pl}
                      propKeys={PITCHER_PROP_KEYS}
                      gameStats={gameStats}
                      status={status}
                      firstInning={firstInning}
                      openDetail={openDetail}
                      onToggleDetail={onToggleDetail}
                      onViewAll={onFocus}
                      homeTeam={homeTeam}
                      windSpeed={gv.windSpeed}
                      windDirDeg={gv.windDirDeg}
                      isDome={gv.isDome}
                    />
                  ))}
                </ul>
              </>
            )}
            {hittersAll.length > 0 && (
              <>
                <SectionLabel>
                  {playerSearchHit
                    ? "Hitters"
                    : !showAllHitters && moreHitters > 0 && edgeHitters.length > 0
                      ? "Hitters with edges"
                      : "Hitters"}
                </SectionLabel>
                {hittersToShow.length > 0 && (
                  <ul className="divide-y divide-slate-800/60">
                    {hittersToShow.map((pl) => (
                      <PlayerChipsRow
                        key={pl.player_id}
                        player={pl}
                        propKeys={HITTER_PROP_KEYS}
                        gameStats={gameStats}
                        status={status}
                        firstInning={firstInning}
                        openDetail={openDetail}
                        onToggleDetail={onToggleDetail}
                        onViewAll={onFocus}
                        homeTeam={homeTeam}
                        windSpeed={gv.windSpeed}
                        windDirDeg={gv.windDirDeg}
                        isDome={gv.isDome}
                      />
                    ))}
                  </ul>
                )}
                {moreHitters > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllHitters((v) => !v)}
                    className="w-full px-5 py-2 text-left text-xs font-medium text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-200"
                  >
                    {showAllHitters
                      ? "Show fewer hitters"
                      : `Show ${moreHitters} more hitter${moreHitters === 1 ? "" : "s"}`}
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800">
            {focusedPlayers.map((pl) => (
              <FocusedPlayerCard
                key={pl.player_id}
                row={pl.props[focus]!}
                prop={focus}
                isHitter={isHitterFocus}
                unit={focusUnit}
                gameStats={gameStats}
                status={status}
                firstInning={firstInning}
                homeTeam={homeTeam}
                windSpeed={gv.windSpeed}
                windDirDeg={gv.windDirDeg}
                isDome={gv.isDome}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}

// ── Board view: dense sortable table of every lined prop ─────────────────────
type BoardSortCol = "edge" | "model" | "proj" | "line" | "l10" | "player";

function l10Tone(pct: number): string {
  return pct >= 60 ? "text-emerald-400" : pct <= 40 ? "text-red-400" : "text-slate-300";
}

// The Edge column cell — real-book edge (colored signed), consensus (muted
// number), DFS lean (muted arrow), or — . Mirrors the chip's edge tiering.
function edgeCell(ev: ReturnType<typeof evalRow>): JSX.Element {
  if (ev.qualifiesEdge && ev.edge !== undefined) {
    const s = `${ev.edge >= 0 ? "+" : "−"}${Math.abs(ev.edge).toFixed(2)}`;
    return (
      <span className={ev.direction === "over" ? "text-emerald-400" : "text-red-400"}>
        {ev.direction === "over" ? "▲" : "▼"}
        {s}
      </span>
    );
  }
  if (ev.edge !== undefined) {
    // Non-qualifying edge (consensus, or real-book below the main-line floor) —
    // number shown muted so it never reads as a hot edge.
    return (
      <span className="text-slate-500">
        {`${ev.edge >= 0 ? "+" : "−"}${Math.abs(ev.edge).toFixed(2)}`}
      </span>
    );
  }
  if (ev.qualifiesLean) {
    return (
      <span className="text-slate-500">
        {ev.direction === "over" ? "▲" : ev.direction === "under" ? "▼" : ""}
      </span>
    );
  }
  return <span className="text-slate-600">—</span>;
}

function BoardTable({
  games,
  liveStatus,
  liveStats,
  firstInningStats,
  query,
  onOpenDrawer,
}: {
  games: GameView[];
  liveStatus: Map<number, GameStatus>;
  liveStats: Map<number, Map<number, StatLine>>;
  firstInningStats: FirstInningMap;
  query: string;
  onOpenDrawer: (t: DrawerTarget) => void;
}) {
  const [sortCol, setSortCol] = useState<BoardSortCol>("edge");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [edgesOnly, setEdgesOnly] = useState(false);
  const { has: isWatched, onlyWatched } = useContext(WatchlistCtx);

  const q = query.trim().toLowerCase();

  type Entry = {
    gv: GameView;
    player: PlayerRow;
    prop: PropType;
    row: Pitcher;
    status: GameStatus | undefined;
    ev: ReturnType<typeof evalRow>;
  };
  const entries: Entry[] = [];
  for (const gv of games) {
    const matchupHit = q ? gv.matchup.toLowerCase().includes(q) : false;
    const status = liveStatus.get(gv.game_id);
    const consider = (player: PlayerRow, keys: PropType[]) => {
      if (onlyWatched && !isWatched(player.player_id)) return;
      if (q && !matchupHit && !player.name.toLowerCase().includes(q)) return;
      for (const prop of keys) {
        const row = player.props[prop];
        if (!row || row.line === undefined) continue;
        entries.push({ gv, player, prop, row, status, ev: evalRow(row, prop) });
      }
    };
    for (const pl of gv.pitchers) consider(pl, PITCHER_PROP_KEYS);
    for (const pl of gv.hitters) consider(pl, HITTER_PROP_KEYS);
  }

  const filtered = edgesOnly ? entries.filter((e) => e.ev.qualifiesEdge) : entries;

  const sortVal = (e: Entry): number => {
    switch (sortCol) {
      case "proj":
        return e.row.projection;
      case "line":
        return e.row.line ?? 0;
      case "l10":
        return e.row.trends?.l10?.pct ?? -1;
      case "model":
        return e.row.modelOverProb ?? -1;
      case "edge":
      default:
        return e.ev.qualifiesEdge ? e.ev.magnitude : -1;
    }
  };
  const sorted = [...filtered].sort((a, b) => {
    if (sortCol === "player") {
      const c = a.player.name.localeCompare(b.player.name);
      return sortDir === "asc" ? c : -c;
    }
    const d = sortVal(a) - sortVal(b);
    return sortDir === "asc" ? d : -d;
  });

  const setSort = (col: BoardSortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      // text/low-is-natural columns default ascending; value columns descending.
      setSortDir(col === "player" ? "asc" : "desc");
    }
  };

  const Th = ({
    col,
    label,
    align = "left",
  }: {
    col?: BoardSortCol;
    label: string;
    align?: "left" | "right";
  }) => (
    <th
      onClick={col ? () => setSort(col) : undefined}
      className={[
        "whitespace-nowrap px-2 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
        col ? "cursor-pointer select-none hover:text-slate-200" : "",
      ].join(" ")}
    >
      {label}
      {col && sortCol === col ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {sorted.length} lined prop{sorted.length === 1 ? "" : "s"} · tap a row for detail
        </p>
        <button
          type="button"
          onClick={() => setEdgesOnly((v) => !v)}
          className={[
            "shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            edgesOnly
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
              : "border-slate-700 text-slate-300 hover:bg-slate-800",
          ].join(" ")}
        >
          Edges only
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="surface rounded-2xl p-8 text-center text-slate-400">
          No lined props{" "}
          {q ? `match “${query.trim()}”` : edgesOnly ? "with a qualifying edge" : "yet"}.
        </div>
      ) : (
        <div className="surface overflow-x-auto rounded-2xl">
          <table className="min-w-full text-xs tabular-nums">
            <thead className="bg-slate-900 text-slate-500">
              <tr>
                <Th col="player" label="Player" />
                <Th label="Prop" />
                <Th col="line" label="Line" align="right" />
                <Th col="proj" label="Proj" align="right" />
                <Th col="edge" label="Edge" align="right" />
                <Th col="model" label="Model/Mkt" align="right" />
                <Th col="l10" label="L10" align="right" />
                <Th label="Sharp" />
                <Th label="Result" align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const key = `${e.player.player_id}|${e.prop}`;
                const showActual =
                  e.status?.state === "live" || e.status?.state === "final";
                const actual = showActual
                  ? liveActualFor(
                      e.prop,
                      liveStats.get(e.gv.game_id)?.get(e.player.player_id),
                      e.status?.state === "final",
                      firstInningStats.get(e.gv.game_id),
                      e.player.player_id,
                    )
                  : undefined;
                const locked = actualLocked(e.prop, e.status);
                const grade =
                  actual !== undefined && e.row.line !== undefined
                    ? gradeLean(e.row.projection, e.row.line, actual, locked)
                    : "none";
                const model = e.row.modelOverProb;
                const fair = e.row.fairOverProb;
                return (
                  <tr
                    key={key}
                    onClick={() =>
                      onOpenDrawer({
                        player: e.player,
                        prop: e.prop,
                        row: e.row,
                        gv: e.gv,
                        status: e.status,
                        liveActual: actual,
                        locked,
                      })
                    }
                    className="cursor-pointer border-t border-slate-800/70 hover:bg-slate-900/60"
                  >
                      <td className="px-2 py-1.5 text-slate-100">
                        <span className="flex items-center gap-1">
                          <StarButton playerId={e.player.player_id} />
                          <span className="max-w-[130px] truncate">{e.player.name}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">
                        {PROP_META[e.prop].short}
                      </td>
                      <td className="px-2 py-1.5 text-right text-slate-300">
                        {fmt(e.row.line as number)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-slate-100">
                        {fmt(e.row.projection)}
                      </td>
                      <td className="px-2 py-1.5 text-right">{edgeCell(e.ev)}</td>
                      <td className="px-2 py-1.5 text-right text-slate-400">
                        {model !== undefined && fair !== undefined
                          ? `${Math.round(model * 100)}/${Math.round(fair * 100)}`
                          : "—"}
                      </td>
                      <td
                        className={[
                          "px-2 py-1.5 text-right",
                          e.row.trends?.l10 ? l10Tone(e.row.trends.l10.pct) : "text-slate-600",
                        ].join(" ")}
                      >
                        {e.row.trends?.l10
                          ? `${e.row.trends.l10.over}/${e.row.trends.l10.total}`
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        <SharpBadge sharp={e.row.sharpAgreement} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        {actual !== undefined ? (
                          <span className={gradeTextColor(grade)}>
                            {fmt(actual)}
                            {grade === "win" ? " ✓" : grade === "loss" ? " ✗" : ""}
                          </span>
                        ) : (
                          <span className="text-slate-600">
                            {e.status?.state === "live"
                              ? "live"
                              : e.status?.state === "final"
                                ? "final"
                                : "—"}
                          </span>
                        )}
                      </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Player detail drawer (deep-dive side panel) ──────────────────────────────
// player_game_logs column carrying each prop's graded actual (for the L10 log).
const DRAWER_ACTUAL_COL: Partial<Record<PropType, string>> = {
  strikeouts: "actual_strikeouts",
  hits_allowed: "actual_hits_allowed",
  walks: "actual_walks",
  earned_runs: "actual_earned_runs",
  outs_recorded: "actual_outs_recorded",
  pitcher_first_inning_pitches: "actual_first_inning_pitches",
  pitcher_first_inning_strikeouts: "actual_first_inning_strikeouts",
  pitcher_fantasy_score: "actual_pitcher_fantasy_score",
  hitter_hits: "actual_hits",
  hitter_total_bases: "actual_total_bases",
  hitter_hits_runs_rbis: "actual_hits_runs_rbis",
  hitter_rbis: "actual_rbis",
  hitter_runs: "actual_runs",
  hitter_home_runs: "actual_home_runs",
  hitter_fantasy_score: "actual_hitter_fantasy_score",
};

type DrawerTarget = {
  player: PlayerRow;
  prop: PropType;
  row: Pitcher;
  gv: GameView;
  status: GameStatus | undefined;
  liveActual: number | undefined;
  locked: boolean;
};
type BookLine = {
  bookmaker: string;
  line: number;
  over_price: number | null;
  under_price: number | null;
};
type LogGame = { date: string; actual: number };

// Lightweight read-only PostgREST fetch (anon key) so the drawer's on-demand
// queries don't pull the supabase-js client into the page bundle — mirrors the
// raw-fetch pattern the live MLB hooks already use. Never throws.
async function supaRest(pathAndQuery: string): Promise<Record<string, unknown>[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  try {
    const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function PlayerDrawer({
  target,
  date,
  onClose,
}: {
  target: DrawerTarget | null;
  date: string;
  onClose: () => void;
}) {
  const [books, setBooks] = useState<BookLine[]>([]);
  const [log, setLog] = useState<LogGame[]>([]);
  const [loading, setLoading] = useState(false);

  const tkey = target
    ? `${target.player.player_id}|${target.prop}|${target.gv.game_id}`
    : null;

  // On open, fetch the per-book lines + last-12 graded games for this player+prop
  // straight from Supabase (read-only anon). Never throws — on any failure the
  // drawer just shows the data it already has.
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setBooks([]);
    setLog([]);
    setLoading(true);
    const actualCol = DRAWER_ACTUAL_COL[target.prop];
    const pid = target.player.player_id;
    const propParam = encodeURIComponent(target.prop);
    const gd = encodeURIComponent(date);
    (async () => {
      try {
        const [lineRows, logRows] = await Promise.all([
          supaRest(
            `lines?select=bookmaker,line,over_price,under_price` +
              `&player_id=eq.${pid}&prop_type=eq.${propParam}&game_date=eq.${gd}`,
          ),
          actualCol
            ? supaRest(
                `player_game_logs?select=game_date,${actualCol}` +
                  `&player_id=eq.${pid}&${actualCol}=not.is.null` +
                  `&order=game_date.desc&limit=12`,
              )
            : Promise.resolve([] as Record<string, unknown>[]),
        ]);
        if (cancelled) return;
        const bl = (lineRows as unknown as BookLine[])
          .filter((b) => b.line !== null && b.line !== undefined)
          .sort((a, b) => a.line - b.line || a.bookmaker.localeCompare(b.bookmaker));
        setBooks(bl);
        const lg = logRows
          .map((r) => ({ date: String(r.game_date), actual: Number(r[actualCol as string]) }))
          .filter((r) => Number.isFinite(r.actual));
        setLog(lg);
      } catch {
        /* read-only deep-dive; ignore failures */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tkey]);

  // Close on Escape.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const { player, prop, row, gv, liveActual, locked } = target;
  const meta = PROP_META[prop];
  const isHitter = HITTER_PROPS.has(prop);
  const homeTeam = gv.matchup.includes(" @ ") ? gv.matchup.split(" @ ")[1] : "";
  const line = row.line;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-slate-950 shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-800 bg-slate-950/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StarButton playerId={player.player_id} className="text-lg" />
              <h3 className="truncate text-base font-semibold text-slate-100">{player.name}</h3>
              {!isHitter && <SharpBadge sharp={row.sharpAgreement} />}
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-400">
              {meta.label} · {gv.matchup}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {/* key numbers */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="surface rounded-xl py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Line</div>
              <div className="text-sm font-semibold tabular-nums text-slate-100">
                {line !== undefined ? fmt(line) : "—"}
              </div>
            </div>
            <div className="surface rounded-xl py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">Proj</div>
              <div className="text-sm font-semibold tabular-nums text-slate-100">
                {fmt(row.projection)}
              </div>
            </div>
            <div className="surface rounded-xl py-2">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                {liveActual !== undefined ? "Actual" : "Edge"}
              </div>
              <div className="text-sm font-semibold tabular-nums">
                {liveActual !== undefined ? (
                  (() => {
                    const g =
                      line !== undefined
                        ? gradeLean(row.projection, line, liveActual, locked)
                        : "none";
                    return (
                      <span className={gradeTextColor(g)}>
                        {fmt(liveActual)}
                        {g === "win" ? " ✓" : g === "loss" ? " ✗" : ""}
                      </span>
                    );
                  })()
                ) : row.edge !== undefined ? (
                  <span
                    className={
                      row.edge > EDGE_THRESHOLD
                        ? "text-emerald-400"
                        : row.edge < -EDGE_THRESHOLD
                          ? "text-red-400"
                          : "text-slate-300"
                    }
                  >
                    {row.edge >= 0 ? "+" : "−"}
                    {Math.abs(row.edge).toFixed(2)}
                  </span>
                ) : (
                  <span className="text-slate-500">—</span>
                )}
              </div>
            </div>
          </div>

          {/* edge / result + context (reused leaf components) */}
          <div>
            <EdgeDetail pitcher={row} actual={liveActual} isFinal={locked} />
            <ConfidenceBar confidence={row.confidence} />
            <TrendRow trends={row.trends} />
            {prop === "strikeouts" && <OppContextLine kRate={row.oppContext?.kRate} />}
            {(prop === "hitter_total_bases" || prop === "hitter_home_runs") && (
              <WindCardLine
                homeTeam={homeTeam}
                windSpeed={gv.windSpeed}
                windDirDeg={gv.windDirDeg}
                isDome={gv.isDome}
              />
            )}
          </div>

          {/* book-by-book lines (line shopping) */}
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Sportsbook lines
            </div>
            {books.length === 0 ? (
              <div className="text-xs text-slate-600">
                {loading ? "Loading…" : "No book lines posted."}
              </div>
            ) : (
              <div className="space-y-1">
                {books.map((b) => (
                  <div
                    key={b.bookmaker}
                    className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900/40 px-3 py-1.5 text-xs tabular-nums"
                  >
                    <span className="text-slate-300">
                      {BOOK_DISPLAY[b.bookmaker] ?? b.bookmaker}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="font-medium text-slate-100">{fmt(b.line)}</span>
                      <span className="text-slate-500">
                        {b.over_price != null
                          ? `o ${b.over_price > 0 ? "+" : ""}${b.over_price}`
                          : ""}
                        {b.under_price != null
                          ? ` · u ${b.under_price > 0 ? "+" : ""}${b.under_price}`
                          : ""}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* L10 game log */}
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Recent results {line !== undefined ? `vs ${fmt(line)}` : ""}
            </div>
            {log.length === 0 ? (
              <div className="text-xs text-slate-600">
                {loading ? "Loading…" : "No graded games yet."}
              </div>
            ) : (
              <div className="space-y-1">
                {log.map((gm, i) => {
                  const over = line !== undefined ? gm.actual > line : false;
                  const under = line !== undefined ? gm.actual < line : false;
                  const tone = over ? "text-emerald-400" : under ? "text-red-400" : "text-slate-300";
                  return (
                    <div
                      key={`${gm.date}-${i}`}
                      className="flex items-center justify-between rounded-md border border-slate-800/60 px-3 py-1 text-xs tabular-nums"
                    >
                      <span className="text-slate-500">{formatShortDate(gm.date)}</span>
                      <span className={tone}>
                        {fmt(gm.actual)} {meta.unit}
                        {line !== undefined && (
                          <span className="ml-1.5 text-slate-600">
                            {over ? "O" : under ? "U" : "P"}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

export default function PropBoard({
  date,
  prevDate,
  nextDate,
  byProp,
  featuredSections = [],
}: {
  date: string;
  prevDate: string | null;
  nextDate: string | null;
  byProp: ByProp;
  featuredSections?: FeaturedSection[];
}) {
  // The board is GAME-first now. `focus` is the optional prop lens: "all" shows
  // every player's full line of chips; a specific prop shows the rich per-prop
  // card. Defaulting to "all" means you never have to pick a prop to start.
  const [focus, setFocus] = useState<PropType | "all">("all");

  // Inline detail-on-demand (All-props view): which `${playerId}|${prop}` chip's
  // detail panel is open. Board-wide single value -> only ONE open at a time, so
  // the overview never congests. Tapping the open chip again closes it.
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const toggleDetail = (key: string) =>
    setOpenDetail((prev) => (prev === key ? null : key));
  // Switching the prop lens clears any open inline panel (it belongs to the
  // All-props view) — keeps the two modes from leaking into each other.
  const selectFocus = (f: PropType | "all") => {
    setOpenDetail(null);
    setFocus(f);
  };

  // Manual expand/collapse overrides, keyed by `${focus}:${gameId}` so a choice
  // under one lens never leaks onto another.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const overrideKey = (gid: number) => `${focus}:${gid}`;

  // Slate toolbar: free-text search (player or team) + sort mode.
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<"time" | "edge" | "count">("time");
  // View: game cards (default) or the dense sortable Board table.
  const [view, setView] = useState<"games" | "board">("games");
  // Player detail drawer (deep-dive side panel) — null when closed.
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  // Watchlist (★) — starred player_ids in localStorage + the "only watched" filter.
  const watchlist = useWatchlist();
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  // Only RESTRICT once hydrated AND at least one star exists — else toggling it on
  // an empty / SSR list would blank the board.
  const wlActive = watchlistOnly && watchlist.hydrated && watchlist.count > 0;

  // Poll the MLB Stats API for live game status + box scores (unchanged).
  const liveStatus = useLiveGameStatus(date);
  const liveGamePks: number[] = [];
  const finalGamePks: number[] = [];
  // Live + final games with their current inning, for the 1st-inning hook (it
  // freezes a game once its 1st is complete; see useFirstInningStats).
  const firstInningInput: {
    gamePk: number;
    currentInning: number | null;
    isFinal: boolean;
  }[] = [];
  for (const [gid, s] of liveStatus) {
    if (s.state === "live") {
      liveGamePks.push(gid);
      firstInningInput.push({ gamePk: gid, currentInning: s.currentInning, isFinal: false });
    } else if (s.state === "final") {
      finalGamePks.push(gid);
      firstInningInput.push({ gamePk: gid, currentInning: s.currentInning, isFinal: true });
    }
  }
  const liveStats = useLiveBoxScores(liveGamePks, finalGamePks);
  const firstInningStats = useFirstInningStats(firstInningInput);

  // Invert prop->game->players into game->{pitchers,hitters}.
  const games = useMemo(() => buildGameViews(byProp), [byProp]);

  // Today's live model record across FINAL games (scorecard banner).
  const slateRecord = computeSlateRecord(games, liveStatus, liveStats, firstInningStats);

  // Focus filter: in single-prop mode, only games with a player for that prop.
  const visibleByFocus =
    focus === "all"
      ? games
      : games.filter((gv) =>
          (HITTER_PROPS.has(focus) ? gv.hitters : gv.pitchers).some((pl) => pl.props[focus]),
        );

  // Search + watchlist filters (player name / team / starred).
  const q = query.trim().toLowerCase();
  const queried = visibleByFocus.filter((gv) => {
    if (q && !gameMatchesQuery(gv, q)) return false;
    if (
      wlActive &&
      ![...gv.pitchers, ...gv.hitters].some((pl) => watchlist.has(pl.player_id))
    )
      return false;
    return true;
  });

  // Decorate with summary + status, then sort by the selected mode (default:
  // chronological by start time). Edge / count sorts surface value faster.
  const decorated = queried
    .map((gv) => ({
      gv,
      summary: summarizeGameView(gv, focus),
      status: liveStatus.get(gv.game_id),
    }))
    .sort((a, b) => {
      if (sortMode === "edge") return b.summary.topMagnitude - a.summary.topMagnitude;
      if (sortMode === "count") return b.summary.qualifyingCount - a.summary.qualifyingCount;
      const ta = a.gv.startTime ? Date.parse(a.gv.startTime) : Number.POSITIVE_INFINITY;
      const tb = b.gv.startTime ? Date.parse(b.gv.startTime) : Number.POSITIVE_INFINITY;
      return ta - tb;
    });

  const isExpanded = (gid: number, summary: GameSummary, status: GameStatus | undefined) =>
    overrides[overrideKey(gid)] ?? defaultExpanded(summary, status);
  const allExpanded =
    decorated.length > 0 && decorated.every((d) => isExpanded(d.gv.game_id, d.summary, d.status));
  const toggleAll = () => {
    const next = { ...overrides };
    for (const d of decorated) next[overrideKey(d.gv.game_id)] = !allExpanded;
    setOverrides(next);
  };

  return (
    <WatchlistCtx.Provider
      value={{ has: watchlist.has, toggle: watchlist.toggle, onlyWatched: wlActive }}
    >
      {/* date navigation */}
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

      {/* featured plays — three ranked sections with AI insights */}
      <FeaturedPlays sections={featuredSections} />

      {/* view toggle — game cards vs the dense Board table */}
      <div className="mb-3 inline-flex rounded-lg border border-slate-700 p-0.5">
        {(["games", "board"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={[
              "rounded-md px-3 py-1 text-sm font-medium transition-colors",
              view === v ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            {v === "games" ? "Games" : "Board"}
          </button>
        ))}
      </div>

      {/* prop focus — a compact grouped dropdown (replaces the overflowing tab
          row). "All props" is the default game-first matrix; pick one to focus. */}
      {view === "games" && (
        <div className="relative mb-3 inline-block">
          <select
            value={focus}
            onChange={(e) => selectFocus(e.target.value as PropType | "all")}
            aria-label="Filter by prop"
            className="min-w-[160px] cursor-pointer appearance-none rounded-lg border border-slate-700 bg-slate-800 py-2 pl-3.5 pr-10 text-sm font-medium text-slate-100 outline-none transition-colors [color-scheme:dark] hover:bg-slate-700 focus:border-slate-500"
          >
            <option value="all">All props</option>
            <optgroup label="Pitcher">
              {PROPS.filter((p) => !HITTER_PROPS.has(p.key)).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label.replace(/^Pitcher /, "")}
                </option>
              ))}
            </optgroup>
            <optgroup label="Hitter">
              {PROPS.filter((p) => HITTER_PROPS.has(p.key)).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label.replace(/^Hitter /, "")}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
            ▾
          </span>
        </div>
      )}

      {/* slate toolbar — search · sort · today's model record */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[170px] flex-1 sm:max-w-xs">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search player or team…"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 pr-7 text-sm text-slate-100 placeholder-slate-500 outline-none transition-colors focus:border-slate-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-300"
            >
              ×
            </button>
          )}
        </div>

        {/* watchlist filter toggle */}
        <button
          type="button"
          onClick={() => setWatchlistOnly((v) => !v)}
          title={
            watchlist.count > 0
              ? "Show only your starred players"
              : "Star players (☆) to build a watchlist"
          }
          className={[
            "flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
            wlActive
              ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
              : "border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200",
          ].join(" ")}
        >
          <span>★</span>
          <span>
            Watchlist
            {watchlist.hydrated && watchlist.count > 0 ? ` (${watchlist.count})` : ""}
          </span>
        </button>

        {view === "games" && (
          <div className="flex items-center gap-1 text-sm">
            <span className="mr-0.5 text-slate-500">Sort</span>
            {(
              [
                ["time", "Time"],
                ["edge", "Best edge"],
                ["count", "Most edges"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setSortMode(k)}
                className={[
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  sortMode === k
                    ? "bg-slate-700 text-slate-100"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {slateRecord &&
          (() => {
            const total = slateRecord.wins + slateRecord.losses;
            const pct = Math.round((slateRecord.wins / total) * 100);
            const tone =
              pct >= 55 ? "text-emerald-400" : pct >= 45 ? "text-amber-400" : "text-red-400";
            return (
              <div
                title="Model record across finished games today (line vs. actual, same grading as /results)"
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs tabular-nums"
              >
                <span className="text-slate-500">Model today</span>
                <span className="font-semibold text-slate-100">
                  {slateRecord.wins}/{total}
                </span>
                <span className={`font-semibold ${tone}`}>· {pct}%</span>
              </div>
            );
          })()}
      </div>

      {watchlistOnly && watchlist.hydrated && watchlist.count === 0 && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/80">
          Your watchlist is empty — tap the{" "}
          <span className="text-amber-400">☆</span> next to any player to add them,
          then this shows just your players.
        </div>
      )}

      {view === "board" && (
        <BoardTable
          games={games}
          liveStatus={liveStatus}
          liveStats={liveStats}
          firstInningStats={firstInningStats}
          query={q}
          onOpenDrawer={setDrawer}
        />
      )}

      {view === "games" && (
        <>
      {/* legend */}
      <p className="mb-6 text-xs leading-relaxed text-slate-500">
        {focus === "all" ? (
          <>
            Every player&apos;s full line, grouped by game. Chips highlight model edges (
            <span className="text-emerald-400">green = over</span>,{" "}
            <span className="text-red-400">red = under</span>). Tap a chip to focus that prop, or a
            game to expand.
          </>
        ) : (
          <>
            Edge = model probability vs. book implied probability.{" "}
            <span className="text-emerald-400">Positive</span> = model favors the over. Most players
            have no line until closer to game time.
          </>
        )}
      </p>

      {/* games */}
      {decorated.length === 0 ? (
        <div className="surface rounded-2xl p-8 text-center text-slate-400">
          {focus === "all"
            ? `No projections for ${date}.`
            : `No ${PROP_META[focus].label.toLowerCase()} projections for ${date}.`}
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {q
                ? `Filtered to “${query.trim()}” · ${decorated.length} game${decorated.length === 1 ? "" : "s"}`
                : sortMode === "edge"
                  ? "Sorted by strongest edge · tap a game to expand"
                  : sortMode === "count"
                    ? "Sorted by most edges · tap a game to expand"
                    : "Games in start-time order · tap a game to expand"}
            </p>
            <button
              type="button"
              onClick={toggleAll}
              className="shrink-0 rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div className="space-y-3">
            {decorated.map(({ gv, summary, status }) => (
              <GameCard
                key={gv.game_id}
                gv={gv}
                summary={summary}
                status={status}
                expanded={isExpanded(gv.game_id, summary, status)}
                onToggle={() =>
                  setOverrides((prev) => ({
                    ...prev,
                    [overrideKey(gv.game_id)]: !(
                      prev[overrideKey(gv.game_id)] ?? defaultExpanded(summary, status)
                    ),
                  }))
                }
                focus={focus}
                gameStats={liveStats.get(gv.game_id)}
                firstInning={firstInningStats.get(gv.game_id)}
                date={date}
                onFocus={selectFocus}
                openDetail={openDetail}
                onToggleDetail={toggleDetail}
                query={q}
              />
            ))}
          </div>
        </>
      )}
        </>
      )}

      <PlayerDrawer target={drawer} date={date} onClose={() => setDrawer(null)} />
    </WatchlistCtx.Provider>
  );
}
