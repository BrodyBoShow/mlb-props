-- First-inning strikeouts (pitcher_first_inning_strikeouts).
--
-- A starting pitcher's strikeout count in the 1st inning, extracted from the MLB
-- live feed (allPlays, inning == 1, eventType strikeout) at grade time. Unlike
-- 1st-inning pitches thrown (PrizePicks-only, proxy-gated), this prop has a REAL
-- two-sided ParlayAPI line (player_1st_inning_pitcher_strikeouts), so it grades
-- lean-vs-line in the /results Betting Edge section.
--
-- Run once in the Supabase SQL editor. Until applied, the engine's PGRST204
-- retry strips the column so grading the other actuals keeps working.
alter table player_game_logs
  add column if not exists actual_first_inning_strikeouts integer;
