-- One-time migration: add observed_lines to the lines table.
--
-- PrizePicks fantasy-score props (pitcher_fantasy_score / hitter_fantasy_score)
-- are served by ParlayAPI as a goblin/standard/demon alt-line LADDER, and the
-- API returns a RANDOM rung on each call. The pipeline now accumulates the
-- distinct rungs seen across the day's cron runs in this column and stores the
-- MEDIAN rung (the standard PrizePicks line) in `line`. NULL for non-fantasy
-- props. Run once in the Supabase SQL editor.

alter table lines
  add column if not exists observed_lines text;
