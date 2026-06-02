-- Game-time wind on the games table — DISPLAY-ONLY (HR-card wind tag).
-- Persisted each cron run by engine/main._run_game_weather via
-- db.update_game_weather. NOT a model input / feature / edge math.
-- Run once in the Supabase SQL editor. Until applied, db.update_game_weather
-- catches PGRST204, warns, and skips the wind write (pipeline unaffected;
-- the wind tag degrades to the static park label).
alter table games
  add column if not exists wind_speed_mph numeric,   -- mph; 0 for domes, NULL if no key
  add column if not exists wind_dir_deg   numeric,   -- OWM FROM degrees (0=N); NULL dome/no-data
  add column if not exists is_dome        boolean;   -- true → frontend "Dome · neutral"
