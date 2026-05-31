/**
 * PrizePicks MLB fantasy-score weights — TypeScript mirror of the Python
 * source of truth at engine/fantasy_score.py.
 *
 * When you change a weight in one file, change it in the other. The values
 * here are used to compute LIVE fantasy score during a game from the MLB
 * Stats API box score; the Python file is used by the grading pipeline.
 *
 * Pitcher:
 *   win=6, quality_start=4, earned_run=-3, strikeout=3, out=1
 *   quality_start = outs >= 18 AND earned_runs <= 3
 *
 * Hitter:
 *   single=3, double=5, triple=8, home_run=10, run=2, rbi=2,
 *   walk=2, hbp=2, stolen_base=5
 *   singles = hits - doubles - triples - home_runs (clamped >= 0)
 */

// ── pitcher ──────────────────────────────────────────────────────────────────

export const PITCHER_WIN_PTS           = 6;
export const PITCHER_QUALITY_START_PTS = 4;
export const PITCHER_EARNED_RUN_PTS    = -3;
export const PITCHER_STRIKEOUT_PTS     = 3;
export const PITCHER_OUT_PTS           = 1;

const QUALITY_START_OUTS_MIN        = 18;  // 6 IP
const QUALITY_START_EARNED_RUNS_MAX = 3;

export function isQualityStart(outs: number, earnedRuns: number): boolean {
  return outs >= QUALITY_START_OUTS_MIN && earnedRuns <= QUALITY_START_EARNED_RUNS_MAX;
}

/**
 * Compute pitcher fantasy score from boxscore components.
 *
 * Pass `win=false` for live in-game calculation — the W bonus is not
 * decided until the game ends. QS is derived from outs + earnedRuns so it
 * becomes correct automatically once those numbers are final.
 */
export function pitcherFantasyScore(
  outs: number,
  strikeouts: number,
  earnedRuns: number,
  win: boolean,
): number {
  let score =
    outs * PITCHER_OUT_PTS +
    strikeouts * PITCHER_STRIKEOUT_PTS +
    earnedRuns * PITCHER_EARNED_RUN_PTS;
  if (win) score += PITCHER_WIN_PTS;
  if (isQualityStart(outs, earnedRuns)) score += PITCHER_QUALITY_START_PTS;
  return score;
}

// ── hitter ───────────────────────────────────────────────────────────────────

export const HITTER_SINGLE_PTS      = 3;
export const HITTER_DOUBLE_PTS      = 5;
export const HITTER_TRIPLE_PTS      = 8;
export const HITTER_HOME_RUN_PTS    = 10;
export const HITTER_RUN_PTS         = 2;
export const HITTER_RBI_PTS         = 2;
export const HITTER_WALK_PTS        = 2;
export const HITTER_HBP_PTS         = 2;
export const HITTER_STOLEN_BASE_PTS = 5;

export function hitterFantasyScore(c: {
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  runs: number;
  rbis: number;
  walks: number;
  hitByPitch: number;
  stolenBases: number;
}): number {
  const singles = Math.max(0, c.hits - c.doubles - c.triples - c.homeRuns);
  return (
    singles * HITTER_SINGLE_PTS +
    c.doubles * HITTER_DOUBLE_PTS +
    c.triples * HITTER_TRIPLE_PTS +
    c.homeRuns * HITTER_HOME_RUN_PTS +
    c.runs * HITTER_RUN_PTS +
    c.rbis * HITTER_RBI_PTS +
    c.walks * HITTER_WALK_PTS +
    c.hitByPitch * HITTER_HBP_PTS +
    c.stolenBases * HITTER_STOLEN_BASE_PTS
  );
}
