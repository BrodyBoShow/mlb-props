import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import ResultsBoard, { type GameResult, type PlayerResult } from "./ResultsBoard";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Raw shape of a player_game_logs row joined to players + games.
type LogRow = {
  player_id: number;
  game_id: number;
  game_date: string;
  player_type: string;
  projection: number | null;
  actual_strikeouts: number | null;
  actual_hits: number | null;
  players: { full_name: string | null } | null;
  games: { home_team: string; away_team: string } | null;
};

async function getResults(dateOverride?: string): Promise<{
  date: string | null;
  prevDate: string | null;
  nextDate: string | null;
  games: GameResult[];
}> {
  const supabase = getSupabaseClient();
  const empty = { date: null, prevDate: null, nextDate: null, games: [] };

  // Resolve date — override or find the latest graded date.
  let selectedDate: string;
  if (dateOverride) {
    selectedDate = dateOverride;
  } else {
    const { data: latest } = await supabase
      .from("player_game_logs")
      .select("game_date")
      .order("game_date", { ascending: false })
      .limit(1);
    if (!latest?.[0]?.game_date) return empty;
    selectedDate = latest[0].game_date;
  }

  // Fetch logs + prev/next grade dates in parallel.
  const [
    { data: logData },
    { data: prevData },
    { data: nextData },
  ] = await Promise.all([
    supabase
      .from("player_game_logs")
      .select(
        "player_id, game_id, game_date, player_type, projection, actual_strikeouts, actual_hits, players(full_name), games(home_team, away_team)"
      )
      .eq("game_date", selectedDate)
      .order("game_id"),

    supabase
      .from("player_game_logs")
      .select("game_date")
      .lt("game_date", selectedDate)
      .order("game_date", { ascending: false })
      .limit(1),

    supabase
      .from("player_game_logs")
      .select("game_date")
      .gt("game_date", selectedDate)
      .order("game_date", { ascending: true })
      .limit(1),
  ]);

  const rows = (logData ?? []) as unknown as LogRow[];
  if (rows.length === 0) return { date: selectedDate, prevDate: null, nextDate: null, games: [] };

  const prevDate = prevData?.[0]?.game_date ?? null;
  const nextDate = nextData?.[0]?.game_date ?? null;

  // Group by game_id, build PlayerResult per row.
  // Math lives here in the server component — diff and hit are computed once.
  const gameMap = new Map<number, GameResult>();

  for (const r of rows) {
    if (!gameMap.has(r.game_id)) {
      gameMap.set(r.game_id, {
        gameId: r.game_id,
        matchup: r.games
          ? `${r.games.away_team} @ ${r.games.home_team}`
          : `Game ${r.game_id}`,
        players: [],
      });
    }

    const isPitcher = r.player_type === "pitcher";
    // Use the prop that matches the player type.
    const actual = isPitcher
      ? (r.actual_strikeouts ?? null)
      : (r.actual_hits ?? null);
    const projection = r.projection ?? null;

    // Skip rows where we lack a graded actual or projection.
    if (actual === null || projection === null) continue;

    const diff = actual - projection;

    gameMap.get(r.game_id)!.players.push({
      playerId: r.player_id,
      name: r.players?.full_name ?? "Unknown player",
      playerType: isPitcher ? "pitcher" : "hitter",
      projection,
      actual,
      diff: Math.round(diff * 10) / 10,
      hit: actual >= projection,
    });
  }

  // Sort games by game_id (already ordered from the query) and pitchers before hitters within each.
  const games = [...gameMap.values()].map((g) => ({
    ...g,
    players: [
      ...g.players.filter((p) => p.playerType === "pitcher"),
      ...g.players.filter((p) => p.playerType === "hitter"),
    ],
  }));

  return { date: selectedDate, prevDate, nextDate, games };
}

function formatDateLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default async function ResultsPage({
  searchParams,
}: {
  searchParams?: { date?: string };
}) {
  const rawDate = searchParams?.date;
  const dateOverride = rawDate && DATE_RE.test(rawDate) ? rawDate : undefined;

  const { date, prevDate, nextDate, games } = await getResults(dateOverride);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Results</h1>
          <p className="mt-1 text-sm text-slate-400">
            {date
              ? `Projection accuracy · ${formatDateLong(date)}`
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

      {date && games.length > 0 ? (
        <ResultsBoard
          date={date}
          prevDate={prevDate}
          nextDate={nextDate}
          games={games}
        />
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No graded results yet — check back after today&apos;s games finish.
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-slate-600">
        Projections are statistical estimates, not guarantees.
      </footer>
    </main>
  );
}
