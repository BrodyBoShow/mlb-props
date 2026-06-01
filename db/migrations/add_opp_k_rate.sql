-- Persist the opposing-lineup season K rate onto strikeouts projection rows
-- (feature 4 / Option A). The engine already computes this as a model feature
-- in model._build_pitcher_features_from_df; predict() now carries it onto the
-- returned strikeouts row instead of discarding it. The frontend reads it to
-- render the "Facing a X% K lineup" context line on the Strikeouts tab.
--
-- Nullable: only strikeouts rows set it (the only prop the XGBoost model runs);
-- baseline-only props leave it NULL. db.upsert_projections strips the column
-- and retries on PGRST204 so the pipeline runs cleanly before this is applied.
--
-- Safe: ADD COLUMN IF NOT EXISTS, no destructive change.

ALTER TABLE projections
  ADD COLUMN IF NOT EXISTS opp_k_rate numeric;
