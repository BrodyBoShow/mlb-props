"use client";

import { useEffect, useState } from "react";

// Live status for one MLB game. The MLB Stats API gamePk matches our
// projections.game_id (and games.game_id) one-to-one.
export type GameStatus = {
  state: "live" | "scheduled" | "final" | "other";
  awayAbbr: string;
  homeAbbr: string;
  awayScore: number | null;
  homeScore: number | null;
  inningOrdinal: string | null;   // "3rd"
  inningHalf: string | null;      // "Top" | "Bottom"
  startTimeET: string | null;     // "1:05 PM ET"
  detailedState: string;          // raw "In Progress" / "Scheduled" / "Final"
};

const REFRESH_MS = 60_000;

// Poll the MLB Stats API for live status of every game on `date`.
// Returns a Map keyed by gamePk. Empty map on first render + on any failure
// (caller falls back to the static matchup header in that case).
//
// The hook never throws. If the API is unreachable the previous Map is
// retained so a transient blip doesn't blank the UI.
export function useLiveGameStatus(date: string | null): Map<number, GameStatus> {
  const [statuses, setStatuses] = useState<Map<number, GameStatus>>(new Map());

  useEffect(() => {
    if (!date) return;
    let cancelled = false;

    async function load() {
      try {
        const url =
          `https://statsapi.mlb.com/api/v1/schedule` +
          `?sportId=1&date=${date}&hydrate=linescore`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();

        const map = new Map<number, GameStatus>();
        for (const dateEntry of data.dates ?? []) {
          for (const g of dateEntry.games ?? []) {
            const abstract = g.status?.abstractGameState as string | undefined;
            const detailed: string = g.status?.detailedState ?? "";

            let state: GameStatus["state"] = "other";
            if (abstract === "Live") state = "live";
            else if (abstract === "Preview") state = "scheduled";
            else if (abstract === "Final") state = "final";

            const startTimeET = g.gameDate
              ? new Date(g.gameDate).toLocaleTimeString("en-US", {
                  timeZone: "America/New_York",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                }) + " ET"
              : null;

            map.set(g.gamePk, {
              state,
              awayAbbr: g.teams?.away?.team?.abbreviation ?? "",
              homeAbbr: g.teams?.home?.team?.abbreviation ?? "",
              awayScore: g.teams?.away?.score ?? null,
              homeScore: g.teams?.home?.score ?? null,
              inningOrdinal: g.linescore?.currentInningOrdinal ?? null,
              inningHalf: g.linescore?.inningHalf ?? null,
              startTimeET,
              detailedState: detailed,
            });
          }
        }
        if (!cancelled) setStatuses(map);
      } catch {
        // Network blip — keep prior state. Next tick retries.
      }
    }

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [date]);

  return statuses;
}
