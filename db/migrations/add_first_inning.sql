-- First-inning props (1-inning betting sector).
--
--   actual_first_inning_pitches  — a starting pitcher's pitch count in the 1st
--     inning (pitcher_first_inning_pitches prop). Extracted from the MLB live
--     feed (allPlays, inning == 1) at grade time.
--
--   actual_first_inning_runs     — total runs scored in the 1st inning by BOTH
--     teams (first_inning_runs / NRFI-YRFI prop). 0 = NRFI, >= 1 = YRFI.
--     Extracted from the box-score linescore. Game-level, so it is stored on a
--     single carrier row per game (the home starting pitcher's player_game_logs
--     row) — the same player_id the engine writes the game-level projection to.
--
-- Run once in the Supabase SQL editor. Until applied, the engine's PGRST204
-- retry strips both columns so grading the other actuals keeps working.
alter table player_game_logs
  add column if not exists actual_first_inning_pitches integer,
  add column if not exists actual_first_inning_runs    integer;
