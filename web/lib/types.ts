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
  | "pitcher_first_inning_pitches"
  | "pitcher_fantasy_score"
  | "hitter_hits"
  | "hitter_total_bases"
  | "hitter_hits_runs_rbis"
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

// Hit-rate trends (props.cash-style) for one (player, prop) vs tonight's line.
// Pure display — computed from graded game logs, no model involvement.
export type TrendWindow = { pct: number; over: number; total: number };
export type Trends = {
  l5?: TrendWindow;     // over-rate in the last ≤5 graded games vs the line
  l10?: TrendWindow;
  l15?: TrendWindow;
  szn?: TrendWindow;    // over-rate across all graded games
  diff?: number;        // avg(last-10 actual) − line
  streak?: number;      // signed: +N current over-streak, −N under-streak
};

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
  // Hit-rate trends (L5/L10/L15/SZN + Diff + Streak vs the line) for the focused
  // single-prop card. undefined for fantasy props / no line / no graded history.
  trends?: Trends;
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
  // Today's game-time wind (display-only), attached for the game-header wind
  // clause + the total-bases card wind tag. Mirrors the HR-play wind fields.
  // undefined/null when the engine hasn't persisted wind for this game.
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
  // Game-level NRFI/YRFI read: the model's P(YRFI) (0-1) — probability a run
  // scores in the 1st inning by either team. Rendered as a game-header tag
  // (NRFI lean when < 0.5, YRFI when >= 0.5). undefined when not projected.
  firstInningRuns?: number;
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
  // De-vig transparency: the model's and the market's no-vig OVER probabilities
  // (0–1). The card shows them framed to the LEANED side so the edge is legible
  // ("model 72% under vs market 29%"). From the edge row; undefined for HR plays.
  modelOverProb?: number;
  fairOverProb?: number;
  // Recent-form backing (props.cash-style): over/under count in the LEAN direction
  // over the last ≤10 graded games vs THIS line. Computed from the season-backfilled
  // trends. undefined when there's no line / no graded history.
  hitRate?: { hit: number; total: number };
  // HR-matchup section: home-park hit factor (display) + proj × parkFactor
  // ranking score (not displayed, used only for the sort).
  parkFactor?: number;
  hrScore?: number;
  // HR-matchup wind tag (display-only). homeTeam drives the PARK_ORIENTATION
  // lookup; windDirDeg is OWM's meteorological FROM direction (0=N); windSpeed
  // is mph; isDome short-circuits to "Dome · neutral". All undefined until the
  // engine persists wind to the games table (pre-migration → static park label).
  homeTeam?: string;
  windSpeed?: number | null;
  windDirDeg?: number | null;
  isDome?: boolean | null;
  // HR-matchup sweet-spot footer (display-only). Rolling 7-day Statcast: a
  // fraction (0..1) of batted balls in the 8–32° sweet-spot window and mean
  // exit velo (mph). Both undefined when the hitter has < 5 batted balls or
  // the engine hasn't populated them yet → card keeps "N games tracked".
  sweetSpotPct?: number | null;
  avgExitVelo?: number | null;
  // Opponent lineup season K rate (0–1) when available — pitching-edge AI
  // context only (it lives on strikeouts projection rows).
  oppKRate?: number;
  // The team the pitcher FACES (opponent) — names which team oppKRate belongs to
  // so the AI insight attributes it correctly (not to the pitcher's own team).
  oppTeam?: string;
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
