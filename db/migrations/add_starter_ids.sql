-- Add nullable starter-id columns to the games table so engine/main.py's
-- future-slate previews can attach probable pitchers to upcoming games.
-- The frontend FutureSlate component joins these to the players table via
-- the games_home_starter_id_fkey / games_away_starter_id_fkey constraint
-- names PostgREST auto-generates.
--
-- Safe: nullable columns; existing rows get NULL until the next cron run
-- repopulates them. The engine handles the pre-migration schema gracefully
-- (db.upsert_games strips these keys and retries on PGRST204), so this
-- migration is decoupled from the engine deploy.

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS home_starter_id integer
    REFERENCES players(player_id),
  ADD COLUMN IF NOT EXISTS away_starter_id integer
    REFERENCES players(player_id);
