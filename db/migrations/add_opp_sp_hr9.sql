-- Opposing starter's HR allowed per 9 IP (last 5 starts) on projections —
-- the HR-composite 4th term. Set ONLY on hitter_home_runs rows by
-- engine/main._build_and_upsert_hitters (computed from stats.get_pitcher_hr9_last5,
-- the same get_pitcher_starts source as the pitcher props — no new fetch).
-- NOT a model input / feature / edge math.
-- Run once in the Supabase SQL editor. Until applied, db.upsert_projections
-- catches PGRST204, strips this column, and retries (pipeline unaffected; the
-- composite degrades the opp-SP-HR/9 term to neutral).
alter table projections
  add column if not exists opp_sp_hr9 numeric;   -- HR allowed per 9 IP, opp starter, last 5 starts
