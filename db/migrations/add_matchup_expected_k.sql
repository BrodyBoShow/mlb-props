-- One-time migration: add the SHADOW matchup-expected-K column to projections.
--
-- Deterministic batter-by-batter expected strikeouts (lineup x per-batter K%
-- x platoon x expected PAs), computed by engine/matchup_k.py and stored ONLY
-- on strikeouts rows when the opposing lineup is posted. It is LOGGED for
-- calibration validation, NOT the displayed projection — the live strikeout
-- projection / edge / blend are unchanged. Run once in the Supabase SQL editor.
--
-- Pre-migration the pipeline runs clean: db.update_matchup_expected_k catches
-- PGRST204 and skips the shadow write.

alter table projections
  add column if not exists matchup_expected_k numeric;
