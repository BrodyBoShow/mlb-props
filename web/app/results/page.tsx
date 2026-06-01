import Link from "next/link";
import { fetchAllPages, getSupabaseClient } from "@/lib/supabase";
import { ALL_PROP_TYPES, TRACKER_PROPS } from "@/lib/constants";
import type {
  EvaluatedResult,
  PropType,
  TrackerResult,
  Verdict,
} from "@/lib/types";
import ResultsBoard from "./ResultsBoard";

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

// Minimum line value to count as a "main market" line for the BETTING EDGE
// section. Props absent from this map are not evaluated against book lines
// at all -- they go through the Model Tracker section (calibration only,
// no lines required).
//
// Betting Edge (these props): strikeouts, hits_allowed, outs_recorded,
//                             pitcher_fantasy_score, hitter_fantasy_score
// Model Tracker:             walks, earned_runs, hitter_hits,
//                             hitter_total_bases (see TRACKER_PROPS below)
// Excluded entirely:          home runs, runs, RBIs (one-sided markets).
const MIN_LINE: Partial<Record<PropType, number>> = {
  strikeouts:             3.5,
  // Hits allowed: lowered from 3.5 to 2.5. Back-end-rotation arms with
  // 5 IP expected lines posted at 2.5 were being dropped; the result was
  // 0/0 rows for hits_allowed even when projections + logs both existed.
  // 2.5 still excludes any 1.5 alternates posted on DFS books.
  hits_allowed:           2.5,
  // Outs recorded: ParlayAPI returns 0 player_pitcher_outs lines from
  // every book we ingest. Effectively never evaluated -- the per-prop
  // card surfaces this clearly with "no lines yet".
  outs_recorded:          10.5,
  pitcher_fantasy_score:  6.0,
  hitter_fantasy_score:   4.0,
};

// TRACKER_PROPS + ALL_PROP_TYPES now live in @/lib/constants — imported above.

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
  bettingResults: EvaluatedResult[];
  trackerResults: TrackerResult[];
  dateRange: { start: string; end: string } | null;
  trackedFrom: Partial<Record<PropType, string>>;
}> {
  const supabase = getSupabaseClient();

  // Anchor the window on whichever is more recent: the latest graded game
  // date or the latest date with any line in the lines table. This lets
  // newly-ingested prop_types (whose first lines are dated today, before
  // today's games finish) appear in results as soon as the next grading
  // cycle catches up -- without waiting for them to drift into the
  // historical log window.
  const [{ data: latestLog }, { data: latestLine }] = await Promise.all([
    supabase
      .from("player_game_logs")
      .select("game_date")
      .order("game_date", { ascending: false })
      .limit(1),
    supabase
      .from("lines")
      .select("game_date")
      .order("game_date", { ascending: false })
      .limit(1),
  ]);

  const latestLogDate = latestLog?.[0]?.game_date as string | undefined;
  const latestLineDate = latestLine?.[0]?.game_date as string | undefined;
  // Empty state: nothing graded AND no lines either.
  if (!latestLogDate && !latestLineDate) {
    return { bettingResults: [], trackerResults: [], dateRange: null, trackedFrom: {} };
  }
  const endDate =
    latestLogDate && latestLineDate
      ? (latestLogDate > latestLineDate ? latestLogDate : latestLineDate)
      : (latestLogDate ?? latestLineDate!);

  const start = new Date(`${endDate}T00:00:00`);
  start.setDate(start.getDate() - (LOOKBACK_DAYS - 1));
  const startDate = start.toISOString().slice(0, 10);

  // Fetch the three tables in parallel for the window.
  //
  // CRITICAL: Supabase enforces a 1000-row cap server-side that .limit()
  // does NOT override (the b32e840 commit tried; the diag still showed
  // betting=4 after deploy). The actual mechanism PostgREST honors is the
  // Range header, exposed via .range(from, to). We paginate in 1000-row
  // chunks until the server returns less than a full page.
  //
  // For /results, the 7-day window pulls projections (~20k), lines (~10k),
  // and logs (~2k). The 1000-row cap was the silent killer behind every
  // "no data" report on these props -- the most populous prop_types
  // (hitter_hits, hitter_total_bases) filled the 1000-row quota and the
  // rest of the prop_types returned zero rows downstream. We use the shared
  // fetchAllPages helper from @/lib/supabase, which handles the Range-header
  // pagination uniformly across pages.

  // trackedFrom: earliest game_date per prop_type across ALL history (not
  // just this window). Previously 12 separate round-trips (one per prop);
  // now a single ordered scan with JS dedup. The select is paginated to
  // bypass Supabase's 1000-row cap — lines accumulates roughly N_props ×
  // N_books × N_days rows, well over 1000 for any non-trivial history.
  type TrackedFromRow = { prop_type: string; game_date: string };

  const [projData, lineData, logData, trackedFromRows] = await Promise.all([
    fetchAllPages<ProjectionRow>(
      (from, to) =>
        supabase
          .from("projections")
          .select(
            "game_id, player_id, prop_type, projection, projection_date, " +
              "players(full_name), games(home_team, away_team)",
          )
          .gte("projection_date", startDate)
          .lte("projection_date", endDate)
          .range(from, to) as unknown as PromiseLike<{
            data: ProjectionRow[] | null;
            error: unknown;
          }>,
      "projections",
    ),

    fetchAllPages<LineRow>(
      (from, to) =>
        supabase
          .from("lines")
          .select("player_id, prop_type, bookmaker, line, game_date")
          .gte("game_date", startDate)
          .lte("game_date", endDate)
          .range(from, to) as unknown as PromiseLike<{
            data: LineRow[] | null;
            error: unknown;
          }>,
      "lines",
    ),

    fetchAllPages<LogRow>(
      (from, to) =>
        supabase
          .from("player_game_logs")
          .select(
            "player_id, game_date, " + Object.values(ACTUAL_COLUMN).join(", "),
          )
          .gte("game_date", startDate)
          .lte("game_date", endDate)
          .range(from, to) as unknown as PromiseLike<{
            data: LogRow[] | null;
            error: unknown;
          }>,
      "logs",
    ),

    fetchAllPages<TrackedFromRow>(
      (from, to) =>
        supabase
          .from("lines")
          .select("prop_type, game_date")
          .in("prop_type", ALL_PROP_TYPES as string[])
          .order("game_date", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: TrackedFromRow[] | null;
            error: unknown;
          }>,
      "tracked-from",
    ),
  ]);

  console.log(
    `[results-diag] fetched (paginated): ` +
      `projections=${projData.length} lines=${lineData.length} logs=${logData.length}`,
  );

  const projections = projData;
  const lines = lineData;
  const logs = logData;

  // Reduce the ordered-ascending trackedFromRows to one entry per prop_type
  // by keeping the first occurrence (earliest date). The fetch above is
  // ordered by game_date ascending so the first row seen per prop_type IS
  // the all-time tracked-from date — even if this window only spans 7 days.
  const trackedFrom: Partial<Record<PropType, string>> = {};
  for (const row of trackedFromRows) {
    const pt = row.prop_type as PropType;
    if (!trackedFrom[pt]) trackedFrom[pt] = row.game_date;
  }

  // Diagnostic logging — visible in Vercel function logs / dev terminal.
  // Covers every prop_type we evaluate so a future "missing prop" is
  // diagnosable from logs alone. proj / lines / logs counts isolate which
  // stage is empty; the per-stage drop counter below pinpoints the join.
  const DIAG_PROPS: PropType[] = [
    "strikeouts", "hits_allowed", "walks", "earned_runs", "outs_recorded",
    "pitcher_fantasy_score",
    "hitter_hits", "hitter_total_bases", "hitter_fantasy_score",
  ];
  for (const pt of DIAG_PROPS) {
    const col = ACTUAL_COLUMN[pt];
    const projCount = projections.filter((r) => r.prop_type === pt).length;
    const lineCount = lines.filter((r) => r.prop_type === pt).length;
    const logCount = logs.filter(
      (r) => (r as LogRow)[col] !== null && (r as LogRow)[col] !== undefined,
    ).length;
    console.log(
      `[results-diag] ${pt} window ${startDate}..${endDate}: ` +
        `proj=${projCount} lines=${lineCount} logs=${logCount} ` +
        `tracked_from=${trackedFrom[pt] ?? "never"}`,
    );
  }

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

  // ── join: project + line + log → BettingResult (Section 1)
  //         project + log → TrackerResult (Section 2, no line needed) ──────
  // Per-prop drop counter for the betting join so the diagnostic logs are
  // actionable for every prop_type, not just earned_runs. Each dropping
  // stage bumps the corresponding counter; totals are logged at the end.
  type DropCounter = {
    noLine: number; belowMin: number;
    noLog: number; noActual: number; survived: number;
  };
  const drops = new Map<PropType, DropCounter>();
  const trackDrop = (pt: PropType, stage: keyof DropCounter) => {
    const c = drops.get(pt) ?? {
      noLine: 0, belowMin: 0, noLog: 0, noActual: 0, survived: 0,
    };
    c[stage]++;
    drops.set(pt, c);
  };

  const bettingResults: EvaluatedResult[] = [];
  const trackerResults: TrackerResult[] = [];

  for (const p of projections) {
    const propType = p.prop_type as PropType;
    const actualCol = ACTUAL_COLUMN[propType];
    if (!actualCol) continue;

    const matchup = p.games
      ? `${p.games.away_team} @ ${p.games.home_team}`
      : `Game ${p.game_id}`;

    // ── Section 2 (Model Tracker) — projection vs actual, no line needed.
    if (TRACKER_PROPS.has(propType)) {
      const log = logsByKey.get(`${p.player_id}|${p.projection_date}`);
      if (!log) continue;
      const actualRaw = log[actualCol];
      if (actualRaw === null || actualRaw === undefined) continue;
      const actual = Number(actualRaw);
      if (!Number.isFinite(actual)) continue;

      trackerResults.push({
        gameId: p.game_id,
        matchup,
        playerId: p.player_id,
        playerName: p.players?.full_name ?? "Unknown player",
        propType,
        gameDate: p.projection_date,
        projection: p.projection,
        actual,
        direction: actual > p.projection ? "over" : "under",
      });
      continue;
    }

    // ── Section 1 (Betting Edge) — needs line + actual.
    const minLine = MIN_LINE[propType];
    if (minLine === undefined) continue;   // prop not on either side -- excluded

    const line = linesByKey.get(
      `${p.player_id}|${p.prop_type}|${p.projection_date}`
    );
    if (!line) { trackDrop(propType, "noLine"); continue; }
    if (line.line < minLine) { trackDrop(propType, "belowMin"); continue; }

    const log = logsByKey.get(`${p.player_id}|${p.projection_date}`);
    if (!log) { trackDrop(propType, "noLog"); continue; }

    const actualRaw = log[actualCol];
    if (actualRaw === null || actualRaw === undefined) {
      trackDrop(propType, "noActual");
      continue;
    }
    const actual = Number(actualRaw);
    if (!Number.isFinite(actual)) continue;
    trackDrop(propType, "survived");

    const verdict = classify(p.projection, line.line, actual);
    bettingResults.push({
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

  for (const pt of DIAG_PROPS) {
    const d = drops.get(pt);
    if (!d) continue;
    console.log(
      `[results-diag] ${pt} join drop: ` +
        `noLine=${d.noLine} belowMin=${d.belowMin} ` +
        `noLog=${d.noLog} noActual=${d.noActual} ` +
        `survived=${d.survived} (threshold=${MIN_LINE[pt]})`,
    );
  }
  console.log(
    `[results-diag] section totals: ` +
      `betting=${bettingResults.length} tracker=${trackerResults.length}`,
  );

  // Newest first; stable secondary sort by player name. Same sort for both
  // sections so the lists feel consistent.
  const sortNewestFirst = <T extends { gameDate: string; playerName: string }>(a: T, b: T) => {
    if (a.gameDate !== b.gameDate) return a.gameDate < b.gameDate ? 1 : -1;
    return a.playerName.localeCompare(b.playerName);
  };
  bettingResults.sort(sortNewestFirst);
  trackerResults.sort(sortNewestFirst);

  return {
    bettingResults,
    trackerResults,
    dateRange: { start: startDate, end: endDate },
    trackedFrom,
  };
}

// ── page ─────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default async function ResultsPage() {
  const { bettingResults, trackerResults, dateRange, trackedFrom } =
    await getResults();
  const hasAny = bettingResults.length + trackerResults.length > 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Results</h1>
          <p className="mt-1 text-sm text-slate-400">
            {dateRange
              ? `${formatDate(dateRange.start)} – ${formatDate(dateRange.end)}`
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

      {hasAny ? (
        <ResultsBoard
          bettingResults={bettingResults}
          trackerResults={trackerResults}
          trackedFrom={trackedFrom}
        />
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No evaluable results yet — projections need to land alongside graded
          actuals (and book lines, for the Betting Edge section). Check back
          once a few full slates accumulate.
        </div>
      )}

      <footer className="mt-10 text-center text-xs leading-relaxed text-slate-600">
        <span className="text-slate-500">Betting Edge:</span> hit = projection&apos;s
        lean direction matches actual vs. book line. Props within{" "}
        {NO_LEAN_THRESHOLD} of the line are skipped. Main market lines only.
        Fantasy score uses the official PrizePicks scoring formula and
        PrizePicks lines only.
        <br />
        <span className="text-slate-500">Model Tracker:</span> actual vs
        projection only (no book line) — a calibration metric, not a betting
        hit rate.
      </footer>
    </main>
  );
}
