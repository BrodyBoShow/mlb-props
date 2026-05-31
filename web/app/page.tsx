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
];

// Shape of a projection row with its joined player + game.
type ProjectionRow = {
  game_id: number;
  player_id: number;
  prop_type: string;
  projection: number;
  players: { full_name: string | null } | null;
  games: { home_team: string; away_team: string } | null;
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

async function getLatestSlate(): Promise<{
  date: string | null;
  byProp: ByProp;
}> {
  const supabase = getSupabaseClient();

  // Which slate to show: the most recent projection_date present.
  const { data: latest } = await supabase
    .from("projections")
    .select("projection_date")
    .order("projection_date", { ascending: false })
    .limit(1);

  const date = latest?.[0]?.projection_date ?? null;
  if (!date) {
    const empty = Object.fromEntries(
      ALL_PROP_TYPES.map((p) => [p, []])
    ) as unknown as ByProp;
    return { date: null, byProp: empty };
  }

  // Fetch all 5 prop types in one query — no math, just reading.
  const { data } = await supabase
    .from("projections")
    .select(
      "game_id, player_id, prop_type, projection, players(full_name), games(home_team, away_team)"
    )
    .eq("projection_date", date)
    .in("prop_type", ALL_PROP_TYPES)
    .order("projection", { ascending: false });

  const rows = (data ?? []) as unknown as ProjectionRow[];

  // Fetch edges for the same slate date. Most pitchers won't have one (lines
  // only exist for active pre-game markets), so this is a sparse side table.
  const { data: edgeData } = await supabase
    .from("edges")
    .select(
      "player_id, prop_type, bookmaker, line, fair_over_prob, model_over_prob, edge, over_price, under_price"
    )
    .eq("game_date", date);

  const edgeRows = (edgeData ?? []) as unknown as EdgeRow[];

  // Index edges by (player_id, prop_type) for an in-memory join. game_date is
  // fixed to the slate date, so it doesn't need to be part of the key.
  const edgeByKey = new Map<string, EdgeRow>();
  for (const e of edgeRows) {
    edgeByKey.set(`${e.player_id}|${e.prop_type}`, e);
  }

  // Group by prop_type → game_id → pitchers. Pure presentation — no math.
  // Each pitcher carries its matching edge row (if any), already computed.
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
            pitchers: [],
          });
        }

        const e = edgeByKey.get(`${r.player_id}|${r.prop_type}`);
        byGame.get(r.game_id)!.pitchers.push({
          name: r.players?.full_name ?? "Unknown pitcher",
          projection: r.projection,
          // Optional edge fields — undefined when this pitcher has no line.
          line: e?.line,
          edge: e?.edge ?? undefined,
          fairOverProb: e?.fair_over_prob ?? undefined,
          modelOverProb: e?.model_over_prob ?? undefined,
          overPrice: e?.over_price ?? undefined,
          underPrice: e?.under_price ?? undefined,
          bookmaker: e?.bookmaker,
        });
      }
      return [propType, [...byGame.values()]];
    })
  ) as unknown as ByProp;

  return { date, byProp };
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default async function Home() {
  const { date, byProp } = await getLatestSlate();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          MLB Pitcher Props
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {date
            ? `Probable starters · ${formatDate(date)}`
            : "No projections available yet."}
        </p>
      </header>

      {date ? (
        <PropBoard date={date} byProp={byProp} />
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
