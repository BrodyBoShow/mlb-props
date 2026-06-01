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
