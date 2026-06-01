-- Remove the ambiguous single-value projection column from
-- player_game_logs. Per-prop projections live in the projections
-- table (game_id, player_id, prop_type, projection_date).
-- Safe: nothing reads player_game_logs.projection in the pipeline.
ALTER TABLE player_game_logs DROP COLUMN IF EXISTS projection;
