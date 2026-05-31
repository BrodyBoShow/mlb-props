"""PrizePicks MLB fantasy-score scoring constants + helpers.

Single source of truth for both hitter and pitcher PrizePicks fantasy-score
weights. Graders, baselines, edges, and any live in-game calculation MUST
import from here — never duplicate the weights anywhere else.

These values come directly from the official PrizePicks MLB scoring chart:

  HITTER
    single      = 3   (singles = hits - doubles - triples - home_runs)
    double      = 5
    triple      = 8
    home_run    = 10
    run         = 2
    rbi         = 2
    walk        = 2
    hbp         = 2
    stolen_base = 5

  PITCHER
    win           = 6
    quality_start = 4   (>= 18 outs AND <= 3 earned runs)
    earned_run    = -3
    strikeout     = 3
    out           = 1

A mirror of these constants exists in web/lib/fantasyScore.ts. When you
change a weight here, change it there too — there's a comment on each file
pointing at the other.
"""

# ── pitcher ──────────────────────────────────────────────────────────────────

PITCHER_WIN_PTS            = 6
PITCHER_QUALITY_START_PTS  = 4
PITCHER_EARNED_RUN_PTS     = -3
PITCHER_STRIKEOUT_PTS      = 3
PITCHER_OUT_PTS            = 1

QUALITY_START_OUTS_MIN          = 18   # 6 IP
QUALITY_START_EARNED_RUNS_MAX   = 3


def is_quality_start(outs: int, earned_runs: int) -> bool:
    """PrizePicks quality-start trigger: >= 6 IP AND <= 3 ER."""
    return (
        outs >= QUALITY_START_OUTS_MIN
        and earned_runs <= QUALITY_START_EARNED_RUNS_MAX
    )


def pitcher_fantasy_score(
    outs: int,
    strikeouts: int,
    earned_runs: int,
    win: bool,
) -> float:
    """Compute a pitcher's PrizePicks fantasy score from boxscore components.

    Pass win=False for live in-game calculation — the W bonus and QS bonus
    only become final when the game ends. The QS check is derived from outs
    and earned_runs, so once those are final (game ends) the QS bonus is
    correct without any extra inputs.
    """
    score = (
        outs * PITCHER_OUT_PTS
        + strikeouts * PITCHER_STRIKEOUT_PTS
        + earned_runs * PITCHER_EARNED_RUN_PTS
    )
    if win:
        score += PITCHER_WIN_PTS
    if is_quality_start(outs, earned_runs):
        score += PITCHER_QUALITY_START_PTS
    return float(score)


# ── hitter ───────────────────────────────────────────────────────────────────

HITTER_SINGLE_PTS      = 3
HITTER_DOUBLE_PTS      = 5
HITTER_TRIPLE_PTS      = 8
HITTER_HOME_RUN_PTS    = 10
HITTER_RUN_PTS         = 2
HITTER_RBI_PTS         = 2
HITTER_WALK_PTS        = 2
HITTER_HBP_PTS         = 2
HITTER_STOLEN_BASE_PTS = 5


def hitter_fantasy_score(
    hits: int,
    doubles: int,
    triples: int,
    home_runs: int,
    runs: int,
    rbis: int,
    walks: int,
    hit_by_pitch: int,
    stolen_bases: int,
) -> float:
    """Compute a hitter's PrizePicks fantasy score from boxscore components.

    Singles are derived: singles = hits - doubles - triples - home_runs.
    Negative singles (data error) are clamped to 0 so we never produce a
    negative-by-mistake projection.
    """
    singles = max(0, hits - doubles - triples - home_runs)
    return float(
        singles * HITTER_SINGLE_PTS
        + doubles * HITTER_DOUBLE_PTS
        + triples * HITTER_TRIPLE_PTS
        + home_runs * HITTER_HOME_RUN_PTS
        + runs * HITTER_RUN_PTS
        + rbis * HITTER_RBI_PTS
        + walks * HITTER_WALK_PTS
        + hit_by_pitch * HITTER_HBP_PTS
        + stolen_bases * HITTER_STOLEN_BASE_PTS
    )
