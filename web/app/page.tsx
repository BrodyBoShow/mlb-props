import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import PropBoard, { type ByProp, type GameGroup, type PropType } from "./PropBoard";

// Always read fresh from the DB at request time — the cron updates rows
// throughout the day. No caching of stale projections.
export const dynamic = "force-dynamic";

const ALL_PROP_TYPES: PropType[] = [
  "strikeouts",
  "hits_allowed",
  "walks",
  "earned_runs",
  "outs_recorded",
  "hitter_hits",
  "hitter_total_bases",
  "hitter_rbis",
  "hitter_runs",
  "hitter_home_runs",
];

// Simple guard for URL ?date= param — must be YYYY-MM-DD.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shape of a projection row with its joined player + game.
type ProjectionRow = {
  game_id: number;
  player_id: number;
  prop_type: string;
  projection: number;
  confidence: number | null;
  players: { full_name: string | null } | null;
  // start_time is the first-pitch UTC timestamp from the games table — used
  // to order the cards chronologically so the slate matches MLB's schedule
  // page. Nullable for slots statsapi reported as TBD.
  games: { home_team: string; away_team: string; start_time: string | null } | null;
};

// Shape of an edge row from the edges table. All values are pre-computed by
// the engine — the frontend never does any of this math.
type EdgeRow = {
  player_id: number;
  prop_type: string;
  bookmaker: string;
  line: number;
  fair_over_prob: number | null;
  model_over_prob: number | null;
  edge: number | null;
  over_price: number | null;
  under_price: number | null;
};

// Empty result used when there's no data to show.
const emptyResult = (date: string | null = null) => ({
  date,
  updatedAt: null as string | null,
  prevDate: null as string | null,
  nextDate: null as string | null,
  byProp: Object.fromEntries(
    ALL_PROP_TYPES.map((p) => [p, []])
  ) as unknown as ByProp,
});

async function getSlate(dateOverride?: string): Promise<{
  date: string | null;
  updatedAt: string | null;
  prevDate: string | null;
  nextDate: string | null;
  byProp: ByProp;
}> {
  const supabase = getSupabaseClient();

  // Resolve the date to display.
  let selectedDate: string;
  if (dateOverride) {
    selectedDate = dateOverride;
  } else {
    const { data: latest } = await supabase
      .from("projections")
      .select("projection_date")
      .order("projection_date", { ascending: false })
      .limit(1);
    if (!latest?.[0]?.projection_date) return emptyResult();
    selectedDate = latest[0].projection_date;
  }

  // Paginate projections + edges past Supabase's 1000-row server cap.
  // .limit() does NOT bypass it; only .range() does (see /results comment).
  const HOME_PAGE_SIZE = 1000;
  async function fetchAllHome<T>(
    build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < 50; page++) {
      const from = page * HOME_PAGE_SIZE;
      const to = from + HOME_PAGE_SIZE - 1;
      const { data, error } = await build(from, to);
      if (error || !data || data.length === 0) break;
      all.push(...data);
      if (data.length < HOME_PAGE_SIZE) break;
    }
    return all;
  }

  // Run all five reads in parallel: projections (paginated), edges
  // (paginated), updated_at, prev, next.
  const [projData, edgeData, { data: updatedAtData }, { data: prevData }, { data: nextData }] =
    await Promise.all([
      fetchAllHome<ProjectionRow>(
        (from, to) =>
          supabase
            .from("projections")
            .select(
              "game_id, player_id, prop_type, projection, confidence, players(full_name), games(home_team, away_team, start_time)",
            )
            .eq("projection_date", selectedDate)
            .in("prop_type", ALL_PROP_TYPES)
            .order("projection", { ascending: false })
            .range(from, to) as unknown as PromiseLike<{
              data: ProjectionRow[] | null;
              error: unknown;
            }>,
      ),

      fetchAllHome<EdgeRow>(
        (from, to) =>
          supabase
            .from("edges")
            .select(
              "player_id, prop_type, bookmaker, line, fair_over_prob, model_over_prob, edge, over_price, under_price",
            )
            .eq("game_date", selectedDate)
            .range(from, to) as unknown as PromiseLike<{
              data: EdgeRow[] | null;
              error: unknown;
            }>,
      ),

    // Most-recently-written row for the "Last updated" timestamp.
    supabase
      .from("projections")
      .select("updated_at")
      .eq("projection_date", selectedDate)
      .order("updated_at", { ascending: false })
      .limit(1),

    // Closest available date before selectedDate (for the ‹ arrow).
    supabase
      .from("projections")
      .select("projection_date")
      .lt("projection_date", selectedDate)
      .order("projection_date", { ascending: false })
      .limit(1),

    // Closest available date after selectedDate (for the › arrow).
    supabase
      .from("projections")
      .select("projection_date")
      .gt("projection_date", selectedDate)
      .order("projection_date", { ascending: true })
      .limit(1),
  ]);

  const rows = projData;
  console.log(
    `[home-diag] fetched (paginated): projections=${rows.length} edges=${edgeData.length}`,
  );

  // If the requested date has no data (e.g. a future date with no runs yet),
  // return an empty shell so the UI can still show the date + disabled arrows.
  if (rows.length === 0) return emptyResult(selectedDate);

  const updatedAt = updatedAtData?.[0]?.updated_at ?? null;
  const prevDate = prevData?.[0]?.projection_date ?? null;
  const nextDate = nextData?.[0]?.projection_date ?? null;

  // Index edges by (player_id, prop_type) for an O(1) join.
  const edgeRows = edgeData;
  const edgeByKey = new Map<string, EdgeRow>();
  for (const e of edgeRows) {
    edgeByKey.set(`${e.player_id}|${e.prop_type}`, e);
  }

  // Group by prop_type → game_id → players. Pure presentation — no math.
  // After grouping we sort each prop's games chronologically by start_time so
  // the slate order matches MLB's schedule page and stays identical across
  // every tab. Games with no start_time (TBD slots) sort to the end.
  const startTimeFor = (g: GameGroup): number =>
    g.startTime ? new Date(g.startTime).getTime() : Number.POSITIVE_INFINITY;

  const byProp = Object.fromEntries(
    ALL_PROP_TYPES.map((propType) => {
      const byGame = new Map<number, GameGroup>();
      for (const r of rows) {
        if (r.prop_type !== propType) continue;
        if (!byGame.has(r.game_id)) {
          byGame.set(r.game_id, {
            game_id: r.game_id,
            matchup: r.games
              ? `${r.games.away_team} @ ${r.games.home_team}`
              : `Game ${r.game_id}`,
            startTime: r.games?.start_time ?? null,
            pitchers: [],
          });
        }

        const e = edgeByKey.get(`${r.player_id}|${r.prop_type}`);
        byGame.get(r.game_id)!.pitchers.push({
          player_id: r.player_id,
          name: r.players?.full_name ?? "Unknown player",
          projection: r.projection,
          // NULL until enough graded starts accumulate; undefined = render nothing.
          confidence: r.confidence ?? undefined,
          // Optional edge fields — undefined when this player has no line.
          line: e?.line,
          edge: e?.edge ?? undefined,
          fairOverProb: e?.fair_over_prob ?? undefined,
          modelOverProb: e?.model_over_prob ?? undefined,
          overPrice: e?.over_price ?? undefined,
          underPrice: e?.under_price ?? undefined,
          bookmaker: e?.bookmaker,
        });
      }
      const sorted = [...byGame.values()].sort(
        (a, b) => startTimeFor(a) - startTimeFor(b)
      );
      return [propType, sorted];
    })
  ) as unknown as ByProp;

  return { date: selectedDate, updatedAt, prevDate, nextDate, byProp };
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

export default async function Home({
  searchParams,
}: {
  searchParams?: { date?: string };
}) {
  const rawDate = searchParams?.date;
  const dateOverride =
    rawDate && DATE_RE.test(rawDate) ? rawDate : undefined;

  const { date, updatedAt, prevDate, nextDate, byProp } =
    await getSlate(dateOverride);

  // Show a stale-data banner when the latest projection date isn't today in ET.
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const isStale = date !== null && date < todayET;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MLB Props</h1>
          <p className="mt-1 text-sm text-slate-400">
            Pitchers &amp; hitters
          </p>
          {updatedAt && (
            <p className="mt-0.5 text-sm text-slate-400">
              Last updated: {formatUpdatedAt(updatedAt)}
            </p>
          )}
        </div>
        <Link
          href="/results"
          className="mt-1 text-sm text-slate-400 transition-colors hover:text-slate-200"
        >
          Results →
        </Link>
      </header>

      {isStale && (
        <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          Showing {formatDate(date!)} projections — today&apos;s slate updates after 8 AM ET.
        </div>
      )}

      {date ? (
        <PropBoard
          date={date}
          prevDate={prevDate}
          nextDate={nextDate}
          byProp={byProp}
        />
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          Nothing to show. Once the engine runs, today&apos;s projections appear
          here.
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-slate-600">
        Projections are statistical estimates, not guarantees.
      </footer>
    </main>
  );
}
