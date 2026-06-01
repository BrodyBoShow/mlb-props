"""Shared constants for the engine. Import from here; never redefine locally."""

# Strikeout event types (Statcast)
STRIKEOUT_EVENTS = {"strikeout", "strikeout_double_play"}

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

