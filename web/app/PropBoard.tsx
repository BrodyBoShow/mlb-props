"use client";

import { useMemo, useState } from "react";
import DateNav from "./DateNav";
import FeaturedPlays from "./FeaturedPlays";
import ParkTag from "./ParkTag";
import SharpBadge from "./SharpBadge";
import { getParkProfile } from "@/lib/constants";
import { windClause } from "@/lib/windTag";
import { useLiveGameStatus } from "./useLiveGameStatus";
import { useLiveBoxScores } from "./useLiveBoxScores";
import type {
  ByProp,
  FeaturedSection,
  FormDot,
  GameGroup,
  GameStatus,
  Pitcher,
  PropType,
  StatLine,
  Trends,
  TrendWindow,
} from "@/lib/types";
import { EDGE_THRESHOLD, HITTER_PROPS, REAL_BOOKS } from "@/lib/constants";
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

// Compact numeric formatter: integers stay integer (live actuals, "16"), else
// one decimal ("6.4").
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
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
): number | undefined {
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
  status,
}: {
  pitcher: Pitcher;
  unit: string;
  liveActual: number | undefined;
  status: GameStatus | undefined;
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
  // on an under lean reads red, not green.
  const isFinal = status?.state === "final";
  const g =
    pitcher.line !== undefined
      ? gradeLean(pitcher.projection, pitcher.line, liveActual, !!isFinal)
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
        {/* De-vig: the market's no-vig fair % for the over vs the book's raw
            implied % (with vig). The gap is the juice; the edge above is the
            model vs Fair. Surfaces the de-vig the engine already computes. */}
        {pitcher.fairOverProb !== undefined && (
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

// ── recent-form spark dots ───────────────────────────────────────────────────
// A quiet L5 row: the pitcher's last ≤5 graded actuals for THIS prop vs
// tonight's line, oldest→newest (rightmost = most recent). Pre-computed
// server-side per (pitcher, prop), so switching tabs shows the right dots.
// Renders nothing when there's no form data (no line / no history / hitter
// or fantasy prop) — feature 2's confidence line already conveys "no history".

const FORM_DOT_CLASS: Record<FormDot, string> = {
  over:  "bg-emerald-500/80",
  under: "bg-red-500/70",
  push:  "bg-slate-600",
};

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

function RecentFormDots({ form }: { form: FormDot[] | undefined }) {
  if (!form || form.length === 0) return null;

  // Tooltip spells out the sequence, e.g. "O-U-O-O-U" (oldest→newest).
  const seq = form
    .map((d) => (d === "over" ? "O" : d === "under" ? "U" : "P"))
    .join("-");

  return (
    <div
      className="mt-1 flex items-center gap-1.5"
      title={`Last ${form.length} starts vs tonight's line: ${seq}`}
    >
      <span className="text-[9px] uppercase tracking-wider text-slate-600">
        L5
      </span>
      <div className="flex items-center gap-1">
        {form.map((d, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${FORM_DOT_CLASS[d]}`}
          />
        ))}
      </div>
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

function formatShortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

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
function evalRow(row: Pitcher): RowEval {
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
    return {
      hasLine: true,
      isEdge: true,
      isRealBook,
      edge: row.edge,
      magnitude: mag,
      direction: row.edge > EDGE_THRESHOLD ? "over" : row.edge < -EDGE_THRESHOLD ? "under" : "even",
      qualifiesEdge: overThresh && isRealBook,
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
    return !!r && evalRow(r).qualifiesEdge;
  });
}

function playerBestMag(pl: PlayerRow): number {
  let m = 0;
  for (const p of PROPS) {
    const r = pl.props[p.key];
    if (r) {
      const e = evalRow(r);
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
    const e = evalRow(row);
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

  return { bestPlay, qualifyingCount, hasAnyLine };
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
  isFinal,
  active,
  onTap,
}: {
  prop: PropType;
  row: Pitcher;
  live: number | undefined;
  isFinal: boolean;
  active: boolean;       // this chip's inline detail is open
  onTap: () => void;
}) {
  const meta = PROP_META[prop];
  const e = evalRow(row);
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
    } else if (e.qualifiesConsensus && e.edge !== undefined) {
      // Consensus (synthetic-line) edge — number but MUTED, no tint.
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
      const g = gradeLean(row.projection, line, live, isFinal);
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
    ? liveActualFor(prop, gameStats?.get(player.player_id), status?.state === "final")
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
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ProjectionBadge pitcher={row} unit={meta.unit} liveActual={liveActual} status={status} />
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
      <div className="text-sm text-slate-100">{player.name}</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {chips.map(({ prop, row }) => {
          const live = showActual ? liveActualFor(prop, stat, !!isFinal) : undefined;
          const key = `${player.player_id}|${prop}`;
          return (
            <PropChip
              key={prop}
              prop={prop}
              row={row}
              live={live}
              isFinal={!!isFinal}
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
  homeTeam: string;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
}) {
  const showActual = status?.state === "live" || status?.state === "final";
  const liveActual = showActual
    ? liveActualFor(prop, gameStats?.get(row.player_id), status?.state === "final")
    : undefined;

  return (
    <li className="flex items-start justify-between px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
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
        status={status}
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
  date,
  onFocus,
  openDetail,
  onToggleDetail,
}: {
  gv: GameView;
  summary: GameSummary;
  status: GameStatus | undefined;
  expanded: boolean;
  onToggle: () => void;
  focus: PropType | "all";
  gameStats: Map<number, StatLine> | undefined;
  date: string;
  onFocus: (p: PropType) => void;
  openDetail: string | null;
  onToggleDetail: (key: string) => void;
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

  const edgeHitters = gv.hitters.filter(playerHasEdge);
  // Default-visible hitters: those with a real edge, or (if none) the top few so
  // the lineup is never an empty section. `gv.hitters` is already sorted
  // strongest-edge-first. The rest fold behind the "Show N more" expander.
  const defaultHitters =
    edgeHitters.length > 0 ? edgeHitters : gv.hitters.slice(0, DEFAULT_HITTER_COUNT);
  const hittersToShow = showAllHitters ? gv.hitters : defaultHitters;
  const moreHitters = gv.hitters.length - defaultHitters.length;

  const isHitterFocus = focus !== "all" && HITTER_PROPS.has(focus);
  const focusedPlayers =
    focus === "all"
      ? []
      : (isHitterFocus ? gv.hitters : gv.pitchers).filter((pl) => pl.props[focus]);
  const focusUnit = focus !== "all" ? PROP_META[focus].unit : "";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
      {/* clickable header — role=button keeps the <h2> heading semantics. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={[
          "cursor-pointer px-5 py-3 transition-colors hover:bg-slate-900",
          expanded ? "border-b border-slate-800 bg-slate-900" : "",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <Chevron expanded={expanded} />
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
          </div>
        </div>
        {!expanded && <CollapsedSummary summary={summary} />}
      </div>

      {expanded &&
        (focus === "all" ? (
          <div>
            {gv.pitchers.length > 0 && (
              <>
                <SectionLabel>Pitchers</SectionLabel>
                <ul className="divide-y divide-slate-800/60">
                  {gv.pitchers.map((pl) => (
                    <PlayerChipsRow
                      key={pl.player_id}
                      player={pl}
                      propKeys={PITCHER_PROP_KEYS}
                      gameStats={gameStats}
                      status={status}
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
            {gv.hitters.length > 0 && (
              <>
                <SectionLabel>
                  {!showAllHitters && moreHitters > 0 && edgeHitters.length > 0
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

  // Poll the MLB Stats API for live game status + box scores (unchanged).
  const liveStatus = useLiveGameStatus(date);
  const liveGamePks: number[] = [];
  const finalGamePks: number[] = [];
  for (const [gid, s] of liveStatus) {
    if (s.state === "live") liveGamePks.push(gid);
    else if (s.state === "final") finalGamePks.push(gid);
  }
  const liveStats = useLiveBoxScores(liveGamePks, finalGamePks);

  // Invert prop->game->players into game->{pitchers,hitters}; chronological.
  const games = useMemo(() => buildGameViews(byProp), [byProp]);
  const ordered = useMemo(
    () =>
      [...games].sort((a, b) => {
        const ta = a.startTime ? Date.parse(a.startTime) : Number.POSITIVE_INFINITY;
        const tb = b.startTime ? Date.parse(b.startTime) : Number.POSITIVE_INFINITY;
        return ta - tb;
      }),
    [games],
  );

  // In focused mode, only show games that actually have a player for that prop.
  const visible =
    focus === "all"
      ? ordered
      : ordered.filter((gv) =>
          (HITTER_PROPS.has(focus) ? gv.hitters : gv.pitchers).some((pl) => pl.props[focus]),
        );

  const decorated = visible.map((gv) => ({
    gv,
    summary: summarizeGameView(gv, focus),
    status: liveStatus.get(gv.game_id),
  }));

  const isExpanded = (gid: number, summary: GameSummary, status: GameStatus | undefined) =>
    overrides[overrideKey(gid)] ?? defaultExpanded(summary, status);
  const allExpanded =
    decorated.length > 0 && decorated.every((d) => isExpanded(d.gv.game_id, d.summary, d.status));
  const toggleAll = () => {
    const next = { ...overrides };
    for (const d of decorated) next[overrideKey(d.gv.game_id)] = !allExpanded;
    setOverrides(next);
  };

  const chipCls = (activeChip: boolean) =>
    [
      "shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
      activeChip
        ? "bg-emerald-500 text-slate-950"
        : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
    ].join(" ");

  return (
    <>
      {/* date navigation */}
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

      {/* featured plays — three ranked sections with AI insights */}
      <FeaturedPlays sections={featuredSections} />

      {/* prop FILTER — "All props" (game-first matrix) or focus a single prop */}
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        <button onClick={() => selectFocus("all")} className={chipCls(focus === "all")}>
          All props
        </button>
        {PROPS.map((p) => (
          <button key={p.key} onClick={() => selectFocus(p.key)} className={chipCls(focus === p.key)}>
            {p.label}
          </button>
        ))}
      </div>

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
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          {focus === "all"
            ? `No projections for ${date}.`
            : `No ${PROP_META[focus].label.toLowerCase()} projections for ${date}.`}
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              Games in start-time order · tap a game to expand
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
                date={date}
                onFocus={selectFocus}
                openDetail={openDetail}
                onToggleDetail={toggleDetail}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
