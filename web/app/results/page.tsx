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
  strikeouts:         "actual_strikeouts",
  hits_allowed:       "actual_hits_allowed",
  walks:              "actual_walks",
  earned_runs:        "actual_earned_runs",
  outs_recorded:      "actual_outs_recorded",
  hitter_hits:        "actual_hits",
  hitter_total_bases: "actual_total_bases",
  hitter_rbis:        "actual_rbis",
  hitter_runs:        "actual_runs",
  hitter_home_runs:   "actual_home_runs",
};

// Minimum line value to count as a "main market" line. Anything below is an
// alternate (e.g. 0.5 hits, 1.5 strikeouts) which lands as a hit so often it
// inflates the hit rate without telling us anything about the model. Props
// not listed in this map are excluded from results entirely — see hitter_home_runs.
const MIN_LINE: Partial<Record<PropType, number>> = {
  strikeouts:         2.5,
  hits_allowed:       2.5,
  walks:              1.5,
  earned_runs:        1.5,
  outs_recorded:      10.5,
  hitter_hits:        1.5,   // drop 0.5 lines that hit ~70% baseline
  hitter_total_bases: 1.5,
  hitter_rbis:        1.5,   // drop 0.5 lines
  hitter_runs:        0.5,   // marginal but kept — there's no higher main market
  // hitter_home_runs deliberately omitted. 0.5 line dominates and the model
  // has no real HR signal yet, so any rate we report would be noise.
};

const ALL_PROP_TYPES = Object.keys(ACTUAL_COLUMN) as PropType[];

// ── raw row shapes ───────────────────────────────────────────────────────────

type ProjectionRow = {
  player_id: number;
  prop_type: string;
  projection: number;
  projection_date: string;
  players: { full_name: string | null } | null;
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
          "player_id, prop_type, projection, projection_date, players(full_name)"
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
  const results: EvaluatedResult[] = [];
  for (const p of projections) {
    const propType = p.prop_type as PropType;
    const actualCol = ACTUAL_COLUMN[propType];
    if (!actualCol) continue;

    // Main-market threshold. Props absent from MIN_LINE (currently just
    // hitter_home_runs) are excluded entirely. Alternate lines below the
    // threshold are dropped so the hit rate reflects real markets.
    const minLine = MIN_LINE[propType];
    if (minLine === undefined) continue;

    const line = linesByKey.get(
      `${p.player_id}|${p.prop_type}|${p.projection_date}`
    );
    if (!line) continue;
    if (line.line < minLine) continue;

    const log = logsByKey.get(`${p.player_id}|${p.projection_date}`);
    if (!log) continue;

    const actualRaw = log[actualCol];
    if (actualRaw === null || actualRaw === undefined) continue;
    const actual = Number(actualRaw);
    if (!Number.isFinite(actual)) continue;

    const verdict = classify(p.projection, line.line, actual);
    results.push({
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

      <footer className="mt-10 text-center text-xs text-slate-600">
        Hit = projection&apos;s lean direction matches actual vs. line. Props
        within {NO_LEAN_THRESHOLD} of the line are skipped (no lean). Main
        market lines only — alternate lines and home run props excluded.
      </footer>
    </main>
  );
}
