"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveGameStatus, type GameStatus } from "./useLiveGameStatus";

// ── types ────────────────────────────────────────────────────────────────────

export type PropType =
  | "strikeouts"
  | "hits_allowed"
  | "walks"
  | "earned_runs"
  | "outs_recorded"
  | "hitter_hits"
  | "hitter_total_bases"
  | "hitter_rbis"
  | "hitter_runs"
  | "hitter_home_runs";

// One pitcher/hitter row. Projection is always present; all other fields are
// optional — most players won't have a line or enough graded history yet.
// All values are pre-computed by the engine (the frontend does ZERO math).
export type Pitcher = {
  name: string;
  projection: number;
  confidence?: number;   // 0–1 hit rate; undefined = not enough graded history
  line?: number;
  edge?: number;
  fairOverProb?: number;
  modelOverProb?: number;
  overPrice?: number;
  underPrice?: number;
  bookmaker?: string;
};

export type GameGroup = {
  game_id: number;
  matchup: string;
  // First-pitch ISO timestamp from the games table. The slate is sorted by
  // this server-side in page.tsx; null entries (TBD) sort to the end.
  startTime: string | null;
  pitchers: Pitcher[];
};

export type ByProp = Record<PropType, GameGroup[]>;

// ── prop metadata ─────────────────────────────────────────────────────────────

const PROPS: { key: PropType; label: string; unit: string }[] = [
  // pitcher props
  { key: "strikeouts",        label: "Strikeouts",    unit: "K"    },
  { key: "hits_allowed",      label: "Hits Allowed",  unit: "H"    },
  { key: "walks",             label: "Walks",         unit: "BB"   },
  { key: "earned_runs",       label: "Earned Runs",   unit: "ER"   },
  { key: "outs_recorded",     label: "Outs Recorded", unit: "outs" },
  // hitter props
  { key: "hitter_hits",        label: "H Hits",       unit: "H"   },
  { key: "hitter_total_bases", label: "Total Bases",  unit: "TB"  },
  { key: "hitter_rbis",        label: "RBIs",         unit: "RBI" },
  { key: "hitter_runs",        label: "Runs",         unit: "R"   },
  { key: "hitter_home_runs",   label: "Home Runs",    unit: "HR"  },
];

// Edge threshold for calling a side a real lean vs. roughly even.
const EDGE_THRESHOLD = 0.1;

// ── date navigation sub-component ────────────────────────────────────────────
// Renders a row with prev/next arrows around the current date.
// Arrows are Links when a date exists, greyed non-clickable spans otherwise.

function formatDateLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

const arrowBase =
  "flex h-10 w-10 items-center justify-center rounded-lg text-xl transition-colors select-none";

function DateNav({
  currentDate,
  prevDate,
  nextDate,
}: {
  currentDate: string;
  prevDate: string | null;
  nextDate: string | null;
}) {
  return (
    <div className="mb-5 flex items-center justify-between">
      {prevDate ? (
        <Link
          href={`/?date=${prevDate}`}
          className={`${arrowBase} bg-slate-800 text-slate-200 hover:bg-slate-700`}
          aria-label="Previous day"
        >
          ‹
        </Link>
      ) : (
        <span
          className={`${arrowBase} cursor-not-allowed bg-slate-800/40 text-slate-700`}
          aria-disabled="true"
        >
          ‹
        </span>
      )}

      <span className="text-center text-sm font-semibold text-slate-200">
        {formatDateLong(currentDate)}
      </span>

      {nextDate ? (
        <Link
          href={`/?date=${nextDate}`}
          className={`${arrowBase} bg-slate-800 text-slate-200 hover:bg-slate-700`}
          aria-label="Next day"
        >
          ›
        </Link>
      ) : (
        <span
          className={`${arrowBase} cursor-not-allowed bg-slate-800/40 text-slate-700`}
          aria-disabled="true"
        >
          ›
        </span>
      )}
    </div>
  );
}

// ── edge sub-component ──────────────────────────────────────────────────────
// Pure display. Receives the pre-computed edge + line and picks colors/labels.

function EdgeDetail({ pitcher }: { pitcher: Pitcher }) {
  // No line for this pitcher → render nothing (the common case).
  if (pitcher.edge === undefined || pitcher.line === undefined) {
    return null;
  }

  const edge = pitcher.edge;
  const signed = `${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(2)}`;

  let edgeNode;
  if (edge > EDGE_THRESHOLD) {
    edgeNode = (
      <span className="text-emerald-400">▲ Edge {signed}</span>
    );
  } else if (edge < -EDGE_THRESHOLD) {
    edgeNode = (
      <span className="text-red-400">▼ Edge {signed}</span>
    );
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
  return (
    <div className="border-b border-slate-800 bg-slate-900 px-5 py-3">
      <h2 className="font-semibold text-slate-200">{matchup}</h2>
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
}: {
  date: string;
  prevDate: string | null;
  nextDate: string | null;
  byProp: ByProp;
}) {
  const [active, setActive] = useState<PropType>("strikeouts");

  const activeMeta = PROPS.find((p) => p.key === active)!;
  const groups = byProp[active] ?? [];

  // Poll the MLB Stats API for live game status. The hook returns an empty
  // Map until the first response lands and on any failure — render falls back
  // to the static matchup + date header in those cases.
  const liveStatus = useLiveGameStatus(date);

  return (
    <>
      {/* date navigation */}
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

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
                {g.pitchers.map((p, i) => (
                  <li
                    key={`${g.game_id}-${i}`}
                    className="flex items-start justify-between px-5 py-3"
                  >
                    <div className="min-w-0">
                      <span className="text-slate-100">{p.name}</span>
                      <EdgeDetail pitcher={p} />
                      <ConfidenceBar confidence={p.confidence} />
                    </div>
                    <span className="ml-3 shrink-0 rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400 tabular-nums">
                      {p.projection.toFixed(1)} {activeMeta.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
