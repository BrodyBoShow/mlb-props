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
Steps 1-14 complete. Working pipeline + frontend:
- engine/fetch.py — pure MLB Stats API layer. fetch_games(), fetch_starters()
  (probable pitchers linked to game_id, lru_cached), fetch_probable_pitchers()
  (players-table rows), fetch_lineups() (step 14 — confirmed batting orders via
  boxscore battingOrder; returns [] until lineups post ~60-90 min pre-game).
  No DB code.
- engine/db.py — the ONLY writer. upsert_players/games/projections/game_logs,
  update_confidences, idempotent on each table's PK. Uses SUPABASE_KEY
  (service_role) to bypass RLS; falls back to SUPABASE_ANON_KEY.
- engine/constants.py — shared constants (STRIKEOUT/HIT/WALK_EVENTS,
  LOOKBACK_DAYS, RECENT_*, LEAGUE_AVG_K_PCT). Imported by baseline, model, grade.
- engine/stats.py — MLB Stats API game-log fetcher. get_pitcher_starts() is
  lru_cached(maxsize=64) so all 4 non-strikeout prop builders share one API call
  per pitcher per run. get_hitter_games() (step 14) is lru_cached(maxsize=512)
  so all 5 hitter builders share one API call per batter. No Statcast, no DB code.
- engine/baseline.py — weighted rolling strikeout projection (Statcast/pybaseball)
  + 4 pitcher builders via stats.py: hits_allowed, walks, earned_runs,
  outs_recorded. Step 14 adds 5 hitter builders via stats.get_hitter_games():
  hitter_hits, hitter_total_bases, hitter_rbis, hitter_runs, hitter_home_runs.
  All use last-5-games 2x weighting. No DB writes.
- engine/model.py — XGBoost layer. train() reads player_game_logs, returns fitted
  model or None. predict() accepts the model object; no pkl file used.
- engine/grade.py — grades yesterday's projections against final box scores.
  grade_yesterday() extracts the 5 pitcher actuals; grade_hitters_yesterday()
  (step 14) extracts the 5 hitter actuals (hits, total_bases, rbis, runs,
  home_runs) from each player's batting line. Both tag rows with player_type
  and return rows for player_game_logs (no DB writes).
- engine/calibrate.py — compute_confidences() reads player_game_logs and emits
  a 0.0-1.0 hit-rate score per player per prop type. Covers all 10 prop types
  (5 pitcher + 5 hitter) once player_game_logs accumulates 5+ graded games per
  player per prop. No DB writes.
- engine/lines.py — ParlayAPI betting-line fetch layer (step 11). Pure fetch,
  no DB code. fetch_prop_lines(name_to_id, game_date) (renamed in step 14 from
  fetch_pitcher_lines) pulls all 10 pitcher + hitter prop markets in ONE call
  across 7 books (pinnacle + DK/FD + PrizePicks/Underdog/Betr/Sleeper), keeps
  only projected players (starters + lineup hitters), maps market_key ->
  prop_type, shapes rows for the lines table. Defensive: the parlay_api import
  is guarded and the API call is wrapped in try/except, so a missing package
  or failed request prints and returns [] — projections are never affected.
- engine/edge.py — edge calculation (step 12). Pure math, no DB/API. de-vigs
  the market into a fair over probability (Pinnacle preferred; else a consensus
  of draftkings/fanduel/caesars) and compares it to the model's over prob.
  model_over_prob uses a normal approximation around the projection
  (std = projection * 0.35) until calibrated confidence scores accumulate.
  Projections with no matching/de-viggable line are skipped — sparse coverage
  degrades gracefully to fewer edge rows, never an error.
- engine/main.py — orchestrates: grade yesterday (pitchers + hitters) -> fetch
  -> upsert -> pitcher baseline (5 props) -> XGBoost blend -> upsert -> fetch
  lineups -> hitter baseline (5 props, skipped if no confirmed lineups) ->
  upsert -> fetch lines -> upsert -> compute edges -> upsert -> calibrate
  confidences. stdout only.
- web/ — Next.js 14 (App Router) + Tailwind. page.tsx (server) fetches all 10
  prop types in one Supabase query + edges, passes to PropBoard.tsx (client)
  which handles tab selection (5 pitcher tabs + 5 hitter tabs) and edge display.
  force-dynamic. ZERO math in frontend. Build passes.
- db/policies.sql — public SELECT (anon) RLS on projections + players + games.
- db/schema.sql — player_game_logs now includes actual_hits_allowed,
  actual_walks, actual_earned_runs, actual_outs_recorded columns.
  Migration SQL (run once in Supabase SQL editor):
    alter table player_game_logs
      add column if not exists actual_hits_allowed  integer,
      add column if not exists actual_walks         integer,
      add column if not exists actual_earned_runs   integer,
      add column if not exists actual_outs_recorded integer;
- db/schema.sql — new `lines` table (step 11): one row per pitcher + prop +
  bookmaker + day. Migration SQL (run once in Supabase SQL editor):
    create table if not exists lines (
        id          serial primary key,
        player_id   integer not null references players(player_id),
        player_name text not null,
        prop_type   text not null,
        bookmaker   text not null,
        line        numeric not null,
        over_price  integer,
        under_price integer,
        game_date   date not null,
        fetched_at  timestamptz default now(),
        unique (player_id, prop_type, bookmaker, game_date)
    );
    alter table lines enable row level security;
    create policy "public read lines" on lines for select to anon using (true);
- db/schema.sql — new `edges` table (step 12): one row per pitcher + prop +
  day, keyed on the baseline bookmaker. Migration SQL (run once in Supabase
  SQL editor):
    create table if not exists edges (
        id              serial primary key,
        player_id       integer not null references players(player_id),
        prop_type       text not null,
        game_date       date not null,
        bookmaker       text not null,
        line            numeric not null,
        fair_over_prob  numeric,
        model_proj      numeric,
        model_over_prob numeric,
        edge            numeric,
        over_price      integer,
        under_price     integer,
        updated_at      timestamptz default now(),
        unique (player_id, prop_type, game_date, bookmaker)
    );
    alter table edges enable row level security;
    create policy "public read edges" on edges for select to anon using (true);
- db/schema.sql — step 14 adds player_type to players + player_game_logs and 5
  hitter actual columns. Migration SQL (run once in Supabase SQL editor):
    alter table players
      add column if not exists player_type text default 'pitcher';
    alter table player_game_logs
      add column if not exists player_type        text default 'pitcher',
      add column if not exists actual_hits        integer,
      add column if not exists actual_total_bases integer,
      add column if not exists actual_rbis        integer,
      add column if not exists actual_runs        integer,
      add column if not exists actual_home_runs   integer;
Verified: 15 games, 30 players, 149 pitcher projection rows per run (29
strikeouts + 30 each of hits_allowed, walks, earned_runs, outs_recorded).
Hitter props add 5 more types once lineups post (1 PM cron).

Known follow-ups:
- statsapi.lookup_player is fuzzy and can resolve the wrong MLBAM id. Harden
  pitcher id resolution before trusting projections downstream.
- Probable-pitcher bio fields (team/bats/throws) come back None from
  lookup_player; enrich when the model needs them.
- First pybaseball run is slow (cold cache, ~30 per-pitcher calls). Fine for a
  scheduled job; revisit if it bottlenecks.
- Run the player_game_logs migration SQL in Supabase before the new grading
  columns will be written (one-time manual step).
- Run the `lines` table migration SQL in Supabase before line ingestion will
  persist (one-time manual step). The parlay_api import in lines.py is guarded;
  CI installs the real parlay-api package from requirements.txt.
- Run the `edges` table migration SQL in Supabase before edge rows will persist
  (one-time manual step).
- Edge coverage is sparse at runtime: lines exist only for active pre-game
  markets, so a morning run gets full coverage while a late run may have few
  two-sided lines left. Edges use a normal approximation for model_over_prob
  until calibrated confidence scores accumulate; revisit once they exist.
- Run the step-14 player_type + hitter-actuals migration SQL in Supabase before
  hitter projections/grading will persist (one-time manual step).
- Lineup timing (step 14): batting lineups post ~60-90 min before first pitch,
  so the 8 AM ET cron runs BEFORE lineups and skips hitter props cleanly; the
  1 PM ET cron runs after lineups and captures them. fetch_lineups() returns []
  when no lineup is posted, which is the skip signal in main.py.

Hardening Chunk A complete (commits 2f92cdb, 4d919b7):
- fetch.py: pitcher lookup now filters candidates to primaryPosition in
  (P, SP, RP) before exact-match/sole-candidate logic.
- model.py: TEAM_NAME_MAP added (all 30 teams full-name -> FanGraphs abbr);
  6 abbreviations corrected (CWS, KC, SD, SF, TB, WSH); _opp_k_rate now
  lru_cached with WARNING on mismatch instead of silent league-avg fallback.
- main.py: sanity WARNINGs when pitcher projections < 20 or hitter < 100.

Hardening Chunk B complete (this session):
- model.py: FanGraphs abbreviation fixes (CHW->CWS, KCR->KC, SDP->SD,
  SFG->SF, TBR->TB, WSN->WSH) — these 6 were wrong and would silently
  fall back to league average on every graded game.
- requirements.txt: all 8 packages pinned to installed versions
  (MLB-StatsAPI==1.9.0, pybaseball==2.2.7, supabase==2.30.1,
  python-dotenv==1.2.2, xgboost==3.2.0, joblib==1.5.3, parlay-api==0.1.0,
  scipy==1.17.1). Prevents silent projection-math changes from dep updates.
- fetch.py: top-level statsapi.schedule() call wrapped in try/except for
  fetch_games(), _fetch_starters_today(), and fetch_lineups(). A statsapi
  outage now degrades gracefully (returns []/()) instead of crashing.
- main.py: run header (=== pipeline run YYYY-MM-DD HH:MM UTC ===) at start
  of main() and run summary (pitcher count + lineup players) after Done.

Next: Chunk C — presentation polish.

## Keeping this file current
At the end of each session, update the "Current status" section and record any
new decisions or conventions, so the next session stays in sync.