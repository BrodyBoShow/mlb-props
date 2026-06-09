"use client";

import { useCallback, useEffect, useState } from "react";
import type { PropType } from "@/lib/types";

// Client-side bet tracker: the user's saved plays, persisted to localStorage.
// No accounts / no DB writes — respects the one-writer architecture (the
// frontend only READS the DB; this is purely local user state, same pattern as
// useWatchlist). The My Plays panel grades these against the graded actuals it
// reads from player_game_logs.
const KEY = "mlb-props:bets:v1";

export type TrackedPlay = {
  key: string; // `${playerId}|${prop}|${date}` — one tracked play per player+prop+slate
  playerId: number;
  playerName: string;
  prop: PropType;
  line: number;
  side: "over" | "under";
  date: string; // slate date (game_date / projection_date)
  matchup: string; // "Away @ Home"
  addedAt: number;
};

export function trackKey(playerId: number, prop: PropType, date: string): string {
  return `${playerId}|${prop}|${date}`;
}

export function useBetTracker() {
  const [plays, setPlays] = useState<TrackedPlay[]>([]);
  // Hydrated flag avoids an SSR/client mismatch: the server renders empty, then
  // we load localStorage on mount. Consumers gate tracker-count UI on `hydrated`.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const arr = JSON.parse(raw) as TrackedPlay[];
        if (Array.isArray(arr)) {
          setPlays(
            arr.filter(
              (p) =>
                p &&
                typeof p.key === "string" &&
                Number.isFinite(p.playerId) &&
                Number.isFinite(p.line),
            ),
          );
        }
      }
    } catch {
      /* private mode / disabled storage — start empty */
    }
    setHydrated(true);
  }, []);

  const persist = (next: TrackedPlay[]): TrackedPlay[] => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return next;
  };

  const has = useCallback((key: string) => plays.some((p) => p.key === key), [plays]);

  // Add the play if not present, remove it if it is (idempotent on key).
  const toggle = useCallback((play: TrackedPlay) => {
    setPlays((prev) =>
      persist(
        prev.some((p) => p.key === play.key)
          ? prev.filter((p) => p.key !== play.key)
          : [play, ...prev],
      ),
    );
  }, []);

  const remove = useCallback((key: string) => {
    setPlays((prev) => persist(prev.filter((p) => p.key !== key)));
  }, []);

  return { plays, has, toggle, remove, count: plays.length, hydrated };
}
