"use client";

import DateNav from "./DateNav";
import ParkTag from "./ParkTag";
import { formatShortDate } from "@/lib/format";

// One game card on a future date. Populated by engine/main._run_future_previews
// (no projections yet, but games + probable starters are in the DB ahead of
// time so the cards can render).
export type FutureGame = {
  game_id: number;
  game_date: string;
  home_team: string;
  away_team: string;
  start_time: string | null;
  home_starter: { full_name: string } | null;
  away_starter: { full_name: string } | null;
};

function formatStartTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

export default function FutureSlate({
  date,
  prevDate,
  nextDate,
  games,
}: {
  date: string;
  prevDate: string | null;
  nextDate: string | null;
  games: FutureGame[];
}) {
  // Sort chronologically — null start_time (TBD slots) goes to the end.
  const sorted = [...games].sort((a, b) => {
    const aT = a.start_time ? new Date(a.start_time).getTime() : Number.POSITIVE_INFINITY;
    const bT = b.start_time ? new Date(b.start_time).getTime() : Number.POSITIVE_INFINITY;
    return aT - bT;
  });

  return (
    <>
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

      <div className="mb-6 rounded-lg surface px-4 py-3 text-sm text-slate-400">
        Projections not yet available · Probable starters shown where announced ·
        Refreshes automatically when projections are ready
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-lg surface p-8 text-center text-slate-400">
          No games scheduled for this date.
        </div>
      ) : (
        <div className="space-y-5">
          {sorted.map((g) => (
            <section
              key={g.game_id}
              className="overflow-hidden rounded-xl surface"
            >
              <div className="border-b border-slate-800 bg-slate-900 px-5 py-3">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold text-slate-200">
                    {g.away_team} @ {g.home_team}
                  </h2>
                  <ParkTag homeTeam={g.home_team} />
                </div>
                <p className="text-xs text-slate-500">
                  {formatShortDate(g.game_date)}
                  {g.start_time && " · " + formatStartTime(g.start_time)}
                </p>
              </div>

              <div className="grid grid-cols-2 divide-x divide-slate-800 px-0">
                <div className="px-5 py-4">
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                    Away
                  </p>
                  <p className="font-medium text-slate-200">
                    {g.away_starter?.full_name ?? "TBD"}
                  </p>
                  <p className="text-xs text-slate-500">{g.away_team}</p>
                </div>

                <div className="px-5 py-4">
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                    Home
                  </p>
                  <p className="font-medium text-slate-200">
                    {g.home_starter?.full_name ?? "TBD"}
                  </p>
                  <p className="text-xs text-slate-500">{g.home_team}</p>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
