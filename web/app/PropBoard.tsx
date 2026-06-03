"use client";

import { useState } from "react";
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
} from "@/lib/types";
import { EDGE_THRESHOLD, HITTER_PROPS } from "@/lib/constants";
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

// Labels carry a Pitcher/Hitter prefix so the filter tabs are unambiguous —
// the two "Fantasy Score" props in particular (pitcher vs hitter) are otherwise
// indistinguishable in the tab strip.
const PROPS: { key: PropType; label: string; unit: string }[] = [
  // pitcher props
  { key: "strikeouts",            label: "Pitcher Strikeouts",    unit: "K"    },
  { key: "hits_allowed",          label: "Pitcher Hits Allowed",  unit: "HA"   },
  { key: "walks",                 label: "Pitcher Walks",         unit: "BB"   },
  { key: "earned_runs",           label: "Pitcher Earned Runs",   unit: "ER"   },
  { key: "outs_recorded",         label: "Pitcher Outs Recorded", unit: "outs" },
  { key: "pitcher_fantasy_score", label: "Pitcher Fantasy Score", unit: "FP"   },
  // hitter props
  { key: "hitter_hits",           label: "Hitter Hits",           unit: "H"    },
  { key: "hitter_total_bases",    label: "Hitter Total Bases",    unit: "TB"   },
  { key: "hitter_rbis",           label: "Hitter RBIs",           unit: "RBI"  },
  { key: "hitter_runs",           label: "Hitter Runs",           unit: "R"    },
  { key: "hitter_home_runs",      label: "Hitter Home Runs",      unit: "HR"   },
  { key: "hitter_fantasy_score",  label: "Hitter Fantasy Score",  unit: "FP"   },
];

// EDGE_THRESHOLD and HITTER_PROPS now live in @/lib/constants — imported above.

// Minimum proj-vs-line gap before we call a model lean on a DFS (PrizePicks)
// line. Mirrors NO_LEAN_THRESHOLD in /results so the board's lean direction
// and the results-page grading agree on what counts as "~Even".
const LINE_LEAN_THRESHOLD = 0.1;

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

// Pace coloring for the actual stat shown next to the projection.
//
// Final games: this is the "did the model hit" indicator -- actual > proj is
// green (model underestimated), actual < proj is red (model overestimated),
// equal is neutral. Same calibration logic the /results Model Tracker uses.
//
// Live games: pitchers compare actual vs the pro-rated portion of the
// projection given how far into the game we are; hitters have no
// half-inning baseline so any contribution >0 is green, 0 is neutral.
function paceColor(
  actual: number,
  projection: number,
  isHitter: boolean,
  status: GameStatus | undefined,
): string {
  // Final game: actual vs projection.
  if (status?.state === "final") {
    if (actual > projection) return "text-emerald-400";
    if (actual < projection) return "text-red-400";
    return "text-slate-300";
  }
  if (isHitter) {
    return actual > 0 ? "text-emerald-400" : "text-slate-300";
  }
  // Pitcher pacing (live only)
  if (!status || !status.inningOrdinal) return "text-slate-300";
  const inningNum = parseInt(status.inningOrdinal, 10);
  if (!Number.isFinite(inningNum) || inningNum < 1) return "text-slate-300";
  const half = status.inningHalf?.toLowerCase() ?? "";
  const inningsElapsed = (inningNum - 1) + (half === "bottom" ? 0.5 : 0);
  if (inningsElapsed <= 0) return "text-slate-300";
  const expected = projection * (inningsElapsed / 9);
  if (actual >= expected * 0.8) return "text-emerald-400";
  if (actual >= expected * 0.5) return "text-amber-400";
  return "text-red-400";
}

// Render the right-side badge. When a live actual exists, show "{actual} {unit}
// · proj {projection}"; otherwise just the projection (existing behavior).
function ProjectionBadge({
  pitcher,
  unit,
  liveActual,
  isHitter,
  status,
}: {
  pitcher: Pitcher;
  unit: string;
  liveActual: number | undefined;
  isHitter: boolean;
  status: GameStatus | undefined;
}) {
  if (liveActual === undefined) {
    return (
      <span className="ml-3 shrink-0 rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400 tabular-nums">
        {pitcher.projection.toFixed(1)} {unit}
      </span>
    );
  }
  const color = paceColor(liveActual, pitcher.projection, isHitter, status);
  return (
    <span className="ml-3 shrink-0 rounded-md bg-slate-800/80 px-2.5 py-1 text-sm font-semibold tabular-nums">
      <span className={color}>
        {liveActual} {unit}
      </span>
      <span className="ml-1.5 font-normal text-slate-500">
        · proj {pitcher.projection.toFixed(1)}
      </span>
    </span>
  );
}

// ── edge sub-component ──────────────────────────────────────────────────────
// Pure display. Receives the pre-computed edge + line and picks colors/labels.

function EdgeDetail({ pitcher }: { pitcher: Pitcher }) {
  // No line for this player → render nothing (the common case).
  if (pitcher.line === undefined) {
    return null;
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
      <div className="mt-1 text-xs tabular-nums">
        <span className="text-slate-500">Line {pitcher.line}</span>
        <span className="mx-1.5 text-slate-600">·</span>
        {edgeNode}
      </div>
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
// harder). Rendered on the Strikeouts tab only (where opp K rate is most
// meaningful and the only prop that carries the value). Renders nothing when
// kRate is missing — never "Facing a null% lineup".
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

// Wind tag line for total-bases cards (hitter_total_bases ONLY). Same arrow +
// mph + direction + colors as the HR cards (out=green, in=red, cross=slate),
// rendered card-sized. Returns null when there's no usable wind (calm / unknown
// bearing / no data) — the game header already carries the static park label, so
// we show ONLY the wind condition here, not a park fallback.
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

// ── game header sub-component ────────────────────────────────────────────────
// Shows the matchup title + a status line beneath: date + live/scheduled/final.
// `status` is undefined when the live fetch hasn't populated yet (or failed) —
// in that case we just show the matchup + short date and nothing else, which
// is the graceful-degrade path.

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

// ── per-game edge summary (presentation-only) ────────────────────────────────
// Scans a game's players for the active prop and returns its single strongest
// QUALIFYING play + how many qualify. This lets a COLLAPSED game surface its
// best edge inline and lets the slate be ordered best-edge-first. Pure display
// math over the already-computed edge/line fields — no edge-model logic here.

type BestPlay = {
  name: string;
  line: number;
  edge?: number; // undefined for DFS (PrizePicks fantasy) lean-only props
  direction: "over" | "under" | "even";
};

type GameSummary = {
  bestPlay: BestPlay | null; // strongest qualifying play (null = none qualify)
  qualifyingCount: number; // players clearing the edge/lean threshold
  hasAnyLine: boolean; // any player carries a line at all
  topMagnitude: number; // strongest |edge|/|lean| — drives the sort
};

function summarizeGame(g: GameGroup): GameSummary {
  let bestPlay: BestPlay | null = null;
  let bestQualMag = -1;
  let topMagnitude = 0;
  let qualifyingCount = 0;
  let hasAnyLine = false;

  for (const p of g.pitchers) {
    if (p.line === undefined) continue;
    hasAnyLine = true;

    let magnitude: number;
    let direction: "over" | "under" | "even";
    let qualifies: boolean;
    let edge: number | undefined;

    if (p.edge !== undefined) {
      // Two-sided book: de-vigged edge drives it all (same thresholds as EdgeDetail).
      edge = p.edge;
      magnitude = Math.abs(p.edge);
      direction =
        p.edge > EDGE_THRESHOLD ? "over" : p.edge < -EDGE_THRESHOLD ? "under" : "even";
      qualifies = magnitude > EDGE_THRESHOLD;
    } else {
      // DFS fantasy line: lean = proj − line (the exact rule /results grades on).
      const diff = p.projection - p.line;
      magnitude = Math.abs(diff);
      direction =
        diff > LINE_LEAN_THRESHOLD ? "over" : diff < -LINE_LEAN_THRESHOLD ? "under" : "even";
      qualifies = magnitude > LINE_LEAN_THRESHOLD;
    }

    if (magnitude > topMagnitude) topMagnitude = magnitude;
    if (qualifies) {
      qualifyingCount += 1;
      if (magnitude > bestQualMag) {
        bestQualMag = magnitude;
        bestPlay = { name: p.name, line: p.line, edge, direction };
      }
    }
  }

  return { bestPlay, qualifyingCount, hasAnyLine, topMagnitude };
}

// Sort rank by game state: scheduled/upcoming (bettable) first, then live, then
// final. Within a rank, games sort by their strongest edge (descending), so the
// juiciest BETTABLE matchups float to the top — the fix for "good plays buried
// at the bottom of the slate".
function stateRank(s: GameStatus | undefined): number {
  if (!s) return 0;
  if (s.state === "final") return 2;
  if (s.state === "live") return 1;
  return 0;
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
// (name · line · edge/lean) + a "+N more" count. Falls back to a muted
// "No edge" / "No lines yet" so a collapsed game is never blank.
function CollapsedSummary({ summary, unit }: { summary: GameSummary; unit: string }) {
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
        {bestPlay.line} {unit}
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

// ── one collapsible game card ────────────────────────────────────────────────
// Clickable header (chevron + matchup + park/wind tag + status) over EITHER the
// collapsed summary line OR the full player list. The expanded player list is
// the exact card layout as before — only the wrapping/collapse is new.
function GameCard({
  group: g,
  summary,
  status,
  expanded,
  onToggle,
  active,
  unit,
  isHitter,
  gameStats,
  date,
}: {
  group: GameGroup;
  summary: GameSummary;
  status: GameStatus | undefined;
  expanded: boolean;
  onToggle: () => void;
  active: PropType;
  unit: string;
  isHitter: boolean;
  gameStats: Map<number, StatLine> | undefined;
  date: string;
}) {
  // matchup is "Away @ Home" — the home team determines the park. No MLB team
  // name contains " @ " so the split is safe; "" for a Game-N placeholder.
  const homeTeam = g.matchup.includes(" @ ") ? g.matchup.split(" @ ")[1] : "";
  const wc = windClause({
    homeTeam,
    windSpeed: g.windSpeed,
    windDirDeg: g.windDirDeg,
    isDome: g.isDome,
  });
  const parkShown = !!homeTeam && getParkProfile(homeTeam).direction !== "neutral";

  // Show the live/final actual chip in the same cases as before.
  const showActual = status?.state === "live" || status?.state === "final";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
      {/* clickable header — role=button keeps the <h2> heading semantics
          (a <button> can't legally wrap an <h2>). */}
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
              <h2 className="font-semibold text-slate-200">{g.matchup}</h2>
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
        {!expanded && <CollapsedSummary summary={summary} unit={unit} />}
      </div>

      {expanded && (
        <ul className="divide-y divide-slate-800">
          {g.pitchers.map((p, i) => {
            const liveActual = showActual
              ? liveActualFor(
                  active,
                  gameStats?.get(p.player_id),
                  status?.state === "final",
                )
              : undefined;
            return (
              <li
                key={`${g.game_id}-${i}`}
                className="flex items-start justify-between px-5 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-100">{p.name}</span>
                    {/* Sharp badge on pitcher prop tabs only. */}
                    {!isHitter && <SharpBadge sharp={p.sharpAgreement} />}
                  </div>
                  <EdgeDetail pitcher={p} />
                  <ConfidenceBar confidence={p.confidence} />
                  <RecentFormDots form={p.recentForm} />
                  {active === "strikeouts" && (
                    <OppContextLine kRate={p.oppContext?.kRate} />
                  )}
                  {active === "hitter_total_bases" && (
                    <WindCardLine
                      homeTeam={homeTeam}
                      windSpeed={g.windSpeed}
                      windDirDeg={g.windDirDeg}
                      isDome={g.isDome}
                    />
                  )}
                </div>
                <ProjectionBadge
                  pitcher={p}
                  unit={unit}
                  liveActual={liveActual}
                  isHitter={isHitter}
                  status={status}
                />
              </li>
            );
          })}
        </ul>
      )}
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
  const [active, setActive] = useState<PropType>("strikeouts");

  const activeMeta = PROPS.find((p) => p.key === active)!;
  const groups = byProp[active] ?? [];

  // Poll the MLB Stats API for live game status. The hook returns an empty
  // Map until the first response lands and on any failure — render falls back
  // to the static matchup + date header in those cases.
  const liveStatus = useLiveGameStatus(date);

  // Split today's games into live (poll every 60s) vs final (fetch once each)
  // gamePks. The hook stabilizes both via stringified keys so the effects
  // only fire when the SET of game ids changes, not on every render.
  const liveGamePks: number[] = [];
  const finalGamePks: number[] = [];
  for (const [gid, s] of liveStatus) {
    if (s.state === "live") liveGamePks.push(gid);
    else if (s.state === "final") finalGamePks.push(gid);
  }
  const liveStats = useLiveBoxScores(liveGamePks, finalGamePks);

  const isHitter = HITTER_PROPS.has(active);

  // Manual expand/collapse overrides, keyed by `${tab}:${gameId}` so a choice on
  // one prop tab never leaks onto another (game ids are shared across tabs).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const overrideKey = (gid: number) => `${active}:${gid}`;

  // Decorate each game with its edge summary + live status, then order
  // best-edge-first within bettable → live → final bands. Presentation only —
  // the edge/line values come pre-computed from the engine.
  const decorated = groups
    .map((g) => ({
      g,
      summary: summarizeGame(g),
      status: liveStatus.get(g.game_id),
    }))
    .sort((a, b) => {
      const ra = stateRank(a.status);
      const rb = stateRank(b.status);
      if (ra !== rb) return ra - rb;
      if (b.summary.topMagnitude !== a.summary.topMagnitude) {
        return b.summary.topMagnitude - a.summary.topMagnitude;
      }
      // tiebreak: earliest first pitch (TBD start times sink to the end).
      const ta = a.g.startTime ? Date.parse(a.g.startTime) : Number.POSITIVE_INFINITY;
      const tb = b.g.startTime ? Date.parse(b.g.startTime) : Number.POSITIVE_INFINITY;
      return ta - tb;
    });

  const isExpanded = (
    gid: number,
    summary: GameSummary,
    status: GameStatus | undefined,
  ) => overrides[overrideKey(gid)] ?? defaultExpanded(summary, status);

  const allExpanded =
    decorated.length > 0 &&
    decorated.every((d) => isExpanded(d.g.game_id, d.summary, d.status));

  const toggleAll = () => {
    const next = { ...overrides };
    for (const d of decorated) next[overrideKey(d.g.game_id)] = !allExpanded;
    setOverrides(next);
  };

  return (
    <>
      {/* date navigation */}
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

      {/* featured plays — three ranked sections with AI insights */}
      <FeaturedPlays sections={featuredSections} />

      {/* prop selector tabs */}
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {PROPS.map((p) => (
          <button
            key={p.key}
            onClick={() => setActive(p.key)}
            className={[
              "shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              active === p.key
                ? "bg-emerald-500 text-slate-950"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
            ].join(" ")}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* edge legend */}
      <p className="mb-6 text-xs leading-relaxed text-slate-500">
        Edge = model probability vs. book implied probability.{" "}
        <span className="text-emerald-400">Positive</span> = model favors the
        over. Most players have no line until closer to game time.
      </p>

      {/* game cards — condensed, best-edge-first, collapsible */}
      {groups.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No {activeMeta.label.toLowerCase()} projections for {date}.
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              Games sorted by strongest edge · tap a game to expand
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
            {decorated.map(({ g, summary, status }) => (
              <GameCard
                key={g.game_id}
                group={g}
                summary={summary}
                status={status}
                expanded={isExpanded(g.game_id, summary, status)}
                onToggle={() =>
                  setOverrides((prev) => ({
                    ...prev,
                    [overrideKey(g.game_id)]: !(
                      prev[overrideKey(g.game_id)] ??
                      defaultExpanded(summary, status)
                    ),
                  }))
                }
                active={active}
                unit={activeMeta.unit}
                isHitter={isHitter}
                gameStats={liveStats.get(g.game_id)}
                date={date}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
