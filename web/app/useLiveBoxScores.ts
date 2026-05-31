"use client";

import { useEffect, useState } from "react";

// One player's accumulated stats so far in a live game. All numeric — undefined
// means "we didn't find this player in the box score" (subbed out, hasn't
// batted, etc.). The frontend ignores anything it can't display for the active
// prop type.
export type StatLine = {
  // pitcher
  strikeOuts?: number;
  hitsAllowed?: number;        // pitching.hits
  baseOnBalls?: number;
  earnedRuns?: number;
  outs?: number;
  // batter
  hits?: number;
  totalBases?: number;
  rbi?: number;
  runs?: number;
  homeRuns?: number;
};

// Map shape: gamePk -> personId (MLBAM = our players.player_id) -> StatLine.
export type LiveStatsMap = Map<number, Map<number, StatLine>>;

const REFRESH_MS = 60_000;

// Poll the MLB Stats API boxscore endpoint for every currently live game.
// We only fetch for gamePks marked live by the schedule poll (passed in via
// `liveGamePks`) so a 15-game slate at noon doesn't issue 15 box-score
// requests when only 2 games are actually playing.
//
// The hook never throws. On any failure (network blip, malformed JSON,
// individual game 404) the prior Map is retained and StatLine lookup
// falls through to "no live data" so PropBoard shows projection-only.
export function useLiveBoxScores(liveGamePks: number[]): LiveStatsMap {
  // Stringified key so React re-runs the effect only when the SET of live
  // game ids changes — order swaps don't trigger a new fetch wave.
  const key = [...liveGamePks].sort((a, b) => a - b).join(",");
  const [stats, setStats] = useState<LiveStatsMap>(new Map());

  useEffect(() => {
    if (liveGamePks.length === 0) {
      setStats(new Map());
      return;
    }

    let cancelled = false;

    async function loadOne(gamePk: number): Promise<[number, Map<number, StatLine>] | null> {
      try {
        const res = await fetch(
          `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`,
          { cache: "no-store" }
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
              totalBases: hasBatting ? Number(batting.totalBases ?? 0) : undefined,
              rbi: hasBatting ? Number(batting.rbi ?? 0) : undefined,
              runs: hasBatting ? Number(batting.runs ?? 0) : undefined,
              homeRuns: hasBatting ? Number(batting.homeRuns ?? 0) : undefined,
            });
          }
        }
        return [gamePk, inner];
      } catch {
        return null;
      }
    }

    async function load() {
      const results = await Promise.all(liveGamePks.map(loadOne));
      if (cancelled) return;
      const next: LiveStatsMap = new Map();
      for (const r of results) {
        if (r) next.set(r[0], r[1]);
      }
      setStats(next);
    }

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return stats;
}
