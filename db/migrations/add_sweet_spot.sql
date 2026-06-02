-- Rolling 7-day Statcast batted-ball quality on projections — DISPLAY-ONLY
-- (HR-card footer). Set ONLY on hitter_home_runs rows by
-- engine/main._build_and_upsert_hitters (computed from the bulk Statcast frame
-- in engine/sweet_spot.py). NOT a model input / feature / edge math.
-- Run once in the Supabase SQL editor. Until applied, db.upsert_projections
-- catches PGRST204, strips these columns, and retries (pipeline unaffected;
-- the footer degrades to "N games tracked").
alter table projections
  add column if not exists sweet_spot_pct numeric,   -- fraction (0..1), launch angle 8–32°
  add column if not exists avg_exit_velo  numeric;   -- mean exit velocity (mph), 7-day BBE
