-- Hits + Runs + RBIs combo prop (hitter_hits_runs_rbis), main betting line ~1.5.
-- Adds the graded actual to player_game_logs. The engine builds the projection,
-- ingests the two-sided line (player_hits_runs_rbis), computes the edge, and
-- grades the result like Total Bases. Run once in the Supabase SQL editor.
alter table player_game_logs
  add column if not exists actual_hits_runs_rbis integer;
