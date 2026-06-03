-- Season backfill flag. Rows inserted by engine/backfill_logs.py (historical
-- per-game actuals pulled from the MLB Stats API so hit-rate trends + confidence
-- reflect the FULL season, not just games graded since the engine started).
--
-- FOUNDATION SAFETY: backfilled rows carry actuals only (no context features),
-- so model.train() EXCLUDES backfilled=true rows -> the XGBoost strikeout model
-- trains on exactly the same graded rows as before (byte-identical). The flag is
-- what lets these rows later be fed into training DELIBERATELY (Stage 2, once a
-- measured pass shows it improves prediction) instead of silently. Trends +
-- confidence read all rows, so they gain the season immediately.
alter table player_game_logs
  add column if not exists backfilled boolean default false;
