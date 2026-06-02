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
// One graded game's actual vs tonight's line, oldest→newest for display.
export type FormDot = "over" | "under" | "push";

// Tonight's opposing-lineup context for a pitcher. kRate is the opponent
// team's season strikeout rate (0–1), persisted onto strikeouts projection
// rows by the engine (feature 4 / Option A). lhh/rhh handedness is deferred
// (always null for now) — the type keeps the slot for a later feature.
export type OppContext = {
  kRate: number | null;
  lhh: number | null;
  rhh: number | null;
};

// Sharp-money agreement (feature 5). The DIRECTION is the de-vigged edge's
// lean (same value + EDGE_THRESHOLD the EdgeDetail arrow uses) — so the badge
// can never point opposite the arrow and never fires on ~Even rows. `agree`
// counts how many REAL two-sided books (pinnacle/draftkings/fanduel/bet365/
// caesars, gated to main-market lines) corroborate that lean — i.e. have the
// projection on the edge's side of their line. Only set when agree >= 2; the
// UI tiers it (agree>=3 && agree===total = full, agree>=2 = partial). DFS apps
// are excluded (flat single-number lines, not two-sided markets).
export type SharpAgreement = {
  agree: number;                 // real books corroborating the edge's lean
  total: number;                 // qualifying real books with a line on this prop
  direction: "over" | "under";   // the EDGE's lean direction
  books: string[];               // corroborating book keys (for the tooltip)
};

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
  // Last-5 recent-form dots for THIS prop: each graded actual vs the current
  // line (over/under/push), oldest→newest. Computed per (player, prop) at
  // build time so each prop tab carries the right dots. undefined when the
  // pitcher has no graded history OR no current line to compare against.
  recentForm?: FormDot[];
  // Tonight's opposing-lineup context (feature 4). Attached to every pitcher
  // prop tab's row but only RENDERED on the Strikeouts tab. undefined when
  // opp_k_rate isn't available (pre-migration, or a non-model prop).
  oppContext?: OppContext;
  // Multi-book sharp agreement (feature 5). undefined when fewer than 2 real
  // books agree with the model's lean (or <2 real books have a line).
  sharpAgreement?: SharpAgreement;
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

// One ISO-week bucket of Betting Edge results for the weekly trend chart.
// week = start-of-week (Monday) date string "YYYY-MM-DD". rate = correct /
// (correct + wrong); weeks with no evaluable plays are omitted upstream.
export type WeeklyBucket = {
  week: string;
  correct: number;
  wrong: number;
  skip: number;
  rate: number;
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
  // line / edge / bookmaker / lean are present for the two EDGE sections
  // (pitching + hitting). They're ABSENT on HR-matchup plays, which are ranked
  // by park-adjusted projection, not by a book line.
  line?: number;
  edge?: number;       // always > 0 — under-leans flip the sign at build time
  bookmaker?: string;
  lean?: "over" | "under";
  gameId: number;
  matchup: string;
  // Count of graded game logs backing this player+prop. A "graded start"
  // = a player_game_logs row where the prop's actual column is non-null.
  // Surfaced on the card so users can weigh edges with thin history
  // differently from edges with a real track record. 0 = no history yet.
  gradedStarts: number;
  // Multi-book sharp agreement (feature 5) for this featured pitcher+prop.
  sharpAgreement?: SharpAgreement;
  // HR-matchup section: home-park hit factor (display) + proj × parkFactor
  // ranking score (not displayed, used only for the sort).
  parkFactor?: number;
  hrScore?: number;
  // Opponent lineup season K rate (0–1) when available — pitching-edge AI
  // context only (it lives on strikeouts projection rows).
  oppKRate?: number;
  // AI-generated one-sentence insight. undefined until /api/featured-insights
  // resolves (or permanently if ANTHROPIC_API_KEY isn't set).
  insight?: string;
};

// One of the three Featured Plays sections. Each is independently ranked and
// capped at 3 plays; an empty plays array renders a "No qualifying plays" note
// under the header rather than padding.
export type FeaturedSection = {
  label: string;   // "PITCHING EDGES" | "HITTING EDGES" | "HR MATCHUPS"
  plays: FeaturedPlay[];
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
