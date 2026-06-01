-- Advanced matchup-context feature columns for player_game_logs.
--
-- All nullable: rows graded before this migration stay as-is with NULL values;
-- the XGBoost model in engine/model.py imputes NULLs with league averages so
-- training proceeds without dropping pre-migration rows. The engine handles
-- the pre-migration schema gracefully (postgrest PGRST204 errors on missing
-- columns are caught upstream), so applying this migration is decoupled from
-- any engine deploy.
--
-- Safe: only ADD COLUMN IF NOT EXISTS — no destructive changes.

ALTER TABLE player_game_logs
  -- Pitcher context features
  ADD COLUMN IF NOT EXISTS lineup_lhh_pct        numeric,
  ADD COLUMN IF NOT EXISTS lineup_rhh_pct        numeric,
  ADD COLUMN IF NOT EXISTS pitcher_k_vs_lhh      numeric,
  ADD COLUMN IF NOT EXISTS pitcher_k_vs_rhh      numeric,
  ADD COLUMN IF NOT EXISTS pitcher_fastball_pct  numeric,
  ADD COLUMN IF NOT EXISTS pitcher_breaking_pct  numeric,
  ADD COLUMN IF NOT EXISTS pitcher_offspeed_pct  numeric,
  ADD COLUMN IF NOT EXISTS pitcher_avg_velo      numeric,
  ADD COLUMN IF NOT EXISTS pitcher_velo_trend    numeric,
  ADD COLUMN IF NOT EXISTS park_factor_hits      numeric,
  ADD COLUMN IF NOT EXISTS park_factor_k         numeric,
  ADD COLUMN IF NOT EXISTS pitcher_pitches_last_start integer,
  -- Hitter context features
  ADD COLUMN IF NOT EXISTS opp_sp_k_rate_last5   numeric,
  ADD COLUMN IF NOT EXISTS opp_sp_era_last5      numeric,
  ADD COLUMN IF NOT EXISTS opp_sp_whip_last5     numeric,
  ADD COLUMN IF NOT EXISTS opp_sp_hand           text,
  ADD COLUMN IF NOT EXISTS opp_sp_projected_ip   numeric,
  ADD COLUMN IF NOT EXISTS opp_bullpen_era_7day  numeric,
  ADD COLUMN IF NOT EXISTS opp_bullpen_k_rate_7day numeric,
  ADD COLUMN IF NOT EXISTS hitter_avg_vs_hand    numeric,
  ADD COLUMN IF NOT EXISTS park_factor_hits_h    numeric,
  ADD COLUMN IF NOT EXISTS temperature           numeric,
  ADD COLUMN IF NOT EXISTS wind_speed            numeric;
