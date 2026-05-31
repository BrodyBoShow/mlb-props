# MLB Prop Analyzer — Project Memory

## What we're building
A web app that produces calibrated MLB player-prop projections (hits, total
bases, strikeouts, etc.) for bettors and fans. Projections must load instantly
and consistently. The model improves over the season by learning from graded results.

## Core architecture principle (most important thing)
Decouple computation from serving. NEVER fetch APIs or run the model inside a
user's web request. A scheduled job does all heavy work ahead of time and writes
finished projections to the database; the frontend only reads those rows. This
is what makes the site instant and reliable.

Data flows ONE direction only:
sources -> scheduled job (fetch, clean, train, project) -> database -> frontend -> user

## Problems this design solves (failures of the previous model)
1. Slow per-prop scans -> precompute; the user reads a finished row.
2. Inconsistent/failing API data reaching the UI -> only the scheduled job talks
   to APIs and normalizes to one clean schema before storing. Frontend never
   touches a raw API.
3. 512MB host memory limit during training -> training happens OFF the web host
   (GitHub Actions / Colab / local); model exported as a small file. The web
   layer only reads.

## Folder structure
- engine/  Python. The ONLY place that touches data APIs or the model.
- db/      Database schema (schema.sql). The contract engine and frontend obey.
- web/     Next.js frontend. Reads the DB and displays. ZERO math/business logic.
- .github/workflows/  The scheduled cron job that runs the engine.

## Conventions (IMPORTANT — these keep the project clean)
- All projection/feature math lives in engine/. The frontend computes nothing.
- One writer (the scheduled job), one reader (the frontend). No component does both.
- Writes to `projections` are idempotent UPSERTs keyed on
  (game_id, player_id, prop_type, projection_date) so re-runs never duplicate rows.
- Logging goes to stdout (Actions captures it). NEVER write log rows into the DB.
- Secrets (Supabase key, etc.) live in Actions secrets or a gitignored .env. Never commit secrets.
- Prefer the simplest thing that works. Don't add tools or abstractions before they're needed.

## Tech stack (all free tiers)
- Data: pybaseball (Statcast/FanGraphs/Baseball Reference) + MLB Stats API
  (statsapi.mlb.com, schedules/lineups, no key).
- Scheduled compute + training: GitHub Actions (cron). Model trained off the web host.
- Storage: Supabase free Postgres (~500MB): players, games, projections, results.
- Frontend: Vercel (free), reads Supabase directly.
- Model: baseline = weighted rolling average (Marcel-style); then XGBoost/LightGBM
  on context features; ensemble the two. Calibrate probabilities (isotonic/Platt),
  check with Brier score and reliability diagram.

## Build sequence (the setup process / roadmap)
1. [DONE] Repo: git init, folders, .gitignore, README, first commit.
2. db/schema.sql — players, games, projections tables (the contract).
3. Create a free Supabase project; run schema.sql there to build the tables.
4. engine/fetch.py + engine/db.py — pull schedule/lineups + stats, normalize, upsert players & games.
5. engine/baseline.py + engine/project.py — compute baseline projections, upsert them. (Working pipeline.)
6. .github/workflows/refresh.yml — run engine on a cron (morning + after lineups). Secrets in Actions.
7. web/ — Next.js page on Vercel that reads projections and displays them. (Live v1.)
8. engine/model.py — add XGBoost, export model.pkl, ensemble with baseline.
9. Add projection_snapshots + grading job -> accumulate labeled data -> retrain.
10. Add calibration + de-vig line comparison for betting edges. NOTE: betting
    lines are the hardest, most fragile data source — isolate them with fallback
    to the last good snapshot so their flakiness never touches the projections.

## Current status
Steps 1-10 complete. Working pipeline + frontend:
- engine/fetch.py — pure MLB Stats API layer. fetch_games(), fetch_starters()
  (probable pitchers linked to game_id, lru_cached), fetch_probable_pitchers()
  (players-table rows). No DB code.
- engine/db.py — the ONLY writer. upsert_players/games/projections/game_logs,
  update_confidences, idempotent on each table's PK. Uses SUPABASE_KEY
  (service_role) to bypass RLS; falls back to SUPABASE_ANON_KEY.
- engine/constants.py — shared constants (STRIKEOUT/HIT/WALK_EVENTS,
  LOOKBACK_DAYS, RECENT_*, LEAGUE_AVG_K_PCT). Imported by baseline, model, grade.
- engine/stats.py — MLB Stats API game-log fetcher. get_pitcher_starts() is
  lru_cached(maxsize=64) so all 4 non-strikeout prop builders share one API call
  per pitcher per run. No Statcast, no DB code.
- engine/baseline.py — weighted rolling strikeout projection (Statcast/pybaseball)
  + 4 new builders via stats.py: hits_allowed, walks, earned_runs, outs_recorded.
  All use last-5-starts 2x weighting. No DB writes.
- engine/model.py — XGBoost layer. train() reads player_game_logs, returns fitted
  model or None. predict() accepts the model object; no pkl file used.
- engine/grade.py — grades yesterday's projections against final box scores.
  Extracts all 5 actual values per pitcher (strikeouts, hits_allowed, walks,
  earned_runs, outs_recorded) from the box score. Returns rows for
  player_game_logs (no DB writes).
- engine/calibrate.py — compute_confidences() reads player_game_logs and emits
  a 0.0-1.0 hit-rate score per pitcher per prop type. Covers all 5 prop types
  once player_game_logs accumulates 5+ graded starts per pitcher. No DB writes.
- engine/main.py — orchestrates: grade yesterday -> fetch -> upsert -> baseline
  (5 props) -> XGBoost blend -> upsert -> calibrate confidences. stdout only.
- web/ — Next.js 14 (App Router) + Tailwind. page.tsx (server) fetches all 5
  prop types in one Supabase query, passes to PropBoard.tsx (client) which handles
  tab selection. force-dynamic. ZERO math in frontend. Build passes.
- db/policies.sql — public SELECT (anon) RLS on projections + players + games.
- db/schema.sql — player_game_logs now includes actual_hits_allowed,
  actual_walks, actual_earned_runs, actual_outs_recorded columns.
  Migration SQL (run once in Supabase SQL editor):
    alter table player_game_logs
      add column if not exists actual_hits_allowed  integer,
      add column if not exists actual_walks         integer,
      add column if not exists actual_earned_runs   integer,
      add column if not exists actual_outs_recorded integer;
Verified: 15 games, 30 players, 149 projection rows per run (29 strikeouts +
30 each of hits_allowed, walks, earned_runs, outs_recorded).

Known follow-ups:
- statsapi.lookup_player is fuzzy and can resolve the wrong MLBAM id. Harden
  pitcher id resolution before trusting projections downstream.
- Probable-pitcher bio fields (team/bats/throws) come back None from
  lookup_player; enrich when the model needs them.
- First pybaseball run is slow (cold cache, ~30 per-pitcher calls). Fine for a
  scheduled job; revisit if it bottlenecks.
- Run the player_game_logs migration SQL in Supabase before the new grading
  columns will be written (one-time manual step).

Next: step 11 — betting line ingestion via Parlay API key.

## Keeping this file current
At the end of each session, update the "Current status" section and record any
new decisions or conventions, so the next session stays in sync.