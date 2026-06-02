// Shared frontend constants. Previously defined locally in PropBoard.tsx,
// ResultsBoard.tsx, and the two page.tsx files; consolidating them here
// means adding a new prop is a single-file edit.

import type { PropType } from "./types";

// The 12 prop types the engine produces, in display order.
// Pitcher props first (5 main + 1 fantasy), then hitter props (5 main + 1 fantasy).
export const ALL_PROP_TYPES: PropType[] = [
  "strikeouts",
  "hits_allowed",
  "walks",
  "earned_runs",
  "outs_recorded",
  "pitcher_fantasy_score",
  "hitter_hits",
  "hitter_total_bases",
  "hitter_rbis",
  "hitter_runs",
  "hitter_home_runs",
  "hitter_fantasy_score",
];

// Calibration-only props (Model Tracker section). These don't have clean
// main-market lines so they're scored as actual-vs-projection only.
export const TRACKER_PROPS: ReadonlySet<PropType> = new Set([
  "walks",
  "earned_runs",
  "hitter_hits",
  "hitter_total_bases",
]);

// Hitter prop set — used by PropBoard for live pace logic.
export const HITTER_PROPS: ReadonlySet<PropType> = new Set([
  "hitter_hits",
  "hitter_total_bases",
  "hitter_rbis",
  "hitter_runs",
  "hitter_home_runs",
  "hitter_fantasy_score",
]);

// Edge threshold for calling a side a real lean vs. roughly even.
// Mirrored from engine/constants.py EDGE_THRESHOLD — keep in sync.
export const EDGE_THRESHOLD = 0.1;

// Minimum line value for a book line to count as a "main market" line rather
// than an alternate. SINGLE SOURCE OF TRUTH — imported by the /results Betting
// Edge join, the home-page Featured Plays qualifier, AND the feature-5 sharp
// badge so all three agree on what a real main-market line is. Props absent
// from this map have no floor (e.g. walks / earned_runs are Model-Tracker
// props with no betting-line evaluation in the codebase).
//   - strikeouts / hits_allowed: floors exclude DFS-style 0.5–1.5 alternates.
//   - outs_recorded: 10.5 (ParlayAPI rarely returns real outs lines).
//   - pitcher_fantasy_score / hitter_fantasy_score: PrizePicks-only floors.
export const MIN_LINE: Partial<Record<PropType, number>> = {
  strikeouts:             3.5,
  hits_allowed:           2.5,
  outs_recorded:          10.5,
  pitcher_fantasy_score:  6.0,
  hitter_fantasy_score:   4.0,
};

// The sharp badge's OWN main-market floor — intentionally SEPARATE from
// MIN_LINE. MIN_LINE drives /results Betting-Edge evaluation + Featured Plays
// qualification (changing it would alter those), and it omits walks/earned_runs
// because those are Model-Tracker props with no betting-line eval. But the
// sharp badge RENDERS on every pitcher prop tab — including walks and
// earned_runs — so it needs a floor that covers them too, or their badges
// would still count sub-threshold alt lines (the exact distortion the gate
// closes). These are the historical main-market floors per pitcher prop:
//   - strikeouts 3.5, hits_allowed 3.5, outs_recorded 10.5
//   - walks 1.5, earned_runs 1.5  (excludes 0.5 alternates)
//   - pitcher_fantasy_score 6.0   (badge renders on that tab; real two-sided
//     books don't post fantasy lines, so it's a no-op today, included for
//     completeness)
export const SHARP_MIN_LINE: Partial<Record<PropType, number>> = {
  strikeouts:            3.5,
  hits_allowed:          3.5,
  outs_recorded:         10.5,
  walks:                 1.5,
  earned_runs:           1.5,
  pitcher_fantasy_score: 6.0,
};

// The home-board Featured Plays' OWN main-market floor — SEPARATE from the
// shared MIN_LINE (which drives /results Betting-Edge and must stay as-is).
// buildEdgePlays in page.tsx uses THIS. Pitcher values are IDENTICAL to
// MIN_LINE so the PITCHING EDGES section is unchanged; the hitter entries are
// the actual fix: MIN_LINE had NO floor for hitter_hits / hitter_total_bases,
// so `lineMin === undefined` dropped EVERY hitter play — even 170 strong
// pinnacle-anchored hitter_total_bases edges (|edge| up to 0.55) — before they
// could surface (diagnostic 2026-06-02). Floors are each prop's real main
// market:
//   - hitter_total_bases 1.5  (the standard line; 0.5 is the alt)
//   - hitter_hits        0.5  (1+ hit, the standard market). NOTE hitter_hits
//     still won't surface on the board because pinnacle posts no two-sided
//     hitter_hits line, so edge.py only emits a `consensus` baseline that
//     FEATURED_BOOKS excludes — a SEPARATE cause, deliberately not forced in.
export const FEATURED_MIN_LINE: Partial<Record<PropType, number>> = {
  strikeouts:            3.5,
  hits_allowed:          2.5,
  outs_recorded:         10.5,
  hitter_hits:           0.5,
  hitter_total_bases:    1.5,
};

// Real, two-sided sportsbooks — the only books that count toward sharp-money
// agreement (feature 5). DFS apps (prizepicks/underdog/sleeper/betr) post flat
// single-number lines, not two-sided over/under markets, so they're excluded.
// This is the SUBSET of engine/lines.py BOOKMAKERS that have de-viggable
// markets — mirrors the FEATURED_BOOKS set in web/app/page.tsx; keep in sync.
export const REAL_BOOKS: readonly string[] = [
  "pinnacle",
  "draftkings",
  "fanduel",
  "bet365",
  "caesars",
];

// Display names for the real books (tooltips / labels). Keep in sync with
// REAL_BOOKS above and BOOK_LABEL in web/app/FeaturedPlays.tsx.
export const BOOK_DISPLAY: Record<string, string> = {
  pinnacle:   "Pinnacle",
  draftkings: "DraftKings",
  fanduel:    "FanDuel",
  bet365:     "Bet365",
  caesars:    "Caesars",
};

// ── Park factors ─────────────────────────────────────────────────────────────
// Hit park factor for each home venue. 1.0 = neutral; > 1 = hitter-friendly;
// < 1 = pitcher-friendly. Values mirror engine/constants.py PARK_FACTORS_HITS
// EXACTLY — when one moves, the other must too.
// Used display-side only; engine grading already writes the same factor
// into player_game_logs.park_factor_hits.
export const PARK_FACTORS_HITS: Record<string, number> = {
  "Colorado Rockies":      1.15,
  "Cincinnati Reds":       1.08,
  "Boston Red Sox":        1.07,
  "Philadelphia Phillies": 1.05,
  "Texas Rangers":         1.04,
  "Chicago Cubs":          1.03,
  "Atlanta Braves":        1.02,
  "New York Yankees":      1.01,
  "Kansas City Royals":    1.01,
  "Toronto Blue Jays":     1.01,
  "Baltimore Orioles":     1.00,
  "Minnesota Twins":       1.00,
  "Chicago White Sox":     1.00,
  "Washington Nationals":  1.00,
  "Athletics":             0.99,
  "Houston Astros":        0.99,
  "Los Angeles Angels":    0.99,
  "Pittsburgh Pirates":    0.99,
  "St. Louis Cardinals":   0.98,
  "Detroit Tigers":        0.98,
  "Arizona Diamondbacks":  0.98,
  "New York Mets":         0.98,
  "Milwaukee Brewers":     0.97,
  "Cleveland Guardians":   0.97,
  "Los Angeles Dodgers":   0.97,
  "Tampa Bay Rays":        0.96,
  "Oakland Athletics":     0.96,
  "Seattle Mariners":      0.95,
  "San Francisco Giants":  0.95,
  "Miami Marlins":         0.95,
  "San Diego Padres":      0.93,
};

export type ParkProfile = {
  factor: number;
  label: "Hitter-friendly" | "Pitcher-friendly" | "Neutral";
  direction: "up" | "down" | "neutral";
};

// Tag a home venue with its park identity. Neutral parks (factor between
// 0.96 and 1.04 inclusive) return "Neutral" so the UI can skip the tag —
// keeps headers uncluttered for half-the-league average venues.
export function getParkProfile(homeTeam: string): ParkProfile {
  const factor = PARK_FACTORS_HITS[homeTeam] ?? 1.0;
  if (factor >= 1.04) {
    return { factor, label: "Hitter-friendly", direction: "up" };
  }
  if (factor <= 0.96) {
    return { factor, label: "Pitcher-friendly", direction: "down" };
  }
  return { factor, label: "Neutral", direction: "neutral" };
}

// Display labels — single source of truth for both pages.
export const PROP_LABELS: Record<PropType, string> = {
  strikeouts:            "Strikeouts",
  hits_allowed:          "Hits Allowed",
  walks:                 "Walks",
  earned_runs:           "Earned Runs",
  outs_recorded:         "Outs",
  pitcher_fantasy_score: "Pitcher Fantasy",
  hitter_hits:           "Hits",
  hitter_total_bases:    "Total Bases",
  hitter_rbis:           "RBIs",
  hitter_runs:           "Runs",
  hitter_home_runs:      "Home Runs",
  hitter_fantasy_score:  "Hitter Fantasy",
};
