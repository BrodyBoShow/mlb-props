"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveStatsMap, StatLine } from "@/lib/types";

// StatLine + LiveStatsMap moved to @/lib/types. Re-exported here for callers
// that still do `import { ..., type StatLine } from "./useLiveBoxScores"`.
export type { LiveStatsMap, StatLine } from "@/lib/types";

const REFRESH_MS = 60_000;

// Parse one boxscore response into Map<personId, StatLine>. Hoisted out of
// the effects so both the live-poll effect and the final-once-fetch effect
// can reuse it.
async function loadOne(
  gamePk: number,
): Promise<[number, Map<number, StatLine>] | null> {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const inner = new Map<number, StatLine>();

    // The boxscore returns { teams: { away: { players: { ID660271: {...} } }, home: {...} } }.
    // Each player entry has stats.{pitching,batting}.
    for (const side of ["away", "home"] as const) {
      const players = data?.teams?.[side]?.players ?? {};
      for (const key of Object.keys(players)) {
        // Keys are "ID12345" — the trailing number is the MLBAM personId.
        const personId = Number(key.replace(/^ID/, ""));
        if (!Number.isFinite(personId)) continue;
        const entry = players[key] ?? {};
        const pitching = entry.stats?.pitching ?? {};
        const batting = entry.stats?.batting ?? {};

        // Only persist a row if at least one of the relevant counters
        // actually appears — keeps the Map small.
        const hasPitching =
          "strikeOuts" in pitching ||
          "hits" in pitching ||
          "baseOnBalls" in pitching ||
          "earnedRuns" in pitching ||
          "outs" in pitching;
        const hasBatting =
          "hits" in batting ||
          "totalBases" in batting ||
          "rbi" in batting ||
          "runs" in batting ||
          "homeRuns" in batting;

        if (!hasPitching && !hasBatting) continue;

        inner.set(personId, {
          // pitcher
          strikeOuts: hasPitching ? Number(pitching.strikeOuts ?? 0) : undefined,
          hitsAllowed: hasPitching ? Number(pitching.hits ?? 0) : undefined,
          baseOnBalls: hasPitching ? Number(pitching.baseOnBalls ?? 0) : undefined,
          earnedRuns: hasPitching ? Number(pitching.earnedRuns ?? 0) : undefined,
          outs: hasPitching ? Number(pitching.outs ?? 0) : undefined,
          // batter
          hits: hasBatting ? Number(batting.hits ?? 0) : undefined,
          // batting.totalBases is NOT in the MLB boxscore response — derive
          // it from components (hits already includes 1B/2B/3B/HR).
          totalBases: hasBatting
            ? Number(batting.hits ?? 0)
              + Number(batting.doubles ?? 0)
              + 2 * Number(batting.triples ?? 0)
              + 3 * Number(batting.homeRuns ?? 0)
            : undefined,
          rbi: hasBatting ? Number(batting.rbi ?? 0) : undefined,
          runs: hasBatting ? Number(batting.runs ?? 0) : undefined,
          homeRuns: hasBatting ? Number(batting.homeRuns ?? 0) : undefined,
          // extra batter components for fantasy score
          doubles:     hasBatting ? Number(batting.doubles ?? 0) : undefined,
          triples:     hasBatting ? Number(batting.triples ?? 0) : undefined,
          hitByPitch:  hasBatting ? Number(batting.hitByPitch ?? 0) : undefined,
          stolenBases: hasBatting ? Number(batting.stolenBases ?? 0) : undefined,
        });
      }
    }
    return [gamePk, inner];
  } catch {
    return null;
  }
}

// Poll the MLB Stats API boxscore endpoint for live games AND fetch each
// final game ONCE so the prop cards can show the final stat next to the
// projection after a game ends.
//
// Final games' box scores don't change after the game closes, so they are
// fetched a single time per gamePk (tracked in a ref) and never re-polled —
// avoiding 15 wasted requests per minute when a slate has finished but the
// user keeps the tab open.
//
// The hook never throws. On any failure (network blip, malformed JSON,
// individual game 404) the prior Map is retained and StatLine lookup falls
// through to "no live data" so PropBoard shows projection-only.
export function useLiveBoxScores(
  liveGamePks: number[],
  finalGamePks: number[] = [],
): LiveStatsMap {
  // Stringified keys so React re-runs the effects only when the SET of game
  // ids changes — order swaps don't trigger a new fetch wave.
  const liveKey = [...liveGamePks].sort((a, b) => a - b).join(",");
  const finalKey = [...finalGamePks].sort((a, b) => a - b).join(",");
  const [stats, setStats] = useState<LiveStatsMap>(new Map());

  // Tracks which final gamePks we've already fetched, so re-renders that
  // re-include the same final gamePk don't trigger another fetch.
  const fetchedFinalsRef = useRef<Set<number>>(new Set());

  // ── live games: poll every 60s, merge into the existing map ────────────
  useEffect(() => {
    if (liveGamePks.length === 0) return;

    let cancelled = false;

    async function load() {
      const results = await Promise.all(liveGamePks.map(loadOne));
      if (cancelled) return;
      setStats((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r) next.set(r[0], r[1]);
        }
        return next;
      });
    }

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  // ── final games: fetch each one exactly once ───────────────────────────
  useEffect(() => {
    if (finalGamePks.length === 0) return;

    const toFetch = finalGamePks.filter(
      (pk) => !fetchedFinalsRef.current.has(pk),
    );
    console.log(
      `[live-box] finals effect: ${finalGamePks.length} final games, ` +
        `${toFetch.length} new to fetch`,
    );
    if (toFetch.length === 0) return;

    let cancelled = false;
    for (const pk of toFetch) fetchedFinalsRef.current.add(pk);

    (async () => {
      const results = await Promise.all(toFetch.map(loadOne));
      const ok = results.filter(Boolean).length;
      console.log(`[live-box] finals fetched: ${ok}/${toFetch.length} succeeded`);
      if (cancelled) return;
      setStats((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r) next.set(r[0], r[1]);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalKey]);

  return stats;
}
