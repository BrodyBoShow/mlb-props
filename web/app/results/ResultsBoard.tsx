"use client";

import { useMemo, useState } from "react";

// ── types ────────────────────────────────────────────────────────────────────

export type PropType =
  | "strikeouts"
  | "hits_allowed"
  | "walks"
  | "earned_runs"
  | "outs_recorded"
  | "pitcher_fantasy_score"
  | "hitter_hits"
  | "hitter_total_bases"
  | "hitter_rbis"
  | "hitter_runs"
  | "hitter_home_runs"
  | "hitter_fantasy_score";

export type Verdict = "correct" | "wrong" | "skip";

// Betting Edge result — joined projection + book line + actual.
export type EvaluatedResult = {
  gameId: number;
  matchup: string;
  playerId: number;
  playerName: string;
  propType: PropType;
  gameDate: string;
  projection: number;
  line: number;
  bookmaker: string;
  actual: number;
  lean: "over" | "under" | "none";
  verdict: Verdict;
};

// Model Tracker result — projection + actual only, no book line. Used for
// calibration props (walks, earned_runs, hitter_hits, hitter_total_bases)
// where there is no clean main-market line to evaluate against.
export type TrackerResult = {
  gameId: number;
  matchup: string;
  playerId: number;
  playerName: string;
  propType: PropType;
  gameDate: string;
  projection: number;
  actual: number;
  direction: "over" | "under";   // actual > projection ? "over" : "under"
};

export const PROP_LABELS: Record<PropType, string> = {
  strikeouts:             "Strikeouts",
  hits_allowed:           "Hits Allowed",
  walks:                  "Walks",
  earned_runs:            "Earned Runs",
  outs_recorded:          "Outs",
  pitcher_fantasy_score:  "Pitcher Fantasy",
  hitter_hits:            "Hits",
  hitter_total_bases:     "Total Bases",
  hitter_rbis:            "RBIs",
  hitter_runs:            "Runs",
  hitter_home_runs:       "Home Runs",
  hitter_fantasy_score:   "Hitter Fantasy",
};

// ── prop groupings ───────────────────────────────────────────────────────────
// BETTING_* arrays drive the per-prop card + filter chips in Section 1. They
// list only the five "clean" props with balanced main-market lines.
// TRACKER_PROPS drives Section 2 (calibration only).

const BETTING_PITCHER_PROPS: PropType[] = [
  "strikeouts", "hits_allowed", "outs_recorded", "pitcher_fantasy_score",
];
const BETTING_HITTER_PROPS: PropType[] = ["hitter_fantasy_score"];

const TRACKER_PROPS: PropType[] = [
  "hitter_hits", "hitter_total_bases", "walks", "earned_runs",
];

// Section-1 filter union: All / Pitcher / Hitter group + each individual prop.
type Filter = "all" | "pitcher" | "hitter" | PropType;
// Section-2 filter union: All / each individual prop. No pitcher/hitter group
// here -- tracker has only 4 props, mixed types; chips are simpler.
type TrackerFilter = "all" | PropType;

// ── helpers ──────────────────────────────────────────────────────────────────

function pct(num: number, den: number): string {
  if (den === 0) return "—";
  return `${Math.round((num / den) * 100)}%`;
}

function rateColor(num: number, den: number): string {
  if (den === 0) return "text-slate-400";
  const r = num / den;
  if (r >= 0.6) return "text-emerald-400";
  if (r >= 0.45) return "text-amber-400";
  return "text-red-400";
}

function formatShortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTrackedFrom(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — BETTING EDGE
// ═════════════════════════════════════════════════════════════════════════════

function BettingOverallCard({ results }: { results: EvaluatedResult[] }) {
  const correct = results.filter((r) => r.verdict === "correct").length;
  const wrong = results.filter((r) => r.verdict === "wrong").length;
  const skip = results.filter((r) => r.verdict === "skip").length;
  const evaluable = correct + wrong;
  const color = rateColor(correct, evaluable);

  return (
    <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          Overall hit rate
        </h3>
        <span className={`text-3xl font-bold tabular-nums ${color}`}>
          {pct(correct, evaluable)}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-400">
        <span className="text-emerald-400 tabular-nums">{correct}</span> correct
        <span className="mx-1.5 text-slate-600">·</span>
        <span className="text-red-400 tabular-nums">{wrong}</span> wrong
        <span className="mx-1.5 text-slate-600">·</span>
        <span className="text-slate-500 tabular-nums">{skip}</span> skipped
        <span className="mx-1.5 text-slate-600">·</span>
        <span className="text-slate-500 tabular-nums">{results.length}</span> total
      </p>
    </div>
  );
}

function BettingPerPropCard({
  results,
  trackedFrom,
}: {
  results: EvaluatedResult[];
  trackedFrom: Partial<Record<PropType, string>>;
}) {
  const rows = [...BETTING_PITCHER_PROPS, ...BETTING_HITTER_PROPS]
    .map((pt) => {
      const sub = results.filter((r) => r.propType === pt);
      const correct = sub.filter((r) => r.verdict === "correct").length;
      const wrong = sub.filter((r) => r.verdict === "wrong").length;
      const skip = sub.filter((r) => r.verdict === "skip").length;
      return { propType: pt, correct, wrong, skip, evaluable: correct + wrong };
    })
    .filter((r) => r.evaluable + r.skip > 0);

  if (rows.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/50">
      <div className="border-b border-slate-800 px-5 py-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          By prop type
        </h3>
      </div>
      <ul className="divide-y divide-slate-800">
        {rows.map((r) => (
          <li
            key={r.propType}
            className="flex items-center justify-between px-5 py-2.5 text-sm"
          >
            <span className="flex flex-col items-start gap-0.5">
              <span className="text-slate-200">{PROP_LABELS[r.propType]}</span>
              {trackedFrom[r.propType] && (
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  tracked from {formatTrackedFrom(trackedFrom[r.propType]!)}
                </span>
              )}
            </span>
            <div className="flex items-center gap-3 tabular-nums">
              <span className="text-xs text-slate-500">
                {r.correct}/{r.evaluable}
                {r.skip > 0 && (
                  <span className="ml-1 text-slate-600">({r.skip} skip)</span>
                )}
              </span>
              <span className={`w-12 text-right font-semibold ${rateColor(r.correct, r.evaluable)}`}>
                {pct(r.correct, r.evaluable)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BettingFilterBar({
  active,
  setActive,
  results,
}: {
  active: Filter;
  setActive: (f: Filter) => void;
  results: EvaluatedResult[];
}) {
  const propsWithRows = new Set(results.map((r) => r.propType));
  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pitcher", label: "Pitcher" },
    { key: "hitter", label: "Hitter" },
    ...[...BETTING_PITCHER_PROPS, ...BETTING_HITTER_PROPS]
      .filter((pt) => propsWithRows.has(pt))
      .map((pt) => ({ key: pt as Filter, label: PROP_LABELS[pt] })),
  ];

  return (
    <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={() => setActive(c.key)}
          className={[
            "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
            active === c.key
              ? "bg-emerald-500 text-slate-950"
              : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
          ].join(" ")}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

type GameKey = number | "all";

function GameFilter({
  active,
  setActive,
  results,
}: {
  active: GameKey;
  setActive: (k: GameKey) => void;
  results: EvaluatedResult[];
}) {
  // Preserve first-encounter order (newest-first upstream).
  const seen = new Map<number, { matchup: string; date: string }>();
  for (const r of results) {
    if (!seen.has(r.gameId)) {
      seen.set(r.gameId, { matchup: r.matchup, date: r.gameDate });
    }
  }

  return (
    <div className="mb-4">
      <label className="block text-[10px] uppercase tracking-wider text-slate-500">
        Game
      </label>
      <select
        value={String(active)}
        onChange={(e) =>
          setActive(e.target.value === "all" ? "all" : Number(e.target.value))
        }
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
      >
        <option value="all">All games ({results.length} rows)</option>
        {[...seen.entries()].map(([gid, info]) => (
          <option key={gid} value={gid}>
            {info.matchup} · {formatShortDate(info.date)}
          </option>
        ))}
      </select>
    </div>
  );
}

function VerdictIcon({ v }: { v: Verdict }) {
  if (v === "correct") return <span className="text-emerald-400">✓</span>;
  if (v === "wrong") return <span className="text-red-400">✗</span>;
  return <span className="text-slate-500">—</span>;
}

function LeanIcon({ lean }: { lean: EvaluatedResult["lean"] }) {
  if (lean === "over") return <span className="text-emerald-400">▲</span>;
  if (lean === "under") return <span className="text-red-400">▼</span>;
  return <span className="text-slate-500">—</span>;
}

function BettingRow({ r }: { r: EvaluatedResult }) {
  return (
    <li className="grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-sm">
      <div className="col-span-4 min-w-0 truncate">
        <div className="truncate text-slate-100">{r.playerName}</div>
        <div className="truncate text-xs text-slate-500">{PROP_LABELS[r.propType]}</div>
      </div>
      <div className="col-span-5 flex items-center justify-end gap-3 tabular-nums">
        <span className="text-xs text-slate-500">
          <span className="text-slate-400">{fmt(r.projection)}</span>
          <span className="mx-1 text-slate-600">/</span>
          <span className="text-slate-400">{fmt(r.line)}</span>
          <span className="mx-1 text-slate-600">/</span>
          <span className="text-slate-200">{fmt(r.actual)}</span>
        </span>
        <span className="w-4 text-center"><LeanIcon lean={r.lean} /></span>
        <span className="w-4 text-center text-base"><VerdictIcon v={r.verdict} /></span>
      </div>
      <div className="col-span-3 text-right text-xs text-slate-500">
        {formatShortDate(r.gameDate)}
      </div>
    </li>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — MODEL TRACKER
// ═════════════════════════════════════════════════════════════════════════════
// Pure calibration view: actual vs projection, NO book line involved.
// Colors are slate-only -- this is not a betting hit rate, it's a model
// diagnostic, and using emerald/red would imply success/failure semantics
// that don't apply here.

const TRACKER_MIN_SAMPLES_FOR_LABEL = 10;
const TRACKER_BIAS_THRESHOLD = 0.6;   // 60% one-sided => calibration callout

function calibrationLabel(over: number, under: number): string {
  const total = over + under;
  if (total < TRACKER_MIN_SAMPLES_FOR_LABEL) return "~ Not enough data yet";
  const overShare = over / total;
  const underShare = under / total;
  if (underShare > TRACKER_BIAS_THRESHOLD) return "↓ Model tends to overestimate";
  if (overShare > TRACKER_BIAS_THRESHOLD) return "↑ Model tends to underestimate";
  return "~ Well calibrated";
}

function TrackerOverallCard({ results }: { results: TrackerResult[] }) {
  const over = results.filter((r) => r.direction === "over").length;
  const under = results.filter((r) => r.direction === "under").length;
  const total = over + under;
  const overPct = total > 0 ? Math.round((over / total) * 100) : 0;
  const underPct = total > 0 ? Math.round((under / total) * 100) : 0;
  const label = calibrationLabel(over, under);

  return (
    <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          Calibration
        </h3>
        <div className="flex items-baseline gap-2 text-2xl font-bold tabular-nums text-slate-200">
          <span>▲ {overPct}%</span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-400">▼ {underPct}%</span>
        </div>
      </div>
      <p className="mt-2 text-sm text-slate-400">
        <span className="text-slate-300">{label}</span>
        <span className="mx-1.5 text-slate-600">·</span>
        <span className="tabular-nums text-slate-500">{total}</span> evaluated
        <span className="mx-1.5 text-slate-600">·</span>
        <span className="text-slate-600">over = actual &gt; projection</span>
      </p>
    </div>
  );
}

function TrackerPerPropCard({
  results,
  trackedFrom,
}: {
  results: TrackerResult[];
  trackedFrom: Partial<Record<PropType, string>>;
}) {
  const rows = TRACKER_PROPS
    .map((pt) => {
      const sub = results.filter((r) => r.propType === pt);
      if (sub.length === 0) return null;
      const over = sub.filter((r) => r.direction === "over").length;
      const under = sub.length - over;
      return {
        propType: pt,
        total: sub.length,
        over,
        under,
        avgProj: avg(sub.map((r) => r.projection)),
        avgActual: avg(sub.map((r) => r.actual)),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/50">
      <div className="border-b border-slate-800 px-5 py-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          By prop type
        </h3>
      </div>
      <ul className="divide-y divide-slate-800">
        {rows.map((r) => {
          const overPct = Math.round((r.over / r.total) * 100);
          const underPct = 100 - overPct;
          return (
            <li
              key={r.propType}
              className="flex items-start justify-between px-5 py-2.5 text-sm"
            >
              <span className="flex flex-col items-start gap-0.5">
                <span className="text-slate-200">{PROP_LABELS[r.propType]}</span>
                {trackedFrom[r.propType] && (
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    tracked from {formatTrackedFrom(trackedFrom[r.propType]!)}
                  </span>
                )}
              </span>
              <div className="text-right text-xs tabular-nums">
                <div className="text-slate-400">
                  proj {r.avgProj.toFixed(2)}
                  <span className="mx-1 text-slate-600">·</span>
                  actual {r.avgActual.toFixed(2)}
                </div>
                <div className="text-slate-500">
                  <span className="text-slate-200">▲ {overPct}%</span>
                  <span className="mx-1 text-slate-600">/</span>
                  <span className="text-slate-400">▼ {underPct}%</span>
                  <span className="ml-1.5 text-slate-600">({r.total})</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TrackerFilterBar({
  active,
  setActive,
  results,
}: {
  active: TrackerFilter;
  setActive: (f: TrackerFilter) => void;
  results: TrackerResult[];
}) {
  const propsWithRows = new Set(results.map((r) => r.propType));
  const chips: { key: TrackerFilter; label: string }[] = [
    { key: "all", label: "All" },
    ...TRACKER_PROPS
      .filter((pt) => propsWithRows.has(pt))
      .map((pt) => ({ key: pt as TrackerFilter, label: PROP_LABELS[pt] })),
  ];

  return (
    <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={() => setActive(c.key)}
          className={[
            "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
            active === c.key
              ? "bg-slate-200 text-slate-950"   // muted slate, not emerald
              : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
          ].join(" ")}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function TrackerRow({ r }: { r: TrackerResult }) {
  const arrow =
    r.direction === "over" ? (
      <span className="text-slate-200">▲</span>
    ) : (
      <span className="text-slate-400">▼</span>
    );
  return (
    <li className="grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-sm">
      <div className="col-span-4 min-w-0 truncate">
        <div className="truncate text-slate-100">{r.playerName}</div>
        <div className="truncate text-xs text-slate-500">{PROP_LABELS[r.propType]}</div>
      </div>
      <div className="col-span-5 flex items-center justify-end gap-3 tabular-nums">
        <span className="text-xs text-slate-500">
          <span className="text-slate-400">{fmt(r.projection)}</span>
          <span className="mx-1 text-slate-600">/</span>
          <span className="text-slate-200">{fmt(r.actual)}</span>
        </span>
        <span className="w-4 text-center">{arrow}</span>
      </div>
      <div className="col-span-3 text-right text-xs text-slate-500">
        {formatShortDate(r.gameDate)}
      </div>
    </li>
  );
}

function TrackerSection({
  results,
  trackedFrom,
}: {
  results: TrackerResult[];
  trackedFrom: Partial<Record<PropType, string>>;
}) {
  const [filter, setFilter] = useState<TrackerFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return results;
    return results.filter((r) => r.propType === filter);
  }, [filter, results]);

  return (
    <>
      <TrackerOverallCard results={filtered} />
      <TrackerPerPropCard results={results} trackedFrom={trackedFrom} />

      <TrackerFilterBar active={filter} setActive={setFilter} results={results} />

      {/* column legend */}
      <div className="mb-2 grid grid-cols-12 gap-2 px-4 text-[10px] uppercase tracking-wider text-slate-500">
        <span className="col-span-4">Player / Prop</span>
        <div className="col-span-5 flex justify-end gap-3">
          <span>Proj / Actual</span>
          <span className="w-4 text-center">vs proj</span>
        </div>
        <span className="col-span-3 text-right">Date</span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No tracker rows for this prop.
        </div>
      ) : (
        <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
          {filtered.map((r, i) => (
            <TrackerRow
              key={`${r.playerId}-${r.propType}-${r.gameDate}-${i}`}
              r={r}
            />
          ))}
        </ul>
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN — both sections always visible, no tab switching
// ═════════════════════════════════════════════════════════════════════════════

export default function ResultsBoard({
  bettingResults,
  trackerResults,
  trackedFrom,
}: {
  bettingResults: EvaluatedResult[];
  trackerResults: TrackerResult[];
  // Per-prop earliest-line-ingested date — display only, no filtering effect.
  trackedFrom: Partial<Record<PropType, string>>;
}) {
  const [propFilter, setPropFilter] = useState<Filter>("all");
  const [gameFilter, setGameFilter] = useState<GameKey>("all");

  const filteredBetting = useMemo(() => {
    let r = bettingResults;
    if (propFilter === "pitcher") {
      r = r.filter((x) => BETTING_PITCHER_PROPS.includes(x.propType));
    } else if (propFilter === "hitter") {
      r = r.filter((x) => BETTING_HITTER_PROPS.includes(x.propType));
    } else if (propFilter !== "all") {
      r = r.filter((x) => x.propType === propFilter);
    }
    if (gameFilter !== "all") r = r.filter((x) => x.gameId === gameFilter);
    return r;
  }, [propFilter, gameFilter, bettingResults]);

  const byGame = useMemo(() => {
    const m = new Map<
      number,
      { matchup: string; date: string; rows: EvaluatedResult[] }
    >();
    for (const r of filteredBetting) {
      const g = m.get(r.gameId);
      if (g) g.rows.push(r);
      else m.set(r.gameId, { matchup: r.matchup, date: r.gameDate, rows: [r] });
    }
    return [...m.entries()];
  }, [filteredBetting]);

  return (
    <>
      {/* ── Section 1: Betting Edge ─────────────────────────────────────── */}
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Betting Edge</h2>
        <p className="text-xs text-slate-500">
          Model lean vs book line · main market props only
        </p>
      </header>

      <BettingOverallCard results={filteredBetting} />
      <BettingPerPropCard results={bettingResults} trackedFrom={trackedFrom} />

      <BettingFilterBar
        active={propFilter}
        setActive={setPropFilter}
        results={bettingResults}
      />
      <GameFilter
        active={gameFilter}
        setActive={setGameFilter}
        results={bettingResults}
      />

      {/* column legend */}
      <div className="mb-2 grid grid-cols-12 gap-2 px-4 text-[10px] uppercase tracking-wider text-slate-500">
        <span className="col-span-4">Player / Prop</span>
        <div className="col-span-5 flex justify-end gap-3">
          <span>Proj / Line / Actual</span>
          <span className="w-4 text-center">Lean</span>
          <span className="w-4 text-center">Hit</span>
        </div>
        <span className="col-span-3 text-right">Date</span>
      </div>

      {filteredBetting.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No betting-edge results match this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {byGame.map(([gid, g]) => {
            const correct = g.rows.filter((r) => r.verdict === "correct").length;
            const wrong = g.rows.filter((r) => r.verdict === "wrong").length;
            const evaluable = correct + wrong;
            return (
              <section
                key={gid}
                className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50"
              >
                <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-5 py-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-slate-200">
                      {g.matchup}
                    </h3>
                    <p className="text-xs text-slate-500">
                      {formatShortDate(g.date)}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-sm font-semibold tabular-nums ${rateColor(correct, evaluable)}`}
                  >
                    {pct(correct, evaluable)}
                    <span className="ml-1 text-xs font-normal text-slate-500">
                      ({correct}/{evaluable})
                    </span>
                  </span>
                </div>
                <ul className="divide-y divide-slate-800">
                  {g.rows.map((r, i) => (
                    <BettingRow
                      key={`${r.playerId}-${r.propType}-${r.gameDate}-${i}`}
                      r={r}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {/* ── divider ─────────────────────────────────────────────────────── */}
      <div className="my-10 border-t border-slate-800" />

      {/* ── Section 2: Model Tracker ────────────────────────────────────── */}
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-slate-100">Model Tracker</h2>
        <p className="text-xs text-slate-500">
          Actual outcomes vs model projection · calibration, not a betting rate
        </p>
      </header>

      <TrackerSection results={trackerResults} trackedFrom={trackedFrom} />
    </>
  );
}
