"use client";

import { useState } from "react";
import DateNav from "./DateNav";
import FeaturedPlays from "./FeaturedPlays";
import ParkTag from "./ParkTag";
import SharpBadge from "./SharpBadge";
import { useLiveGameStatus } from "./useLiveGameStatus";
import { useLiveBoxScores } from "./useLiveBoxScores";
import type {
  ByProp,
  FeaturedPlay,
  FormDot,
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

function GameHeader({
  matchup,
  date,
  status,
}: {
  matchup: string;
  date: string;
  status: GameStatus | undefined;
}) {
  // matchup is "Away @ Home" — the home team is what determines the park.
  // No MLB team name contains " @ " so the split is safe; fall back to ""
  // if the matchup is a Game-N placeholder (no home team known).
  const homeTeam = matchup.includes(" @ ")
    ? matchup.split(" @ ")[1]
    : "";

  return (
    <div className="border-b border-slate-800 bg-slate-900 px-5 py-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold text-slate-200">{matchup}</h2>
        <ParkTag homeTeam={homeTeam} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
        <span>{formatShortDate(date)}</span>
        {status && <span className="text-slate-600">·</span>}
        <StatusLine status={status} />
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
  featuredPlays = [],
}: {
  date: string;
  prevDate: string | null;
  nextDate: string | null;
  byProp: ByProp;
  featuredPlays?: FeaturedPlay[];
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

  return (
    <>
      {/* date navigation */}
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

      {/* featured plays — hidden when fewer than 3 qualifying plays */}
      <FeaturedPlays plays={featuredPlays} />

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

      {/* game cards */}
      {groups.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No {activeMeta.label.toLowerCase()} projections for {date}.
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section
              key={g.game_id}
              className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50"
            >
              <GameHeader
                matchup={g.matchup}
                date={date}
                status={liveStatus.get(g.game_id)}
              />
              <ul className="divide-y divide-slate-800">
                {g.pitchers.map((p, i) => {
                  const gameStatus = liveStatus.get(g.game_id);
                  // Show the actual stat next to the projection for both
                  // live games (in-progress overlay) and final games (the
                  // "did the model hit" result chip). Scheduled / other
                  // states stay projection-only.
                  const showActual =
                    gameStatus?.state === "live" ||
                    gameStatus?.state === "final";
                  const liveActual = showActual
                    ? liveActualFor(
                        active,
                        liveStats.get(g.game_id)?.get(p.player_id),
                        gameStatus?.state === "final",
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
                          {/* Sharp badge on pitcher prop tabs only — subtle,
                              inline. Renders nothing unless 2+ real books
                              agree with the model's lean. */}
                          {!isHitter && (
                            <SharpBadge sharp={p.sharpAgreement} />
                          )}
                        </div>
                        <EdgeDetail pitcher={p} />
                        <ConfidenceBar confidence={p.confidence} />
                        <RecentFormDots form={p.recentForm} />
                        {active === "strikeouts" && (
                          <OppContextLine kRate={p.oppContext?.kRate} />
                        )}
                      </div>
                      <ProjectionBadge
                        pitcher={p}
                        unit={activeMeta.unit}
                        liveActual={liveActual}
                        isHitter={isHitter}
                        status={gameStatus}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
