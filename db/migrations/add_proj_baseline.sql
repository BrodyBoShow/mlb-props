-- Matchup-K flip idempotency (2026-06-08).
-- proj_baseline stores the ORIGINAL pre-flip strikeouts projection so the
-- post-lineup matchup-K flip (which re-runs on every refresh) always blends
-- matchup-K with the stable baseline instead of the already-flipped value
-- (which would drift the projection toward pure matchup-K over the day).
-- Until applied, the flip still runs but isn't idempotent (engine/db.py
-- update_strikeout_projection strips proj_baseline on PGRST204 and warns).
alter table projections
  add column if not exists proj_baseline numeric;
