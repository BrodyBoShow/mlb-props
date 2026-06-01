// Shared frontend types. These previously lived inline in PropBoard.tsx,
// ResultsBoard.tsx, and the two live hooks; consolidating them here means
// PropType (in particular) is defined exactly once so adding a new prop is
// a single-file edit.

// The 12 prop types the engine produces. Keep in sync with
// engine/baseline.py builders and engine/lines.py PROP_TO_MARKET.
export type PropType =
  | "strikeouts"
  | "hits_allowed"
  | "walks"
  | "earned_runs"
  | "outs_recorded"
  | "pitcher_fantasy_score"
  | "hitter_hits"
  | "hitter_total_bases"
  | "hitter_rbis"
  | "hitter_runs"
  | "hitter_home_runs"
  | "hitter_fantasy_score";

// ── home page (PropBoard.tsx) ────────────────────────────────────────────────

// One pitcher/hitter row. Projection is always present; all other fields are
// optional — most players won't have a line or enough graded history yet.
// All values are pre-computed by the engine (the frontend does ZERO math).
export type Pitcher = {
  player_id: number;     // MLBAM id — matches boxscore "ID{n}" keys 1:1
  name: string;
  projection: number;
  confidence?: number;   // 0–1 hit rate; undefined = not enough graded history
  line?: number;
  edge?: number;
  fairOverProb?: number;
  modelOverProb?: number;
  overPrice?: number;
  underPrice?: number;
  bookmaker?: string;
};

export type GameGroup = {
  game_id: number;
  matchup: string;
  // First-pitch ISO timestamp from the games table. The slate is sorted by
  // this server-side in page.tsx; null entries (TBD) sort to the end.
  startTime: string | null;
  pitchers: Pitcher[];
};

export type ByProp = Record<PropType, GameGroup[]>;

// ── results page (ResultsBoard.tsx) ──────────────────────────────────────────

export type Verdict = "correct" | "wrong" | "skip";

// Betting Edge result — joined projection + book line + actual.
export type EvaluatedResult = {
  gameId: number;
  matchup: string;
  playerId: number;
  playerName: string;
  propType: PropType;
  gameDate: string;
  projection: number;
  line: number;
  bookmaker: string;
  actual: number;
  lean: "over" | "under" | "none";
  verdict: Verdict;
};

// Model Tracker result — projection + actual only, no book line.
export type TrackerResult = {
  gameId: number;
  matchup: string;
  playerId: number;
  playerName: string;
  propType: PropType;
  gameDate: string;
  projection: number;
  actual: number;
  direction: "over" | "under";   // actual > projection ? "over" : "under"
};

// ── live overlays ────────────────────────────────────────────────────────────

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
  // batter components needed to compute live PrizePicks fantasy score.
  doubles?: number;
  triples?: number;
  hitByPitch?: number;
  stolenBases?: number;
};

// Map shape: gamePk -> personId (MLBAM = our players.player_id) -> StatLine.
export type LiveStatsMap = Map<number, Map<number, StatLine>>;

// ── featured plays (top-of-board highlights) ────────────────────────────────

// One "best of the day" play selected from the edges table by the strict
// filters in web/app/page.tsx (real two-sided book, edge >= 0.12, clean
// pitcher props only, meaningful lean). Built server-side from already-
// fetched edge + projection data and passed through PropBoard.
export type FeaturedPlay = {
  playerId: number;
  playerName: string;
  propType: PropType;
  projection: number;
  line: number;
  edge: number;        // always > 0 — under-leans flip the sign at build time
  bookmaker: string;
  lean: "over" | "under";
  gameId: number;
  matchup: string;
};

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
