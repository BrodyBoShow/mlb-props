"""Shared constants for the engine. Import from here; never redefine locally."""

# Strikeout event types (Statcast)
STRIKEOUT_EVENTS = {"strikeout", "strikeout_double_play"}

# Hit event types (Statcast)
HIT_EVENTS = {"single", "double", "triple", "home_run"}

# Walk event types (Statcast)
WALK_EVENTS = {"walk", "intent_walk"}

# Baseline projection parameters
LOOKBACK_DAYS = 30       # days of history to pull for each pitcher
RECENT_STARTS = 5        # starts that receive the heavier weight
RECENT_WEIGHT = 2.0      # weight for the most recent RECENT_STARTS starts
OLDER_WEIGHT = 1.0       # weight for starts older than RECENT_STARTS

# Fallback / defaults
LEAGUE_AVG_K_PCT = 0.22  # ~22% of MLB plate appearances end in a strikeout
