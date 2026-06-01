"""Data contracts between engine modules.

This file is the SINGLE SOURCE OF TRUTH for the shape of every dict that
flows between modules. Each TypedDict mirrors the actual keys a producer
emits and a consumer reads. Adding a TypedDict here doesn't change runtime
behavior — at runtime a TypedDict IS a plain dict — but it makes the
contracts explicit and lets editors catch key-name typos at edit time.

Convention:
- Every row type uses `total=False`. This means every key is treated as
  NotRequired at use sites — necessary because some downstream code
  (e.g. db.upsert_game_logs' PGRST204 retry) strips a subset of keys
  before reading. The notes on each field state when the key is actually
  populated in practice.
- Keys are listed in the same order they appear in the producer's dict
  literal so the type file reads as documentation of the row layout.
- Optional[T] in the value type means "may be None on this row" (a
  nullable column). NotRequired is the structural property; Optional[T]
  is the value-level property.

When you add or remove a key in a producer function, update the matching
TypedDict here. Editors (mypy / pyright) will then flag any consumer
that still reads the old key — that's the whole point.
"""

from __future__ import annotations

from typing import Optional, TypedDict


# ════════════════════════════════════════════════════════════════════════════
# player_game_logs row types — written by engine/grade.py and persisted by
# engine/db.py:upsert_game_logs. Each row corresponds to one (player, game)
# pair on the date being graded.
# ════════════════════════════════════════════════════════════════════════════


class PitcherGameLogRow(TypedDict, total=False):
    """One graded pitcher row in player_game_logs.

    Producer:  engine/grade.py:grade_yesterday
    Consumers: engine/db.py:upsert_game_logs,
               engine/main.py:_grade_previous_slate
    """

    # ── identity ──────────────────────────────────────────────────────────
    player_id: int
    game_id: int
    game_date: str               # 'YYYY-MM-DD'
    player_type: str             # literal 'pitcher'

    # ── core actuals (from boxscore pitching stats) ──────────────────────
    actual_strikeouts: int
    actual_hits_allowed: int
    actual_walks: int
    actual_earned_runs: int
    actual_outs_recorded: int    # inningsPitched → total outs via _parse_innings
    actual_win: bool             # W decision from decisions endpoint
    actual_pitcher_fantasy_score: float   # PrizePicks formula

    # ── basic context ────────────────────────────────────────────────────
    home_away: str               # literal 'home' | 'away'
    opp_k_rate: float            # opposing team's K% from stats._opp_k_rate
    days_rest: int               # capped at 10, defaults to 5

    # ── original context features (add_context_features.sql) ──────────────
    lineup_lhh_pct: Optional[float]
    lineup_rhh_pct: Optional[float]
    park_factor_k: Optional[float]
    park_factor_hits: Optional[float]
    pitcher_fastball_pct: Optional[float]
    pitcher_breaking_pct: Optional[float]
    pitcher_offspeed_pct: Optional[float]
    pitcher_avg_velo: Optional[float]
    pitcher_pitches_last_start: Optional[int]

    # ── data-foundation: pitcher rest & workload ─────────────────────────
    pitcher_days_rest: Optional[int]
    pitcher_starts_last_21d: Optional[int]
    pitcher_pitches_last_3starts: Optional[int]   # scaffold — gameLog has no pitch counts
    pitcher_innings_last_21d: Optional[float]
    team_games_last_3d: Optional[int]
    team_games_last_7d: Optional[int]

    # ── data-foundation: pitcher recent form (last 3 starts) ─────────────
    pitcher_k_rate_last3: Optional[float]
    pitcher_era_last3: Optional[float]
    pitcher_whip_last3: Optional[float]

    # ── data-foundation: 30-day Statcast platoon + plate-discipline ──────
    pitcher_k_vs_lhh_30d: Optional[float]
    pitcher_k_vs_rhh_30d: Optional[float]
    pitcher_whiff_pct_30d: Optional[float]
    pitcher_csw_pct_30d: Optional[float]

    # ── data-foundation: series / game context ───────────────────────────
    series_game_number: Optional[int]
    is_getaway_day: Optional[bool]
    is_day_game: Optional[bool]
    is_home_team: bool

    # ── data-foundation: weather (dome-aware) ────────────────────────────
    temperature_f: Optional[float]    # °F; 72.0 for dome rows
    wind_speed_mph: Optional[float]   # mph; 0.0 for dome rows
    wind_dir: Optional[str]           # compass abbr; None for dome rows
    precipitation_pct: Optional[float]
    is_dome: Optional[bool]


class HitterGameLogRow(TypedDict, total=False):
    """One graded hitter row in player_game_logs.

    Producer:  engine/grade.py:grade_hitters_yesterday
    Consumers: engine/db.py:upsert_game_logs,
               engine/main.py:_grade_previous_slate
    """

    # ── identity ──────────────────────────────────────────────────────────
    player_id: int
    game_id: int
    game_date: str               # 'YYYY-MM-DD'
    player_type: str             # literal 'hitter'

    # ── core actuals (from boxscore batting stats) ───────────────────────
    actual_hits: int
    actual_total_bases: int      # hits + doubles + 2*triples + 3*home_runs
    actual_rbis: int
    actual_runs: int
    actual_home_runs: int
    doubles: int                 # component for fantasy_score
    triples: int                 # component for fantasy_score
    hit_by_pitch: int            # component for fantasy_score
    stolen_bases: int            # component for fantasy_score
    actual_hitter_fantasy_score: float    # PrizePicks formula

    # ── basic context ────────────────────────────────────────────────────
    home_away: str               # literal 'home' | 'away'

    # ── original context features (add_context_features.sql) ─────────────
    # These come from _opp_sp_recent_stats() and always have a value
    # (league-avg fallback if SP unknown), so they're never None.
    opp_sp_k_rate_last5: float
    opp_sp_era_last5: float
    opp_sp_whip_last5: float
    opp_sp_hand: str             # 'L' | 'R' (defaults 'R' when unknown)
    park_factor_hits_h: Optional[float]
    hitter_avg_vs_hand: float    # last-15-game proxy, rounded(3)

    # ── data-foundation: schedule density ────────────────────────────────
    team_games_last_3d: Optional[int]
    team_games_last_7d: Optional[int]
    hitter_games_last_7d: int    # always 0+ (count of games in window)

    # ── data-foundation: day/getaway/series/home ─────────────────────────
    is_day_game: Optional[bool]
    series_game_number: Optional[int]
    is_getaway_day: Optional[bool]
    is_home_team: bool

    # ── data-foundation: hitter recent form ──────────────────────────────
    hitter_avg_last7: Optional[float]
    hitter_avg_last15: Optional[float]
    hitter_k_rate_last7: Optional[float]
    hitter_ops_last15: Optional[float]
    hitter_hr_last15: Optional[int]

    # ── data-foundation: opp bullpen exposure (scaffold — all None today) ─
    opp_bullpen_era_14d: Optional[float]
    opp_bullpen_k_rate_14d: Optional[float]
    opp_bullpen_whip_14d: Optional[float]
    opp_bullpen_innings_last3d: Optional[float]

    # ── data-foundation: weather (dome-aware) ────────────────────────────
    temperature_f: Optional[float]
    wind_speed_mph: Optional[float]
    wind_dir: Optional[str]
    precipitation_pct: Optional[float]
    is_dome: Optional[bool]


# ════════════════════════════════════════════════════════════════════════════
# projections / lines / edges row types
# ════════════════════════════════════════════════════════════════════════════


class ProjectionRow(TypedDict, total=False):
    """Row written to the projections table by baseline.py and model.py.

    Producer:  engine/baseline.py:build_*_projections,
               engine/model.py:predict
    Consumers: engine/db.py:upsert_projections (via this exact shape),
               engine/db.py:get_projections_for_date (returns a
               ProjectionContextRow — the same 5 fields plus joined
               team/start fields — see below).
    """

    game_id: int
    player_id: int
    prop_type: str               # 'strikeouts', 'hits_allowed', 'hitter_hits', ...
    projection: float            # rounded to 1 decimal
    projection_date: str         # 'YYYY-MM-DD' — part of the composite PK
    # Opposing-lineup season K rate (0..1). ONLY set on strikeouts rows
    # (the only prop the XGBoost model runs) — the feature builder already
    # computes it; predict() now carries it onto the row instead of
    # discarding it. Frontend reads it for the "Facing a X% K lineup" line.
    # Nullable: baseline-only props never set it. Requires the
    # add_opp_k_rate.sql migration; db.upsert_projections strips it via
    # the PGRST204 retry until the column exists.
    opp_k_rate: Optional[float]


class ProjectionContextRow(TypedDict, total=False):
    """Read-side projection shape returned by db.get_projections_for_date.

    Identical to ProjectionRow but augmented at read time with the joined
    team/start_time fields that grade.py needs to derive home_away, look
    up park factors, and time-bucket weather forecasts.

    Producer:  engine/db.py:get_projections_for_date
    Consumers: engine/grade.py:grade_yesterday,
               engine/grade.py:grade_hitters_yesterday,
               engine/main.py:_grade_previous_slate,
               engine/edge.py:compute_edges (only reads player_id,
               prop_type, projection, projection_date)
    """

    game_id: int
    player_id: int
    projection: float
    prop_type: str
    home_team: Optional[str]     # joined from games table
    away_team: Optional[str]     # joined from games table
    home_away: Optional[str]     # derived: 'home' | 'away' | None
    start_time: Optional[str]    # joined ISO UTC; consumed by weather + is_day_game


class LineRow(TypedDict, total=False):
    """One betting line row written to the `lines` table.

    Producer:  engine/lines.py:fetch_prop_lines
    Consumers: engine/db.py:upsert_lines,
               engine/edge.py:compute_edges
    """

    player_id: int
    player_name: str             # raw ParlayAPI string (pre-normalization)
    prop_type: str               # mapped via MARKET_TO_PROP
    bookmaker: str               # 'pinnacle' | 'draftkings' | ...
    line: float                  # numeric over/under
    over_price: Optional[int]    # American odds; None when book posts one side
    under_price: Optional[int]
    game_date: str               # 'YYYY-MM-DD'


class EdgeRow(TypedDict, total=False):
    """One model-vs-market edge row written to the `edges` table.

    Producer:  engine/edge.py:compute_edges
    Consumers: engine/db.py:upsert_edges,
               engine/main.py:_run_lines_and_edges,
               web/app/page.tsx (frontend reads via Supabase REST)
    """

    player_id: int
    prop_type: str
    game_date: str
    bookmaker: str               # source book for the baseline line
    line: float                  # rounded(2)
    fair_over_prob: float        # de-vigged 0..1, rounded(4)
    model_proj: float            # model's projection, rounded(2)
    model_over_prob: float       # normal-approx P(actual >= line), rounded(4)
    edge: float                  # model_over_prob - fair_over_prob, rounded(4)
    over_price: Optional[int]
    under_price: Optional[int]


# ════════════════════════════════════════════════════════════════════════════
# Intermediate shapes — never persisted to the DB
# ════════════════════════════════════════════════════════════════════════════


class WeatherFields(TypedDict, total=False):
    """Dict returned by weather.get_game_weather and merged into grade rows.

    Producer:  engine/weather.py:get_game_weather
    Consumers: engine/grade.py:grade_yesterday,
               engine/grade.py:grade_hitters_yesterday

    Every field is Optional[T] because the no-API-key / fetch-failed path
    returns all-None. The dome path returns the neutral indoor baseline
    (72.0 °F / 0.0 mph / None wind_dir / 0.0 precip / True dome). is_dome
    is always set (it's resolvable from the home-team string alone).
    """

    temperature_f: Optional[float]
    wind_speed_mph: Optional[float]
    wind_dir: Optional[str]
    precipitation_pct: Optional[float]
    is_dome: bool                 # always set even on empty-weather path


class PitcherFeatureRow(TypedDict, total=False):
    """One pitcher feature vector for XGBoost predict().

    Producer:  engine/model.py:_build_pitcher_features_from_df
    Consumers: engine/model.py:predict (vector is built from FEATURE_COLS)

    Every key listed in model.FEATURE_COLS MUST appear here. The bulk-DF
    path also emits a few extras (pitcher_breaking_pct, _offspeed_pct,
    pitcher_velo_trend) that aren't in FEATURE_COLS today but are listed
    for completeness — they're available for future inclusion without a
    second migration.
    """

    last5_k_rate: float
    last30_k_rate: float
    is_home: int                 # 1 | 0
    days_rest: int               # capped at 10
    opp_k_rate: float

    # Context features added to FEATURE_COLS in the model-extension pass.
    pitcher_k_vs_lhh: float
    pitcher_k_vs_rhh: float
    pitcher_fastball_pct: float
    pitcher_avg_velo: float
    park_factor_k: float
    lineup_lhh_pct: float        # currently hardcoded 0.42 in bulk path

    # Returned by the builder but NOT in FEATURE_COLS today — future hooks.
    pitcher_breaking_pct: float
    pitcher_offspeed_pct: float
    pitcher_velo_trend: float
