"""Shared constants for the engine. Import from here; never redefine locally."""

from datetime import date as _date, datetime as _datetime
from zoneinfo import ZoneInfo as _ZoneInfo

# Strikeout event types (Statcast)
STRIKEOUT_EVENTS = {"strikeout", "strikeout_double_play"}

# League-average hitter PrizePicks fantasy score per game — used as the floor
# for build_hitter_fantasy_score_projections when a hitter has no usable game
# history (debut / call-up) or the rolling average rounds to 0. A literal 0 FP
# is a sentinel, not a real projection — no MLB starter projects to 0 fantasy
# points. ~3.5 matches the typical starter's FP (the other lineup hitters
# project 3.2–4.1 FP). Used ONLY for the empty/zero case; players with real
# history keep their real projection.
LEAGUE_AVG_HITTER_FP = 3.5


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


# ─── Venues — coords + dome flags ────────────────────────────────────────────
#
# Latitude / longitude of each MLB home ballpark, keyed on the same full
# team name string statsapi.schedule and our games.home_team column use.
# Coords are accurate to ~0.001° (≈ 100 m) which is more than enough for an
# OpenWeatherMap forecast call. Used by engine/weather.py.
#
# A&'s "Athletics" string is whatever the current schedule API returns —
# the 2025+ Sacramento move keeps the same nominal team name.

VENUE_COORDS: dict[str, tuple[float, float]] = {
    "Arizona Diamondbacks":   (33.4453, -112.0667),
    "Atlanta Braves":         (33.8908,  -84.4678),
    "Baltimore Orioles":      (39.2839,  -76.6217),
    "Boston Red Sox":         (42.3467,  -71.0972),
    "Chicago Cubs":           (41.9484,  -87.6553),
    "Chicago White Sox":      (41.8300,  -87.6339),
    "Cincinnati Reds":        (39.0975,  -84.5066),
    "Cleveland Guardians":    (41.4962,  -81.6852),
    "Colorado Rockies":       (39.7559, -104.9942),
    "Detroit Tigers":         (42.3390,  -83.0485),
    "Houston Astros":         (29.7572,  -95.3556),
    "Kansas City Royals":     (39.0517,  -94.4803),
    "Los Angeles Angels":     (33.8003, -117.8827),
    "Los Angeles Dodgers":    (34.0739, -118.2400),
    "Miami Marlins":          (25.7780,  -80.2196),
    "Milwaukee Brewers":      (43.0280,  -87.9712),
    "Minnesota Twins":        (44.9817,  -93.2776),
    "New York Mets":          (40.7571,  -73.8458),
    "New York Yankees":       (40.8296,  -73.9262),
    "Athletics":              (38.5816, -121.4944),   # Sacramento (post-2024)
    "Oakland Athletics":      (37.7516, -122.2005),   # legacy string fallback
    "Philadelphia Phillies":  (39.9061,  -75.1665),
    "Pittsburgh Pirates":     (40.4469,  -80.0057),
    "San Diego Padres":       (32.7073, -117.1566),
    "San Francisco Giants":   (37.7786, -122.3893),
    "Seattle Mariners":       (47.5914, -122.3325),
    "St. Louis Cardinals":    (38.6226,  -90.1928),
    "Tampa Bay Rays":         (27.7682,  -82.6534),
    "Texas Rangers":          (32.7473,  -97.0817),
    "Toronto Blue Jays":      (43.6414,  -79.3894),
    "Washington Nationals":   (38.8730,  -77.0074),
}


# MLB Stats API team IDs, keyed on the same full-team-name string we use
# elsewhere. statsapi.schedule(team=...) REQUIRES an integer id — passing
# the name string yields a 400 ("teamId=New York Yankees"). Verified via
# statsapi.lookup_team; these IDs are stable across seasons.
TEAM_NAME_TO_ID: dict[str, int] = {
    "Arizona Diamondbacks":   109,
    "Atlanta Braves":         144,
    "Baltimore Orioles":      110,
    "Boston Red Sox":         111,
    "Chicago Cubs":           112,
    "Chicago White Sox":      145,
    "Cincinnati Reds":        113,
    "Cleveland Guardians":    114,
    "Colorado Rockies":       115,
    "Detroit Tigers":         116,
    "Houston Astros":         117,
    "Kansas City Royals":     118,
    "Los Angeles Angels":     108,
    "Los Angeles Dodgers":    119,
    "Miami Marlins":          146,
    "Milwaukee Brewers":      158,
    "Minnesota Twins":        142,
    "New York Mets":          121,
    "New York Yankees":       147,
    "Athletics":              133,
    "Oakland Athletics":      133,
    "Philadelphia Phillies":  143,
    "Pittsburgh Pirates":     134,
    "San Diego Padres":       135,
    "San Francisco Giants":   137,
    "Seattle Mariners":       136,
    "St. Louis Cardinals":    138,
    "Tampa Bay Rays":         139,
    "Texas Rangers":          140,
    "Toronto Blue Jays":      141,
    "Washington Nationals":   120,
}


# Teams whose home venue is a dome or has a closed-roof default. Weather
# fetches for these are skipped (temperature pinned to 72 / wind 0) since
# atmospheric conditions don't reach the field.
IS_DOME: set[str] = {
    "Tampa Bay Rays",         # Tropicana Field (fixed dome)
    "Milwaukee Brewers",      # American Family Field (retractable, usually closed)
    "Arizona Diamondbacks",   # Chase Field (retractable, usually closed in summer)
    "Houston Astros",         # Minute Maid Park (retractable, usually closed in summer)
    "Texas Rangers",          # Globe Life Field (retractable, usually closed in summer)
    "Toronto Blue Jays",      # Rogers Centre (retractable, usually closed in cold months)
    "Miami Marlins",          # loanDepot park (retractable, usually closed in summer)
    "Seattle Mariners",       # T-Mobile Park (retractable; default-closed when raining)
}

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

