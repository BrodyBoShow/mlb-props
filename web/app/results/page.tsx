import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import ResultsBoard, {
  type EvaluatedResult,
  type PropType,
  type Verdict,
} from "./ResultsBoard";

// Always read fresh — graded rows land throughout the day as games finish.
export const dynamic = "force-dynamic";

// Look at this many days of history. 7 keeps the table readable while still
// giving enough rows for a stable hit-rate signal once data accumulates.
const LOOKBACK_DAYS = 7;

// Bookmaker preference. We score against ONE book per prop so the hit rate
// is consistent — comparing model leans across mixed books would muddy the
// signal. Main-market US books first (DK / FD / Pinnacle), then DFS apps.
// Anything outside the list is still accepted as a last resort so a market
// only listed at a fringe book isn't silently dropped.
const BOOK_PREFERENCE = [
  "draftkings", "fanduel", "pinnacle",
  "prizepicks", "underdog", "betr", "sleeper",
] as const;

// Skip props where projection is within this much of the line. Too close to
// call a lean direction either way.
const NO_LEAN_THRESHOLD = 0.1;

// Map every prop_type to the column in player_game_logs that holds its actual.
const ACTUAL_COLUMN: Record<PropType, string> = {
  strikeouts:             "actual_strikeouts",
  hits_allowed:           "actual_hits_allowed",
  walks:                  "actual_walks",
  earned_runs:            "actual_earned_runs",
  outs_recorded:          "actual_outs_recorded",
  pitcher_fantasy_score:  "actual_pitcher_fantasy_score",
  hitter_hits:            "actual_hits",
  hitter_total_bases:     "actual_total_bases",
  hitter_rbis:            "actual_rbis",
  hitter_runs:            "actual_runs",
  hitter_home_runs:       "actual_home_runs",
  hitter_fantasy_score:   "actual_hitter_fantasy_score",
};

// Minimum line value to count as a "main market" line. Anything below is an
// alternate (e.g. 0.5 hits, 1.5 strikeouts) which lands as a hit so often it
// inflates the hit rate without telling us anything about the model. Props
// not listed in this map are excluded from results entirely.
//
// EXCLUDED entirely:
//   - hitter_home_runs: 0.5 line dominates and the model has no HR signal yet.
//   - hitter_runs:      no real main market line above 0.5; rate is base-rate noise.
//   - hitter_rbis:      same — most listed lines are 0.5 alternates.
const MIN_LINE: Partial<Record<PropType, number>> = {
  strikeouts:             3.5,   // bumped from 2.5 — 2.5 was still alternate-ish
  hits_allowed:           3.5,
  walks:                  1.5,
  earned_runs:            1.5,
  outs_recorded:          10.5,  // pitchers going past 4 IP — filters short relievers
  pitcher_fantasy_score:  6.0,   // floor for a real outing — short relief stints filtered
  hitter_hits:            1.5,
  hitter_total_bases:     1.5,
  hitter_fantasy_score:   4.0,   // ~1 hit + run/RBI floor — filters bench/pinch appearances
};

const ALL_PROP_TYPES = Object.keys(ACTUAL_COLUMN) as PropType[];

// ── raw row shapes ───────────────────────────────────────────────────────────

type ProjectionRow = {
  game_id: number;
  player_id: number;
  prop_type: string;
  projection: number;
  projection_date: string;
  players: { full_name: string | null } | null;
  games: { home_team: string; away_team: string } | null;
};

type LineRow = {
  player_id: number;
  prop_type: string;
  bookmaker: string;
  line: number;
  game_date: string;
};

// player_game_logs rows hold every actual column. We index dynamically by
// the prop_type → column map above, so the row shape is just an indexable bag.
type LogRow = {
  player_id: number;
  game_date: string;
  [key: string]: number | string | null;
};

// ── scoring ──────────────────────────────────────────────────────────────────

function classify(projection: number, line: number, actual: number): Verdict {
  if (Math.abs(projection - line) < NO_LEAN_THRESHOLD) return "skip";
  if (projection > line) {
    // Over lean — correct if actual > line.
    return actual > line ? "correct" : "wrong";
  }
  // Under lean — correct if actual < line.
  return actual < line ? "correct" : "wrong";
}

// ── data fetch ───────────────────────────────────────────────────────────────

async function getResults(): Promise<{
  results: EvaluatedResult[];
  dateRange: { start: string; end: string } | null;
}> {
  const supabase = getSupabaseClient();

  // Anchor the window on the most recent graded date (so weekends/off-days
  // don't show an empty page). Compute start by stepping back LOOKBACK_DAYS.
  const { data: latest } = await supabase
    .from("player_game_logs")
    .select("game_date")
    .order("game_date", { ascending: false })
    .limit(1);

  if (!latest?.[0]?.game_date) return { results: [], dateRange: null };

  const endDate = latest[0].game_date as string;
  const start = new Date(`${endDate}T00:00:00`);
  start.setDate(start.getDate() - (LOOKBACK_DAYS - 1));
  const startDate = start.toISOString().slice(0, 10);

  // Fetch the three tables in parallel for the window.
  const [{ data: projData }, { data: lineData }, { data: logData }] =
    await Promise.all([
      supabase
        .from("projections")
        .select(
          "game_id, player_id, prop_type, projection, projection_date, " +
            "players(full_name), games(home_team, away_team)"
        )
        .gte("projection_date", startDate)
        .lte("projection_date", endDate),

      supabase
        .from("lines")
        .select("player_id, prop_type, bookmaker, line, game_date")
        .gte("game_date", startDate)
        .lte("game_date", endDate),

      supabase
        .from("player_game_logs")
        .select(
          "player_id, game_date, " +
            Object.values(ACTUAL_COLUMN).join(", ")
        )
        .gte("game_date", startDate)
        .lte("game_date", endDate),
    ]);

  const projections = (projData ?? []) as unknown as ProjectionRow[];
  const lines = (lineData ?? []) as unknown as LineRow[];
  const logs = (logData ?? []) as unknown as LogRow[];

  // earned_runs diagnostic — visible in Vercel function logs / dev terminal.
  // The string match is the same across baseline.py / lines.py / grade.py /
  // ACTUAL_COLUMN, so this isolates which stage drops the rows.
  const erProj = projections.filter((r) => r.prop_type === "earned_runs").length;
  const erLines = lines.filter((r) => r.prop_type === "earned_runs").length;
  const erLogs = logs.filter(
    (r) => (r as LogRow).actual_earned_runs !== null &&
           (r as LogRow).actual_earned_runs !== undefined
  ).length;
  console.log(
    `[results-diag] earned_runs window ${startDate}..${endDate}: ` +
      `proj=${erProj} lines=${erLines} logs=${erLogs}`
  );

  // ── reduce lines to one per (player, prop, date) by book preference ────
  const linesByKey = new Map<string, LineRow>();
  const bookRank = (b: string): number => {
    const i = BOOK_PREFERENCE.indexOf(b as (typeof BOOK_PREFERENCE)[number]);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  for (const l of lines) {
    const key = `${l.player_id}|${l.prop_type}|${l.game_date}`;
    const existing = linesByKey.get(key);
    if (!existing || bookRank(l.bookmaker) < bookRank(existing.bookmaker)) {
      linesByKey.set(key, l);
    }
  }

  // ── logs keyed by (player, date) — we extract actuals per prop_type ────
  const logsByKey = new Map<string, LogRow>();
  for (const l of logs) {
    logsByKey.set(`${l.player_id}|${l.game_date}`, l);
  }

  // ── join projections → lines → logs ────────────────────────────────────
  // Track per-stage drop counts for earned_runs so the diagnostic above is
  // actionable — we can see whether rows die at the line lookup, the
  // threshold gate, the log lookup, or the actual-column extraction.
  const erDrop = { noLine: 0, belowMin: 0, noLog: 0, noActual: 0, survived: 0 };

  const results: EvaluatedResult[] = [];
  for (const p of projections) {
    const propType = p.prop_type as PropType;
    const actualCol = ACTUAL_COLUMN[propType];
    if (!actualCol) continue;

    // Main-market threshold. Props absent from MIN_LINE (hitter_runs,
    // hitter_rbis, hitter_home_runs) are excluded entirely. Alternate
    // lines below the threshold are dropped so the hit rate reflects
    // real markets.
    const minLine = MIN_LINE[propType];
    if (minLine === undefined) continue;

    const isER = propType === "earned_runs";

    const line = linesByKey.get(
      `${p.player_id}|${p.prop_type}|${p.projection_date}`
    );
    if (!line) { if (isER) erDrop.noLine++; continue; }
    if (line.line < minLine) { if (isER) erDrop.belowMin++; continue; }

    const log = logsByKey.get(`${p.player_id}|${p.projection_date}`);
    if (!log) { if (isER) erDrop.noLog++; continue; }

    const actualRaw = log[actualCol];
    if (actualRaw === null || actualRaw === undefined) {
      if (isER) erDrop.noActual++;
      continue;
    }
    const actual = Number(actualRaw);
    if (!Number.isFinite(actual)) continue;
    if (isER) erDrop.survived++;

    const verdict = classify(p.projection, line.line, actual);
    const matchup = p.games
      ? `${p.games.away_team} @ ${p.games.home_team}`
      : `Game ${p.game_id}`;
    results.push({
      gameId: p.game_id,
      matchup,
      playerId: p.player_id,
      playerName: p.players?.full_name ?? "Unknown player",
      propType,
      gameDate: p.projection_date,
      projection: p.projection,
      line: line.line,
      bookmaker: line.bookmaker,
      actual,
      lean: p.projection > line.line ? "over" : p.projection < line.line ? "under" : "none",
      verdict,
    });
  }

  console.log(
    `[results-diag] earned_runs join drop: noLine=${erDrop.noLine} ` +
      `belowMin=${erDrop.belowMin} noLog=${erDrop.noLog} ` +
      `noActual=${erDrop.noActual} survived=${erDrop.survived} ` +
      `(threshold=${MIN_LINE.earned_runs})`
  );

  // Newest first; stable secondary sort by player name.
  results.sort((a, b) => {
    if (a.gameDate !== b.gameDate) return a.gameDate < b.gameDate ? 1 : -1;
    return a.playerName.localeCompare(b.playerName);
  });

  return { results, dateRange: { start: startDate, end: endDate } };
}

// ── page ─────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default async function ResultsPage() {
  const { results, dateRange } = await getResults();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Results</h1>
          <p className="mt-1 text-sm text-slate-400">
            {dateRange
              ? `Hit rate vs DraftKings line · ${formatDate(dateRange.start)} – ${formatDate(dateRange.end)}`
              : "No graded results yet"}
          </p>
        </div>
        <Link
          href="/"
          className="mt-1 text-sm text-slate-400 transition-colors hover:text-slate-200"
        >
          ← Props
        </Link>
      </header>

      {results.length > 0 ? (
        <ResultsBoard results={results} />
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No evaluable results yet — need projections + lines + graded actuals
          on the same day. Check back once a few full slates accumulate.
        </div>
      )}

      <footer className="mt-10 text-center text-xs leading-relaxed text-slate-600">
        Hit = projection&apos;s lean direction matches actual vs. line. Props
        within {NO_LEAN_THRESHOLD} of the line are skipped (no lean). Main
        market lines only. Excluded entirely: home runs, runs, RBIs (one-sided
        markets or no main line above 0.5). Fantasy score uses the official
        PrizePicks scoring formula and PrizePicks lines only.
      </footer>
    </main>
  );
}
