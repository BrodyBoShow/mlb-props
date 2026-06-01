"""Shared constants for the engine. Import from here; never redefine locally."""

from datetime import date as _date, datetime as _datetime
from zoneinfo import ZoneInfo as _ZoneInfo

# Strikeout event types (Statcast)
STRIKEOUT_EVENTS = {"strikeout", "strikeout_double_play"}


# ─── timezone helpers ────────────────────────────────────────────────────────
#
# The engine runs on UTC infrastructure (GitHub Actions, Vercel) but every
# MLB-side date (statsapi.schedule, ParlayAPI game_date, baseball convention
# generally) is anchored on ET. Using Python's bare date.today() returns the
# UTC date, which silently disagrees with the MLB API any time it's < 4 AM
# UTC (= 11/midnight ET). That's exactly when the 9 PM ET cron fires, so
# without an ET-aware helper the late-evening run writes the WRONG slate's
# pitchers under "today's" projection_date.

_ET = _ZoneInfo("America/New_York")


def et_today() -> _date:
    """Today's date in America/New_York. Use this anywhere we need to align
    with statsapi.schedule()'s implicit ET anchor — i.e. nearly everywhere
    the engine cares about "today's slate"."""
    return _datetime.now(_ET).date()

# Baseline projection parameters
LOOKBACK_DAYS = 30       # days of history to pull for each pitcher
RECENT_STARTS = 5        # starts that receive the heavier weight
RECENT_WEIGHT = 2.0      # weight for the most recent RECENT_STARTS starts
OLDER_WEIGHT = 1.0       # weight for starts older than RECENT_STARTS

# Fallback / defaults
LEAGUE_AVG_K_PCT = 0.22  # ~22% of MLB plate appearances end in a strikeout

# ─── XGBoost layer (model.py + main.py) ──────────────────────────────────────

# Minimum graded rows in player_game_logs before train() will fit a model.
# Below this we fall through to baseline-only projections.
MIN_TRAINING_ROWS = 25

# Blend weights when both baseline and model produce a projection for the
# same pitcher. The two must sum to 1.0.
BLEND_MODEL_WEIGHT    = 0.6
BLEND_BASELINE_WEIGHT = 0.4

# Days of Statcast history pulled into each predict() call. Mirrors
# LOOKBACK_DAYS in spirit but is kept separately so the bulk Statcast
# fetch in model.py can be tuned without touching baseline windowing.
STATCAST_LOOKBACK_DAYS = 30

# ─── Edge calculation (edge.py) ──────────────────────────────────────────────

# Coefficient of variation for the normal approximation of pitcher prop
# outcomes used by edge._model_over_prob().
PROP_CV = 0.35
MIN_STD = 0.5            # floor so a near-zero projection never gives scale=0

# How far the model probability must beat the de-vigged book probability to
# count as a real lean. Display-only in the frontend today; declared here
# so future Python-side filtering can reference the same threshold.
EDGE_THRESHOLD = 0.1

# ─── Calibration (calibrate.py) ──────────────────────────────────────────────

# Minimum graded starts required to emit a confidence score for a (player,
# prop) pair. Pitchers below this stay NULL in the confidence column.
MIN_GRADED_STARTS = 5

# ─── Park factors (grade.py + model.py) ──────────────────────────────────────
#
# Park factor = multiplicative effect of the venue on the named outcome.
# 1.00 = neutral; > 1.00 inflates the stat at that park; < 1.00 suppresses.
# Indexed by the FULL team name (matches games.home_team / projections.home_team
# strings) so the lookup is a single dict get with no normalization.
#
# Sources: rolling 3-year park factors as of the 2025 season. Recalibrate
# annually if a park's dimensions or environmental conditions change
# materially (e.g., Rogers Centre wall changes).

PARK_FACTORS_HITS: dict[str, float] = {
    "Colorado Rockies":       1.15,
    "Cincinnati Reds":        1.08,
    "Boston Red Sox":         1.07,
    "Philadelphia Phillies":  1.05,
    "Texas Rangers":          1.04,
    "Chicago Cubs":           1.03,
    "Atlanta Braves":         1.02,
    "New York Yankees":       1.01,
    "Kansas City Royals":     1.01,
    "Toronto Blue Jays":      1.01,
    "Baltimore Orioles":      1.00,
    "Minnesota Twins":        1.00,
    "Chicago White Sox":      1.00,
    "Washington Nationals":   1.00,
    "Athletics":              0.99,
    "Houston Astros":         0.99,
    "Los Angeles Angels":     0.99,
    "Pittsburgh Pirates":     0.99,
    "St. Louis Cardinals":    0.98,
    "Detroit Tigers":         0.98,
    "Arizona Diamondbacks":   0.98,
    "New York Mets":          0.98,
    "Milwaukee Brewers":      0.97,
    "Cleveland Guardians":    0.97,
    "Los Angeles Dodgers":    0.97,
    "Tampa Bay Rays":         0.96,
    "Oakland Athletics":      0.96,
    "Seattle Mariners":       0.95,
    "San Francisco Giants":   0.95,
    "Miami Marlins":          0.95,
    "San Diego Padres":       0.93,
}

# Strikeout park factor. Only parks materially off neutral are listed; the
# helper returns 1.0 for any team not in this dict.
PARK_FACTORS_K: dict[str, float] = {
    # K-suppressing
    "Colorado Rockies":       0.94,
    "Kansas City Royals":     0.97,
    "Boston Red Sox":         0.98,
    # K-inflating
    "San Diego Padres":       1.03,
    "Seattle Mariners":       1.02,
    "Tampa Bay Rays":         1.02,
    "Oakland Athletics":      1.01,
}


def get_park_factor_hits(home_team: str) -> float:
    """Park factor for hits. 1.0 = neutral."""
    return PARK_FACTORS_HITS.get(home_team, 1.0)


def get_park_factor_k(home_team: str) -> float:
    """Park factor for strikeouts. 1.0 = neutral."""
    return PARK_FACTORS_K.get(home_team, 1.0)

