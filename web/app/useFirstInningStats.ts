"use client";

import { useEffect, useRef, useState } from "react";

// First-inning actuals for the 1-inning props, sourced from the MLB play-by-play
// (the boxscore only carries GAME totals, so the live-box hook can't supply these).
// Mirrors engine/grade.py's _first_inning_* definitions EXACTLY so the board's
// live number agrees with the eventual graded result:
//   * pitches    — per pitcher: sum of playEvents with isPitch in inning-1 plays
//                  where matchup.pitcher.id == personId.
//   * strikeouts — per pitcher: inning-1 plays with result.eventType in
//                  (strikeout, strikeout_double_play).
//   * runs       — total 1st-inning runs (both teams). Game starts 0-0, so the
//                  running score after the last inning-1 play == 1st-inning runs.
//                  (Matches the grader's linescore.innings[0] sum — verified.)
export type FirstInningGame = {
  pitches: Map<number, number>; // personId -> 1st-inning pitch count
  strikeouts: Map<number, number>; // personId -> 1st-inning strikeouts
  runs?: number; // total 1st-inning runs (undefined until the 1st has plays)
};
export type FirstInningMap = Map<number, FirstInningGame>;

const REFRESH_MS = 60_000;

// Fetch + parse one game's play-by-play into its 1st-inning stats. Never throws;
// returns null on any failure so the caller falls back to projection-only.
async function loadFirstInning(
  gamePk: number,
): Promise<[number, FirstInningGame] | null> {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/game/${gamePk}/playByPlay`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const allPlays: Array<Record<string, unknown>> = data?.allPlays ?? [];

    const pitches = new Map<number, number>();
    const strikeouts = new Map<number, number>();
    let runs: number | undefined;
    let sawFirst = false;

    for (const play of allPlays) {
      const about = (play?.about ?? {}) as { inning?: number };
      if (about.inning !== 1) continue;
      sawFirst = true;

      const matchup = (play?.matchup ?? {}) as { pitcher?: { id?: number } };
      const pid = matchup.pitcher?.id;
      if (typeof pid === "number") {
        const events = (play?.playEvents ?? []) as Array<{ isPitch?: boolean }>;
        const np = events.filter((e) => e?.isPitch === true).length;
        if (np) pitches.set(pid, (pitches.get(pid) ?? 0) + np);

        const result = (play?.result ?? {}) as { eventType?: string };
        if (
          result.eventType === "strikeout" ||
          result.eventType === "strikeout_double_play"
        ) {
          strikeouts.set(pid, (strikeouts.get(pid) ?? 0) + 1);
        }
      }

      // Running score AFTER this play; the game starts 0-0, so once the 1st is
      // complete this equals the inning's total runs (both teams).
      const result = (play?.result ?? {}) as {
        awayScore?: number;
        homeScore?: number;
      };
      if (
        typeof result.awayScore === "number" &&
        typeof result.homeScore === "number"
      ) {
        runs = result.awayScore + result.homeScore;
      }
    }

    if (!sawFirst) return [gamePk, { pitches, strikeouts, runs: undefined }];
    // A starter who faced the 1st but fanned nobody should read 0, not "no data".
    for (const pid of pitches.keys()) {
      if (!strikeouts.has(pid)) strikeouts.set(pid, 0);
    }
    return [gamePk, { pitches, strikeouts, runs: runs ?? 0 }];
  } catch {
    return null;
  }
}

// Poll the MLB play-by-play for 1st-inning actuals.
//
// The 1st inning is FIXED once a game is past it, so each game is fetched ONCE
// and then FROZEN (never re-fetched) as soon as it's final OR has reached the
// 2nd inning. Only games still in their 1st inning keep polling — so on a typical
// slate the ongoing cost is ~0-2 fetches/minute, not one-per-game-per-minute.
//
// `games` carries each started game's current inning so the hook knows when to
// freeze. Never throws; a failed fetch just leaves that game absent from the map
// (the board shows projection-only) and retries next cycle.
export function useFirstInningStats(
  games: { gamePk: number; currentInning: number | null; isFinal: boolean }[],
): FirstInningMap {
  const [map, setMap] = useState<FirstInningMap>(new Map());
  const frozenRef = useRef<Set<number>>(new Set());

  // Games still needing a (re)fetch — not yet frozen. Re-run when this set
  // changes OR a pending game advances an inning (so leaving the 1st triggers a
  // final capture + freeze).
  const pending = games.filter((g) => !frozenRef.current.has(g.gamePk));
  const pendingKey = pending
    .map((g) => `${g.gamePk}:${g.isFinal ? "F" : g.currentInning ?? "?"}`)
    .sort()
    .join(",");

  useEffect(() => {
    if (pending.length === 0) return;
    let cancelled = false;

    async function loadAll() {
      const results = await Promise.all(
        pending.map((g) => loadFirstInning(g.gamePk)),
      );
      if (cancelled) return;
      setMap((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r) next.set(r[0], r[1]);
        }
        return next;
      });
      // Freeze settled games (final OR past the 1st) so they aren't re-polled.
      results.forEach((r, i) => {
        const g = pending[i];
        if (r && (g.isFinal || (g.currentInning ?? 0) >= 2)) {
          frozenRef.current.add(g.gamePk);
        }
      });
    }

    loadAll();
    const id = setInterval(loadAll, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  return map;
}
