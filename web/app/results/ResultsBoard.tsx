"use client";

import { useMemo, useState } from "react";

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

export type Verdict = "correct" | "wrong" | "skip";

export type EvaluatedResult = {
  gameId: number;
  matchup: string;        // "Away @ Home"
  playerId: number;
  playerName: string;
  propType: PropType;
  gameDate: string;       // 'YYYY-MM-DD'
  projection: number;
  line: number;
  bookmaker: string;
  actual: number;
  lean: "over" | "under" | "none";
  verdict: Verdict;
};

// Lean-bias detection. When the model leans one direction on more than
// BIAS_THRESHOLD of evaluated rows for a prop, the hit rate is reflecting the
// underlying base rate (e.g. "actual < line" hitting 75% of the time on
// hitter_hits 1.5 lines) rather than model signal. We flag and de-emphasize.
const BIAS_THRESHOLD = 0.8;
const BIAS_MIN_SAMPLES = 5;

export const PROP_LABELS: Record<PropType, string> = {
  strikeouts:         "Strikeouts",
  hits_allowed:       "Hits Allowed",
  walks:              "Walks",
  earned_runs:        "Earned Runs",
  outs_recorded:      "Outs",
  hitter_hits:        "Hits",
  hitter_total_bases: "Total Bases",
  hitter_rbis:        "RBIs",
  hitter_runs:        "Runs",
  hitter_home_runs:   "Home Runs",
};

const PITCHER_PROPS: PropType[] = [
  "strikeouts", "hits_allowed", "walks", "earned_runs", "outs_recorded",
];
const HITTER_PROPS: PropType[] = [
  "hitter_hits", "hitter_total_bases", "hitter_rbis", "hitter_runs", "hitter_home_runs",
];

type Filter = "all" | "pitcher" | "hitter" | PropType;

// Per-prop lean tilt. Returns true when >= BIAS_MIN_SAMPLES rows exist for
// the prop AND one direction holds > BIAS_THRESHOLD share.
function isBiased(results: EvaluatedResult[], pt: PropType): boolean {
  let over = 0;
  let under = 0;
  for (const r of results) {
    if (r.propType !== pt) continue;
    if (r.lean === "over") over++;
    else if (r.lean === "under") under++;
  }
  const total = over + under;
  if (total < BIAS_MIN_SAMPLES) return false;
  return over / total > BIAS_THRESHOLD || under / total > BIAS_THRESHOLD;
}

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

function fmt(n: number): string {
  // Show integers without a trailing .0; floats to one decimal.
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── summary cards ────────────────────────────────────────────────────────────

function OverallCard({ results }: { results: EvaluatedResult[] }) {
  const correct = results.filter((r) => r.verdict === "correct").length;
  const wrong = results.filter((r) => r.verdict === "wrong").length;
  const skip = results.filter((r) => r.verdict === "skip").length;
  const evaluable = correct + wrong;
  const color = rateColor(correct, evaluable);

  return (
    <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          Overall
        </h2>
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

function PerPropCard({ results }: { results: EvaluatedResult[] }) {
  const allTypes: PropType[] = [...PITCHER_PROPS, ...HITTER_PROPS];
  const rows = allTypes
    .map((pt) => {
      const sub = results.filter((r) => r.propType === pt);
      const correct = sub.filter((r) => r.verdict === "correct").length;
      const wrong = sub.filter((r) => r.verdict === "wrong").length;
      const skip = sub.filter((r) => r.verdict === "skip").length;
      return {
        propType: pt,
        correct,
        wrong,
        skip,
        evaluable: correct + wrong,
        biased: isBiased(results, pt),
      };
    })
    .filter((r) => r.evaluable + r.skip > 0);

  if (rows.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/50">
      <div className="border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-slate-400">
          By prop type
        </h2>
      </div>
      <ul className="divide-y divide-slate-800">
        {rows.map((r) => {
          // Biased rows: dim the percentage so it doesn't read as a clean
          // model-quality signal, and append a warning chip beside the label.
          const rateClass = r.biased
            ? "text-slate-500"
            : rateColor(r.correct, r.evaluable);
          return (
            <li
              key={r.propType}
              className="flex items-center justify-between px-5 py-2.5 text-sm"
            >
              <span className="flex items-center gap-2">
                <span className={r.biased ? "text-slate-400" : "text-slate-200"}>
                  {PROP_LABELS[r.propType]}
                </span>
                {r.biased && (
                  <span
                    className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400"
                    title="Model leans one direction on >80% of rows for this prop — hit rate likely reflects base rate, not signal."
                  >
                    ⚠ lean bias
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
                <span className={`w-12 text-right font-semibold ${rateClass}`}>
                  {pct(r.correct, r.evaluable)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── filter chips ─────────────────────────────────────────────────────────────

function FilterBar({
  active,
  setActive,
  results,
}: {
  active: Filter;
  setActive: (f: Filter) => void;
  results: EvaluatedResult[];
}) {
  // Only show prop chips that actually have rows.
  const propsWithRows = new Set(results.map((r) => r.propType));
  const propChips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pitcher", label: "Pitcher" },
    { key: "hitter", label: "Hitter" },
    ...[...PITCHER_PROPS, ...HITTER_PROPS]
      .filter((pt) => propsWithRows.has(pt))
      .map((pt) => ({ key: pt as Filter, label: PROP_LABELS[pt] })),
  ];

  return (
    <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
      {propChips.map((c) => (
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

// ── result row ───────────────────────────────────────────────────────────────

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

function ResultRow({ r }: { r: EvaluatedResult }) {
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

// ── main component ───────────────────────────────────────────────────────────

// ── game filter ──────────────────────────────────────────────────────────────
// "All games" plus one option per distinct game in the result set, labeled
// "Away @ Home · Sun, May 30". Sorted newest-first so the freshest slate is
// at the top of the dropdown.

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
  // Preserve first-encounter order (results are already newest-first sorted
  // upstream), so the most recent games appear first in the dropdown.
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

// ── main component ───────────────────────────────────────────────────────────

export default function ResultsBoard({ results }: { results: EvaluatedResult[] }) {
  const [propFilter, setPropFilter] = useState<Filter>("all");
  const [gameFilter, setGameFilter] = useState<GameKey>("all");

  // Apply prop filter first, then game filter. Both are independent.
  const filtered = useMemo(() => {
    let r = results;
    if (propFilter === "pitcher") r = r.filter((x) => PITCHER_PROPS.includes(x.propType));
    else if (propFilter === "hitter") r = r.filter((x) => HITTER_PROPS.includes(x.propType));
    else if (propFilter !== "all") r = r.filter((x) => x.propType === propFilter);
    if (gameFilter !== "all") r = r.filter((x) => x.gameId === gameFilter);
    return r;
  }, [propFilter, gameFilter, results]);

  // Group filtered rows by game, preserving the newest-first iteration order.
  const byGame = useMemo(() => {
    const m = new Map<
      number,
      { matchup: string; date: string; rows: EvaluatedResult[] }
    >();
    for (const r of filtered) {
      const g = m.get(r.gameId);
      if (g) {
        g.rows.push(r);
      } else {
        m.set(r.gameId, { matchup: r.matchup, date: r.gameDate, rows: [r] });
      }
    }
    return [...m.entries()];
  }, [filtered]);

  return (
    <>
      {/* summary uses the FILTERED set so the headline matches what's listed below */}
      <OverallCard results={filtered} />
      {/* per-prop breakdown always uses the FULL set so the user sees per-prop
          coverage even while filtered */}
      <PerPropCard results={results} />

      <FilterBar active={propFilter} setActive={setPropFilter} results={results} />
      <GameFilter active={gameFilter} setActive={setGameFilter} results={results} />

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

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No results match this filter.
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
                    <p className="text-xs text-slate-500">{formatShortDate(g.date)}</p>
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
                    <ResultRow
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
    </>
  );
}
