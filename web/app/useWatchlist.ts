"use client";

import { useCallback, useEffect, useState } from "react";

// Client-side watchlist of starred player_ids, persisted to localStorage. No
// accounts / no DB writes — respects the one-writer architecture (the frontend
// only ever READS the DB; this is purely local user state).
const KEY = "mlb-props:watchlist:v1";

export function useWatchlist() {
  const [ids, setIds] = useState<Set<number>>(new Set());
  // Hydrated flag avoids an SSR/client mismatch: the server renders with an
  // empty set, then we load localStorage on mount. Consumers gate watchlist-only
  // UI on `hydrated` so nothing flips during hydration.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const arr = JSON.parse(raw) as number[];
        if (Array.isArray(arr)) setIds(new Set(arr.filter((n) => Number.isFinite(n))));
      }
    } catch {
      /* private mode / disabled storage — just start empty */
    }
    setHydrated(true);
  }, []);

  const toggle = useCallback((id: number) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const has = useCallback((id: number) => ids.has(id), [ids]);

  return { ids, has, toggle, count: ids.size, hydrated };
}
