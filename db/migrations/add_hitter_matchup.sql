-- Hitter matchup model — SHADOW MODE (2026-06-08).
-- matchup_projection stores the deterministic batter-vs-opposing-starter log5
-- projection (engine/matchup_hitter.py) ALONGSIDE the live baseline projection,
-- on each hitter prop row (hitter_hits / hitter_total_bases / hitter_home_runs).
-- It NEVER changes the displayed projection or edge — engine/matchup_hitter_
-- scorecard.py grades it (Brier-of-the-over + divergence win-rate) against real
-- lines until a prop earns a flip to primary, PER PROP. One generic column (not
-- one-per-prop) so it reads off whatever prop_type the row is.
-- Until applied, the shadow write PGRST204-skips and the pipeline runs cleanly.
alter table projections
  add column if not exists matchup_projection numeric;
