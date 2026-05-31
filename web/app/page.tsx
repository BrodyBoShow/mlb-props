import { getSupabaseClient } from "@/lib/supabase";

// Always read fresh from the DB at request time — the cron updates rows
// throughout the day. No caching of stale projections.
export const dynamic = "force-dynamic";

// Shape of a projection row with its joined player + game (PostgREST embeds
// a to-one relation as a single nested object).
type ProjectionRow = {
  game_id: number;
  projection: number;
  players: { full_name: string | null } | null;
  games: { home_team: string; away_team: string } | null;
};

type GameGroup = {
  game_id: number;
  matchup: string;
  pitchers: { name: string; projection: number }[];
};

async function getLatestSlate(): Promise<{
  date: string | null;
  groups: GameGroup[];
}> {
  const supabase = getSupabaseClient();

  // Which slate to show: the most recent projection_date present.
  const { data: latest, error: e1 } = await supabase
    .from("projections")
    .select("projection_date")
    .order("projection_date", { ascending: false })
    .limit(1);
  if (e1) console.error("[Supabase] date query error:", JSON.stringify(e1));

  const date = latest?.[0]?.projection_date ?? null;
  if (!date) return { date: null, groups: [] };

  const { data, error: e2 } = await supabase
    .from("projections")
    .select("game_id, projection, players(full_name), games(home_team, away_team)")
    .eq("prop_type", "strikeouts")
    .eq("projection_date", date)
    .order("projection", { ascending: false });
  if (e2) console.error("[Supabase] projections query error:", JSON.stringify(e2));

  const rows = (data ?? []) as unknown as ProjectionRow[];

  // Group pitchers under their game. Pure presentation grouping — no math.
  const byGame = new Map<number, GameGroup>();
  for (const r of rows) {
    if (!byGame.has(r.game_id)) {
      byGame.set(r.game_id, {
        game_id: r.game_id,
        matchup: r.games
          ? `${r.games.away_team} @ ${r.games.home_team}`
          : `Game ${r.game_id}`,
        pitchers: [],
      });
    }
    byGame.get(r.game_id)!.pitchers.push({
      name: r.players?.full_name ?? "Unknown pitcher",
      projection: r.projection,
    });
  }

  return { date, groups: [...byGame.values()] };
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default async function Home() {
  const { date, groups } = await getLatestSlate();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Strikeout Projections
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {date
            ? `Probable starters · ${formatDate(date)}`
            : "No projections available yet."}
        </p>
      </header>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          Nothing to show. Once the engine runs, today&apos;s projections appear
          here.
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section
              key={g.game_id}
              className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50"
            >
              <div className="border-b border-slate-800 bg-slate-900 px-5 py-3">
                <h2 className="font-semibold text-slate-200">{g.matchup}</h2>
              </div>
              <ul className="divide-y divide-slate-800">
                {g.pitchers.map((p, i) => (
                  <li
                    key={`${g.game_id}-${i}`}
                    className="flex items-center justify-between px-5 py-3"
                  >
                    <span className="text-slate-100">{p.name}</span>
                    <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400 tabular-nums">
                      {p.projection.toFixed(1)} K
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-slate-600">
        Projections are statistical estimates, not guarantees.
      </footer>
    </main>
  );
}
