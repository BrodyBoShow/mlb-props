-- Advanced data-foundation feature columns for player_game_logs.
--
-- Pure data-collection sprint: every column is nullable, the XGBoost
-- FEATURE_COLS stays at 11, and the model's behaviour is byte-identical
-- before vs after this migration. The engine starts logging these fields
-- per graded game so the model can eventually learn from them once enough
-- rows accumulate to measure feature importance.
--
-- Safe: ADD COLUMN IF NOT EXISTS throughout. db.upsert_game_logs in the
-- engine catches PGRST204 ("Could not find the X column") and retries
-- stripped of the new columns, so the pipeline runs cleanly both before
-- and after this migration is applied.

ALTER TABLE player_game_logs
  -- Rest & fatigue (pitcher)
  ADD COLUMN IF NOT EXISTS pitcher_days_rest          integer,
  ADD COLUMN IF NOT EXISTS pitcher_starts_last_21d    integer,
  ADD COLUMN IF NOT EXISTS pitcher_pitches_last_3starts integer,
  ADD COLUMN IF NOT EXISTS pitcher_innings_last_21d   numeric,
  -- Rest & fatigue (team / hitter)
  ADD COLUMN IF NOT EXISTS team_games_last_3d         integer,
  ADD COLUMN IF NOT EXISTS team_games_last_7d         integer,
  ADD COLUMN IF NOT EXISTS hitter_games_last_7d       integer,
  ADD COLUMN IF NOT EXISTS is_day_game                boolean,
  ADD COLUMN IF NOT EXISTS is_getaway_day             boolean,
  -- Recent form (hitter)
  ADD COLUMN IF NOT EXISTS hitter_avg_last7           numeric,
  ADD COLUMN IF NOT EXISTS hitter_avg_last15          numeric,
  ADD COLUMN IF NOT EXISTS hitter_k_rate_last7        numeric,
  ADD COLUMN IF NOT EXISTS hitter_ops_last15          numeric,
  ADD COLUMN IF NOT EXISTS hitter_hr_last15           integer,
  -- Recent form (pitcher)
  ADD COLUMN IF NOT EXISTS pitcher_k_rate_last3       numeric,
  ADD COLUMN IF NOT EXISTS pitcher_era_last3          numeric,
  ADD COLUMN IF NOT EXISTS pitcher_whip_last3         numeric,
  -- Bullpen exposure (hitter)
  ADD COLUMN IF NOT EXISTS opp_bullpen_era_14d        numeric,
  ADD COLUMN IF NOT EXISTS opp_bullpen_k_rate_14d     numeric,
  ADD COLUMN IF NOT EXISTS opp_bullpen_whip_14d       numeric,
  ADD COLUMN IF NOT EXISTS opp_bullpen_innings_last3d numeric,
  -- Platoon splits logged at GRADE time (pitcher) — fixes the prior
  -- "always-NULL in training" gap where these only existed at predict time
  ADD COLUMN IF NOT EXISTS pitcher_k_vs_lhh_30d       numeric,
  ADD COLUMN IF NOT EXISTS pitcher_k_vs_rhh_30d       numeric,
  ADD COLUMN IF NOT EXISTS pitcher_whiff_pct_30d      numeric,
  ADD COLUMN IF NOT EXISTS pitcher_csw_pct_30d        numeric,
  -- Series / travel context
  ADD COLUMN IF NOT EXISTS series_game_number         integer,
  ADD COLUMN IF NOT EXISTS is_home_team               boolean,
  -- Weather (game time)
  ADD COLUMN IF NOT EXISTS temperature_f              numeric,
  ADD COLUMN IF NOT EXISTS wind_speed_mph             numeric,
  ADD COLUMN IF NOT EXISTS wind_dir                   text,
  ADD COLUMN IF NOT EXISTS is_dome                    boolean,
  ADD COLUMN IF NOT EXISTS precipitation_pct          numeric;
