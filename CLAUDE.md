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
- engine/stats.py — MLB Stats API game-log fetcher AND team K-rate helpers
  (Chunk C refactor: TEAM_NAME_MAP, _mlb_name_to_abbr, _team_k_pcts, _opp_k_rate
  moved here from model.py — they are data-fetch utilities, not model logic).
  get_pitcher_starts() lru_cached(maxsize=64); get_hitter_games() lru_cached
  (maxsize=512); _opp_k_rate lru_cached(maxsize=128). No Statcast, no DB code.
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

Hardening Chunk C complete (this session — step 15):
- layout.tsx: title updated to "MLB Props", description updated.
- page.tsx: h1 "MLB Pitcher Props" -> "MLB Props"; subtitle "Probable starters"
  -> "Pitchers & hitters"; "Last updated: <ET timestamp>" added below subtitle,
  drawn from projections.updated_at. formatUpdatedAt() renders in America/New_York.
- stats.py: TEAM_NAME_MAP, _mlb_name_to_abbr, _team_k_pcts, _opp_k_rate moved
  here from model.py. model.py now imports them from stats. grade.py updated to
  import stats._opp_k_rate instead of model._opp_k_rate. Pure refactor, no
  behavior change.
- requirements.txt: all 8 packages pinned (Chunk B).

Step 15 (hardening A+B+C) is complete. The model improves automatically over
the season as player_game_logs accumulates graded data: XGBoost activates once
player_game_logs has >= 50 pitcher rows; calibration activates per-pitcher once
5+ graded starts exist. No code changes needed for either to kick in.

Future-preview starter-ids false warning (this session):
- Every cron run printed:
    "WARNING: games table missing starter_id columns -- upserted without
     them. Run db/migrations/add_starter_ids.sql"
  even though both columns existed in the live DB (confirmed via
  information_schema). Two stacked bugs:
- BUG 1 (engine/main.py): _run_future_previews() upserted games BEFORE
  players. games.home_starter_id / away_starter_id are FK columns
  pointing at players(player_id), so the games upsert violated the FK
  constraint when the probable pitcher for a future date hadn't been
  upserted yet. Reordered to match _setup_games_and_pitchers (players
  first, then games).
- BUG 2 (engine/db.py): upsert_games's defensive "column missing"
  fallback was triggered by `any(col in msg for col in _STARTER_COLS)`
  — too broad. FK-violation messages also mention the column name, so
  the FK error was being silently swallowed, the starter columns
  stripped, and the misleading warning printed. Tightened the check
  to require PGRST204 / "Could not find" in the message in addition
  to the starter-column name. FK errors now re-raise correctly (which
  is also no longer reachable thanks to fix 1).
- Verified: pipeline run produced clean "future preview ..." lines
  with no WARNING. 12/12 sampled future game rows have at least one
  starter id populated; the few Nones are genuine (probables not yet
  announced for those teams).

Added 8 PM ET cron — West Coast lineup window (this session):
- Follow-up to the hitter-coverage fix. The cron schedule had a 7-hour
  gap between the 2 PM and 9 PM ET runs. West Coast lineups post ~8 PM
  ET, so a late game was posted-but-unbuilt from ~8 PM until the 9 PM
  cron caught it (~1h window). Added a 7th cron at 0 0 * * * (8 PM ET)
  so the _run_hitter_pipeline fill-in builds those late-posting games
  within minutes of the lineup posting instead of up to an hour later.
- Nearly free: it's a lines-only refresh that only builds the 1-2 newly
  posted games via the fill-in path. .github/workflows/refresh.yml only;
  no engine/frontend change. YAML validated (7 crons).

Hitter fantasy-score coverage: missing games + zero proj (this session):
- Report (live DB, 2026-06-01): 9 games on slate, only 7 had
  hitter_fantasy_score. hitter_hits AND hitter_fantasy_score had the
  SAME 107 rows / same 7 games — so NOT a "hits populated but fantasy
  isn't" case; both hitter prop types were missing the same 2 games
  (Colorado@LAA 824027, LAD@ARI 825078). 1 zero-proj row (Jimmy Crooks).
- Cause A (missing games): the 2 West Coast games' lineups post ~8 PM ET
  but no cron runs between the 2 PM and 9 PM ET ticks; once hitter_hits
  crosses the 100-row skip threshold, intermediate runs skip the whole
  hitter pipeline and the late games never get filled. fetch_lineups()
  now returns all 9 games (162 players incl. 18 each for the 2 missing),
  confirming the lineups exist — they just weren't built.
- Cause B (zero proj): build_hitter_fantasy_score_projections weighted-
  averages per-game FP. Jimmy Crooks has 1 game (debut, 0 FP) -> avg 0.
  The builder emitted 0 — a sentinel, not a projection. (The screenshot's
  other "0 FP" are LIVE in-game actuals next to real "proj X.X", not
  zero projections.)
- Fix A — engine/main.py: extracted the 6-builder loop into
  _build_and_upsert_hitters(players). The bulk-skip path now, before
  returning, computes lineup players NOT in the existing hitter_hits id
  set and runs a TARGETED FILL-IN for just those (covers late-posting
  games even on a skip run). Returns [] so _run_lines_and_edges re-fetches
  the COMPLETE set from the DB. (This run actually hit the full-rebuild
  branch because the lineup grew enough to drop overlap below 80%; both
  paths now cover all 9 games.)
- Fix B — engine/baseline.py + constants.py: LEAGUE_AVG_HITTER_FP = 3.5.
  build_hitter_fantasy_score_projections no longer skips empty-history
  players or emits 0 — it floors to the league average when there's no
  history OR the rolling avg is <= 0. Players with real history keep
  their genuine projection (verified: Julio Rodriguez stayed 9.6).
  Scoped to fantasy_score per the report (the reported prop).
- Verified after fix: 9/9 games have hitter_fantasy_score (was 7);
  0 zero-proj rows (Crooks/Smith/Arroyo now 3.5 via floor); Julio
  Rodriguez unchanged at 9.6. Engine-only (baseline, constants, main);
  model untouched; FEATURE_COLS still 11.

"Last updated" now in the viewer's local timezone (this session):
- Bug report: "updated 2h ago" while the absolute said 5:39 PM EDT and
  the user thought it was ~2 min old. Diagnosis (raw DB checked): the
  relative counter was CORRECT. lines.fetched_at = 2026-06-01T21:39:51Z
  = 5:39 PM EDT = 2:39 PM PDT. The user is on Pacific (taskbar 4:41 PM),
  so it genuinely was ~2h old — but the absolute was HARDCODED to ET
  ("5:39 PM EDT"), which didn't match their 4:41 PM wall clock, so they
  misread it as recent. The microsecond ISO parses fine in V8 (verified
  delta 0) — not a parse bug; purely a display-timezone mismatch.
- Fix: the whole "Last updated" line is now client-rendered in the
  VIEWER's local timezone (toLocaleString with no explicit timeZone,
  timeZoneName:"short" so it's labeled, e.g. "PDT"). web/app/
  LiveUpdated.tsx now owns the full line (absolute local time + relative
  counter), both recomputed every 30s; returns a "Last updated…"
  placeholder on SSR/first paint to avoid a hydration mismatch on the
  clock-dependent strings. Removed the server-side formatUpdatedAt
  (hardcoded America/New_York) from page.tsx.
- Now consistent in every zone: Pacific viewer sees "2:39 PM PDT ·
  updated 2h ago"; Eastern "5:39 PM EDT · just now"; Central "4:39 PM
  CDT · updated 1m ago" — absolute always matches the viewer's clock +
  the relative counter. Still honest (same real updatedAt instant,
  localized). Frontend-only (LiveUpdated.tsx, page.tsx); tsc clean;
  build passes.

Live-feel: auto-refresh + relative timestamp (this session):
- Goal: new cron data appears without a manual reload, and "Last
  updated" feels alive — without ever overstating freshness.
- Step 0: "Last updated" is server-rendered in the page header from
  updatedAt = MAX(projections.updated_at, lines.fetched_at), formatted
  in America/New_York. Existing live polls (useLiveGameStatus /
  useLiveBoxScores) use useEffect + setInterval(60s). Page is
  force-dynamic.
- PART A — web/app/LiveUpdated.tsx (client): appends a relative
  ticking counter next to the UNCHANGED absolute timestamp. "just now"
  (<60s), "updated Nm ago", "updated Nh ago", "updated Nd ago".
  Recomputes every 30s from the real updatedAt — only counts UP from
  the actual value, never to "now". Pulsing emerald dot (same
  animate-ping as the LIVE chip). Returns null on SSR + first paint
  (label starts null, filled in useEffect) so there's no hydration
  mismatch on the time-dependent string.
- PART B — web/app/AutoRefresh.tsx (client, renders null): calls
  router.refresh() every 150s (2.5 min, slower than the 60s in-game
  polls). Soft-refresh re-runs the force-dynamic server component
  (getSlate re-fetches projections/lines/edges) while PRESERVING client
  state — the selected prop tab (PropBoard useState) and the live
  box-score / game-status hooks persist, and the URL is untouched so
  ?date= persists. Paused while document.visibilityState==='hidden';
  one catch-up router.refresh() on regaining focus. When a new run has
  landed, updatedAt advances and the relative counter resets to "just
  now"; otherwise the displayed time is unchanged.
- Honesty guardrail: the absolute timestamp always reflects the real
  max(updated_at, fetched_at); the relative counter only counts up from
  it. Nothing fabricates a fresher time.
- Verified: relativeLabel correct across 10s..3d ranges; tsc clean;
  npm run build passes. Frontend-only (page.tsx + 2 new components); no
  engine touched.

Sharp badge — edge-derived direction + relabel (this session):
- Bug (visible in prod): the badge fired on ~Even rows (Alcantara SO
  SHARP 4/4 next to ~Even) and its direction could contradict the edge
  arrow (Avila: proj 3.4 < line 3.5 = under by the old proj-vs-line
  logic, but edge arrow was +0.16 over). Root cause: the badge derived
  lean from raw proj-vs-line while the edge derives it from de-vigged
  probability — they disagree in magnitude (a 0.1 proj gap is a "lean"
  to the badge but ~Even to the edge) and sometimes direction.
- Step 0: EdgeDetail derives direction from the signed edge
  (model_over_prob - fair_over_prob, on p.edge): >EDGE_THRESHOLD ▲over,
  <-EDGE_THRESHOLD ▼under, else ~Even. EDGE_THRESHOLD=0.1. The badge now
  REUSES that exact value + threshold.
- computeSharp(playerId, prop, projection, edge): direction + ~Even gate
  now come from the EDGE (authoritative). No projection / no edge /
  |edge|<=EDGE_THRESHOLD → no badge. agree = real books (gated to
  SHARP_MIN_LINE) that CORROBORATE the edge lean (edge over → proj>book
  line; edge under → proj<book line). total = qualifying real books.
  Badge only when agree>=2; UI tiers full (>=3 && ===total) vs partial.
  The badge now agrees with the arrow BY CONSTRUCTION — can't point
  opposite, never on ~Even. Both call sites pass the signed edge
  (prop board e?.edge; featured e.edge).
- Relabel: "SHARP N/N" → direction-bearing "N/N OVER" / "N/N UNDER"
  (full keeps ◆ + emerald; partial muted slate). Tooltip: "Model is on
  the <dir> side of all N / N of M sportsbook lines (<book names>)".
  SharpAgreement.direction is now edge-derived (shape unchanged).
- Verified vs raw DB (2026-06-01): Sandy Alcantara SO edge 0.04 →
  NO badge; Luinder Avila SO edge +0.16 over but no real book
  corroborates over → NO badge (never an under badge contradicting the
  over arrow); Griffin Jax SO edge -0.11 under, all five 4.5 lines →
  5/5 UNDER (full, emerald); Jacob deGrom SO -0.34, three 6.5 → 3/3
  UNDER (full); Shane Drohan SO -0.11, two 3.5 → 2/2 UNDER (partial).
  Every rendered badge's direction matches its edge sign. Frontend-only
  (page.tsx, types.ts, SharpBadge.tsx); no engine; FEATURE_COLS still
  11; tsc clean; npm run build passes.

Sharp badge — dedicated SHARP_MIN_LINE floor (this session):
- Residual gap from the MIN_LINE work: the badge renders on ALL pitcher
  prop tabs (strikeouts/hits_allowed/walks/earned_runs/outs_recorded/
  pitcher_fantasy_score) but the shared MIN_LINE only floors strikeouts/
  hits_allowed/outs_recorded + the fantasy props. walks + earned_runs had
  NO floor, so their badges still counted sub-threshold alt lines.
- Fix WITHOUT touching MIN_LINE (which drives /results Betting-Edge +
  Featured Plays and must stay as-is): new SHARP_MIN_LINE in
  web/lib/constants.ts covering every pitcher prop the badge renders on —
  strikeouts 3.5, hits_allowed 3.5, outs_recorded 10.5, walks 1.5,
  earned_runs 1.5, pitcher_fantasy_score 6.0 (no-op — no real two-sided
  books post fantasy lines, included for completeness). Note: the badge's
  hits_allowed floor is the historical 3.5, intentionally stricter than
  MIN_LINE's 2.5.
- computeSharp now gates on SHARP_MIN_LINE (was MIN_LINE). MIN_LINE
  import retained for the Featured Plays qualifier — unchanged.
- Verified vs raw DB (2026-06-01):
  * Unchanged: Griffin Jax SO 5/5 under (books 4.5 >= 3.5), Luinder
    Avila SO 2/2 under (books 3.5 >= 3.5).
  * Gap closed: Lyon Richardson earned_runs proj 1.0, books
    {caesars 0.5, pinnacle 0.5} — BEFORE (ungated) showed a misleading
    SHARP 2/2 over built on two 0.5 alts; AFTER (1.5 floor) both lines
    drop -> NO badge.
- /results + Featured Plays unchanged (MIN_LINE untouched). Frontend-only
  (page.tsx, constants.ts); no engine; FEATURE_COLS still 11; tsc clean;
  npm run build passes.

Sharp badge follow-ups — MIN_LINE gate + split verify (this session):
- MIN_LINE hoisted to web/lib/constants.ts as the SINGLE source of
  truth (was duplicated: FEATURED_MIN_LINE in page.tsx + a local
  MIN_LINE in results/page.tsx with identical values for shared props).
  Both pages now import it; the local copies are gone. The canonical
  map is the 5-prop superset (strikeouts 3.5, hits_allowed 2.5,
  outs_recorded 10.5, pitcher_fantasy_score 6.0, hitter_fantasy_score
  4.0). Featured-play values for its 3 props are identical, so behavior
  is unchanged there.
- computeSharp now applies the MIN_LINE gate: a real book's line below
  the prop's main-market floor is an alternate and is dropped BEFORE
  counting, so an alt-only book no longer contributes to agree/total.
  Props without a floor (walks, earned_runs — Model-Tracker props with
  no betting-line evaluation in the codebase) are counted as-is.
- Re-verified under the gate (frontend logic mirrored vs raw DB):
  * Griffin Jax SO 2026-06-01: proj 3.9 vs five 4.5 lines (all >= 3.5
    floor) -> still SHARP 5/5 under (full). UNCHANGED.
  * Luinder Avila SO: proj 3.4 vs caesars+pinnacle 3.5 (at floor) ->
    still SHARP 2/2 under (partial). UNCHANGED.
- LIVE split case (previously only inspected): today's 2026-06-01
  slate has NO post-gate split (qualifying real books cluster tightly).
  On the most recent prior slate (2026-05-31) there ARE genuine ones,
  e.g. Yoshinobu Yamamoto strikeouts proj 6.7 — DraftKings 8.5 (model
  under) + Pinnacle 6.5 (model over), a true straddle (6.5 < 6.7 < 8.5)
  -> even split -> correctly NO badge. Confirmed against raw per-book
  lines; not fabricated.
- Frontend-only (page.tsx, results/page.tsx, constants.ts); no engine
  touched; FEATURE_COLS still 11; tsc clean; npm run build passes.

Sharp-money agreement badge (feature 5) (this session):
- Report from step 0: getSlate fetches edges (ONE baseline book per prop:
  pinnacle or "consensus") + projections + lines.fetched_at TIMESTAMP —
  NOT per-book line rows. So a new bounded fetch was needed. The `lines`
  table DOES store per-book rows keyed (player_id, prop_type, bookmaker,
  game_date), so no engine/migration change — frontend-only.
- Badge = how many REAL two-sided books (pinnacle/draftkings/fanduel/
  bet365/caesars) the model leans the SAME way against. Distinct from the
  edge number (edge = gap size; sharp = multi-book agreement that the gap
  exists). DFS apps excluded (flat single-number lines).
- web/lib/types.ts: SharpAgreement {agree, total, direction, books};
  Pitcher.sharpAgreement? + FeaturedPlay.sharpAgreement?.
- web/lib/constants.ts: REAL_BOOKS (5-book two-sided subset of
  engine/lines.py BOOKMAKERS) + BOOK_DISPLAY label map. Sync comments.
- web/app/page.tsx getSlate(): ONE ISOLATED, paginated (fetchAllPages),
  failure-tolerant query for REAL_BOOKS lines on the slate date (~2.2k
  rows after the 1000-cap → 3 pages). sharpByKey indexes
  `${player_id}|${prop_type}` -> Map<book, line> (unique constraint
  means one line per book; keep-first defensively). computeSharp(pid,
  prop, proj): per-book lean (proj>line=over, proj<line=under,
  proj==line=push counts in total only); strict-majority direction
  (even split → undefined); returns {agree,total,direction,books} only
  when >= 2 books agree. Attached to every prop row + featured play.
- web/app/SharpBadge.tsx (new): tiers full (agree>=3 && agree===total →
  emerald ◆) vs partial (agree>=2 → muted slate); returns null below 2.
  Text "SHARP N/N"; tooltip lists the actual agreeing book display names
  + direction.
- web/app/PropBoard.tsx: badge inline next to the pitcher name, PITCHER
  prop tabs only (!isHitter). web/app/FeaturedPlays.tsx: badge on the
  Book attribution row (right-aligned).
- Cross-checked vs raw DB: Griffin Jax SO proj 3.9 vs five 4.5 lines →
  SHARP 5/5 under (full); Sandy Alcantara SO 3.4 vs four 3.5 → 4/4
  under; partial 2/2 cases confirmed; 27 single-real-book props →
  no badge; even-split → no badge. Frontend-only; FEATURE_COLS still 11;
  tsc clean; npm run build passes.
- Minor note: no MIN_LINE filter applied (spec scoped it to "real books
  that actually posted a line"). A rare alt-only case (e.g. two 0.5 K
  lines) can yield a thin "SHARP 2/2"; harmless + honest-literal. Books
  posting both a main and alt line are deduped by the unique constraint.

Opposing-lineup context line (feature 4, Option A) (this session):
- Report from step 1: NO current-slate table carried opponent context.
  projections/edges/games/lines all have zero opp columns (verified
  live). opp_k_rate was computed transiently in model.predict()'s
  feature vector and DISCARDED; player_game_logs.opp_k_rate is
  historical (grade-time). Per spec, stopped and reported; user chose
  Option A (persist opp_k_rate onto strikeouts projection rows).
- engine/model.py predict(): now carries feats["opp_k_rate"] (already
  computed by the feature builder, rounded 4dp) onto the returned
  strikeouts ProjectionRow. NOT recomputed. Strikeouts is the only
  prop the model runs, so it's the only prop that carries opp_k_rate
  — exactly where the context line shows.
- engine/main.py _blend(): model_map now maps key -> full model row
  (was -> projection float) so the blend preserves opp_k_rate onto the
  blended baseline row. Without this the value was silently dropped in
  the 60/40 blend.
- engine/schemas.py: ProjectionRow gains opp_k_rate: Optional[float].
- engine/db.py upsert_projections(): PGRST204-retry pattern added
  (_PROJECTION_OPTIONAL_COLS = opp_k_rate). Strips opp_k_rate + warns
  + retries when the column is missing, so the pipeline runs cleanly
  before the migration is applied.
- db/schema.sql + db/migrations/add_opp_k_rate.sql: ADD COLUMN IF NOT
  EXISTS opp_k_rate numeric on projections.
- web/lib/types.ts: OppContext {kRate, lhh, rhh} (lhh/rhh deferred,
  always null); Pitcher.oppContext?.
- web/app/page.tsx getSlate(): ISOLATED, failure-tolerant query for
  player_id+opp_k_rate on strikeouts rows. Kept OUT of the main
  projections select because PostgREST 400s on a missing column —
  this way the pre-migration window never breaks the board; the
  context line just doesn't render. Attached per pitcher by player_id.
- web/app/PropBoard.tsx: OppContextLine — "VS · Facing a X% K lineup",
  K% toned emerald >=24% (favorable for SO over), amber <=20% (tougher
  matchup, not red), else slate. Rendered on the Strikeouts tab ONLY.
  Returns null when kRate missing (never "Facing a null% lineup").
- Verified: model trains on exactly 11 features (opp_k_rate was
  already a feature — only the value is now saved). predict() returns
  18/18 strikeouts rows carrying opp_k_rate; cross-checked exactly vs
  stats._opp_k_rate (Detroit 0.2294, Tampa Bay 0.1869, Miami 0.2185).
  _blend preserves opp_k_rate (0.234) + correct projection (5.6).
  PGRST204 retry strips+warns+persists pre-migration. tsc clean;
  npm run build passes.

Pitcher recent-form spark dots (this session):
- Adds a quiet L5 dot row to pitcher cards showing the last ≤5 graded
  actuals for the active prop vs tonight's line (over=green, under=red,
  push=slate), oldest→newest.
- DATA NOTE (verified live): player_game_logs has NO prop_type column
  and the per-game `projection` column was dropped earlier, so the
  dots compare each graded ACTUAL against the current book LINE (the
  market benchmark), not a historical projection. All five main pitcher
  actual columns are 60/60 non-null on graded rows
  (actual_strikeouts / _hits_allowed / _outs_recorded / _walks /
  _earned_runs) — so spark rows appear on all FIVE of those prop tabs.
  Hitter + fantasy tabs get no spark row (no clean actual column in
  SPARK_ACTUAL_COL).
- web/lib/types.ts: FormDot = "over"|"under"|"push"; Pitcher gains
  recentForm?: FormDot[].
- web/app/page.tsx getSlate(): ONE paginated read (fetchAllPages) of
  every slate pitcher's recent graded games (newest-first), bucketed
  per player. sparkFor(playerId, prop, line) takes the ≤5 most recent
  non-null actuals for that prop's column, maps each vs the line, and
  reverses to oldest→newest. recentForm is computed PER (pitcher, prop)
  inside the byProp build, so each prop tab carries its own dots — no
  client recompute, no stale dots on tab switch. undefined when no
  line / no history / non-spark prop.
- web/app/PropBoard.tsx: RecentFormDots sub-component — "L5" label
  (text-[9px] slate-600) + a row of h-1.5 w-1.5 dots, with a title
  tooltip spelling the sequence ("Last 5 starts vs tonight's line:
  O-U-O-O-U"). Rendered under ConfidenceBar in the info column.
  Returns null when recentForm is empty.
- Cross-checked live: over/under/push computation confirmed against
  direct DB (10 K vs 4.5 -> over, 3 K vs 4.5 -> under, etc.). Today's
  starters have 0 graded history yet (early season) so no dots show
  on the current slate — the correct "no history -> no spark row"
  behavior; dots populate automatically as graded games accumulate.
- Verified: npm run build passes; tsc clean.

Featured Plays confidence indicator (this session):
- Adds a graded-history count to each Featured Plays card so users can
  weigh edges with thin history differently from edges with a track
  record. Honest framing — low/no-sample plays say "limited history",
  not a fake-confident number. Does NOT filter plays by count (edge
  threshold still governs qualification).
- SCHEMA NOTE (verified against live DB): player_game_logs has NO
  prop_type column. Actuals are stored as COLUMNS on one row per
  (player_id, game_id) — actual_strikeouts / actual_hits_allowed /
  actual_outs_recorded. So a "graded start" for a prop = a row where
  that prop's actual column is non-null. The spec's prop_type-keyed
  count was adapted accordingly (the spec flagged this possibility).
- web/lib/types.ts: FeaturedPlay gains gradedStarts: number.
- web/app/page.tsx getSlate(): after building the top-5 featuredPlays,
  ONE query fetches actual_strikeouts/hits_allowed/outs_recorded for
  the (≤5) featured player_ids (player_type=pitcher). Counts non-null
  per player+prop into gradedCounts keyed `${playerId}|${propType}`,
  then sets p.gradedStarts. Volume is tiny (≤5 players × a few dozen
  games) so no pagination needed.
- web/app/FeaturedPlays.tsx: confidenceLabel(n) tiers — >=8 strong
  (emerald), >=4 moderate (slate-400), else limited (slate-500; 0 ->
  "New — limited history", 1 -> "1 start tracked"). New ConfidenceLine
  sub-component renders a 6px dot + uppercase text-[10px] below the
  BOOK line, color-matched to tone.
- Cross-checked live: the 60 graded pitcher rows are 60 distinct
  pitchers with exactly 1 start each (early season). The actual
  featured pitchers for 2026-06-01 (Avila, Madden, Drohan, Freeland)
  have 0 graded rows yet, so today's cards honestly render
  "New — limited history" in muted slate — exactly the intended
  thin-sample honesty.
- Verified: npm run build passes; tsc clean.

Park-factor tag on game card headers (this session):
- web/lib/constants.ts: PARK_FACTORS_HITS table (mirror of
  engine/constants.py PARK_FACTORS_HITS, 31 entries) + getParkProfile
  helper returning {factor, label, direction}. Comment notes the
  two tables must stay in sync.
- Thresholds: factor >= 1.04 -> Hitter-friendly ↑, factor <= 0.96 ->
  Pitcher-friendly ↓, otherwise Neutral (no tag rendered).
- web/app/ParkTag.tsx: new client component. Returns null for
  neutral parks so the header stays uncluttered. Muted pill — emerald
  for hitter, sky for pitcher — text-[10px] uppercase tabular-nums
  with a tooltip carrying the exact factor.
- web/app/PropBoard.tsx GameHeader: split the existing "Away @ Home"
  matchup string on " @ " to get homeTeam, render <ParkTag /> in
  the same row as the matchup heading (right-aligned via flex).
- web/app/FutureSlate.tsx game header: g.home_team passed directly
  to <ParkTag />.
- Not added to FeaturedPlays cards per spec — those are per-player.
- Verified: tsc --noEmit clean; threshold spot-check confirms Coors
  tagged hitter-friendly, Petco/Seattle/Oracle/Tropicana tagged
  pitcher-friendly, Camden/Target/Comerica left untagged.

TypedDict data contracts in engine/schemas.py (this session):
- New file engine/schemas.py — SINGLE SOURCE OF TRUTH for every dict
  that flows between engine modules. Named `schemas` (not `types`)
  because `engine/types.py` would shadow Python's stdlib `types`
  module on sys.path and break third-party imports.
- 8 TypedDicts cover every cross-module dict shape:
  * PitcherGameLogRow — 44 fields written by grade.grade_yesterday
  * HitterGameLogRow  — 42 fields written by grade.grade_hitters_yesterday
  * ProjectionRow     — 5 fields written by baseline.* / model.predict
  * ProjectionContextRow — augmented READ-side projection shape
    returned by db.get_projections_for_date (the 5 write fields +
    home_team / away_team / home_away / start_time joined from games)
  * LineRow           — 8 fields written by lines.fetch_prop_lines
  * EdgeRow           — 11 fields written by edge.compute_edges
  * WeatherFields     — 5 fields returned by weather.get_game_weather
  * PitcherFeatureRow — 14 fields returned by model._build_pitcher_
    features_from_df (the 11 in FEATURE_COLS + 3 returned-but-unused)
- All TypedDicts use total=False so downstream code that does
  dict.get("optional_key") type-checks cleanly. Notes on each field
  state when the key is actually populated.
- Annotated producer / consumer signatures (annotations ONLY, no
  logic changes):
  * grade.grade_yesterday: -> list[PitcherGameLogRow]
  * grade.grade_hitters_yesterday: -> list[HitterGameLogRow]
  * weather._dome_weather / _empty_weather / get_game_weather:
    -> WeatherFields
  * lines.fetch_prop_lines: -> list[LineRow]
  * edge.compute_edges: (list[ProjectionContextRow], list[LineRow])
    -> list[EdgeRow]
  * baseline.build_*_projections (14 builders): -> list[ProjectionRow]
  * model._build_pitcher_features_from_df / _build_pitcher_features:
    -> PitcherFeatureRow | None
  * model.predict: -> tuple[list[ProjectionRow], pd.DataFrame]
  * db.get_projections_for_date: -> list[ProjectionContextRow]
  * db.upsert_game_logs / upsert_projections / upsert_lines /
    upsert_edges: typed `rows` parameters
- All schema imports in producers other than grade.py use
  TYPE_CHECKING guards so the import only fires under a type
  checker, never at runtime — pure annotations, zero runtime cost.
- Mismatch flagged during analysis: ProjectionRow (write shape, 5
  fields) and ProjectionContextRow (read shape, 9 fields) are
  legitimately different. db.get_projections_for_date augments
  every projection row with home_team / away_team / home_away /
  start_time. Made explicit with two TypedDicts — not a bug.
- Verified zero behavior change: model.FEATURE_COLS still 11,
  python engine/main.py runs cleanly in refresh mode (348 edges
  computed, 43.0s), all engine modules import without error.

Data-foundation sprint — log every meaningful feature (this session):
- Pure data-collection: 31 new nullable columns on player_game_logs.
  FEATURE_COLS stays at 11; model.train()/predict() behaviour is
  byte-identical. The model picks these up later in the season once
  enough rows accumulate to measure importance.
- db/migrations/add_data_foundation.sql: ALTER TABLE adds 31 columns
  grouped as rest/fatigue, recent form (hitter + pitcher), bullpen
  exposure scaffold, 30-day Statcast platoon, series/travel, weather.
- engine/constants.py: VENUE_COORDS (30 ballparks lat/lon),
  IS_DOME (8 dome/retractable venues), TEAM_NAME_TO_ID (30 MLB
  Stats API team ids — statsapi.schedule(team=...) refuses the
  name string and requires the int id).
- engine/weather.py: new module. OpenWeatherMap /forecast lookup
  keyed on the home team. Domes short-circuit to a neutral indoor
  baseline (72°F / 0 mph). Missing OPENWEATHER_API_KEY logs one
  reminder line and returns all-None — pipeline keeps running.
- engine/stats.py: new helpers
  * get_pitcher_rest_metrics: days_rest, starts_last_21d,
    innings_last_21d. STRICTLY-prior-to-game_date filter so the
    just-graded start isn't treated as the "last start".
  * get_team_schedule_density: games_last_3d / 7d via
    statsapi.schedule(team=TEAM_NAME_TO_ID[name]).
  * _compute_ops: OBP+SLG approximation from per-game components.
  * get_hitter_form: avg_last7 / avg_last15 / k_rate_last7 /
    ops_last15 / hr_last15. Strict-prior filter.
  * get_pitcher_form: k_rate_last3 / era_last3 / whip_last3.
    Strict-prior filter.
  * get_bullpen_metrics: stub returning all-None (clean role-split
    from statsapi is hard; columns scaffolded for future fill).
  * get_series_context: series_game_number (consecutive same-opp
    games ending on game_date) + is_getaway_day.
  * get_hitter_games extended to expose at_bats / strikeouts /
    plate_appearances for the form math.
- engine/grade.py: extensive new wiring.
  * Imports time + datetime/timezone + weather.
  * _pitcher_platoon_30d helper: ONE Statcast call per pitcher,
    computes k_vs_lhh_30d, k_vs_rhh_30d, whiff_pct_30d, csw_pct_30d.
    0.5s sleep after each (polite to Savant). 15-20 calls / grading
    run, ~10s extra on a typical slate.
  * _is_day_game: < 5 PM ET heuristic from games.start_time.
  * _parse_game_time: ISO -> UTC datetime, used to ask OWM for the
    right 3-hour forecast bucket.
  * grade_yesterday: every pitcher row now writes the full set of
    20+ new fields (rest, form, platoon-30d, series, day-game,
    home-team, weather).
  * grade_hitters_yesterday: every hitter row writes 18+ new fields
    (form, team density, hitter-specific game count, bullpen
    scaffold, series, weather).
  * [data-foundation] sample log line at the end of each grader so
    each cron's stdout shows the new features landing.
- engine/db.py:
  * get_projections_for_date now also returns games.start_time so
    grade.py can resolve the is_day_game flag and the weather time
    bucket without a second DB call.
  * _CONTEXT_COLS extended to include all 31 new columns. The
    existing PGRST204 retry already strips by membership in this
    tuple, so the pipeline runs cleanly both before and after
    add_data_foundation.sql is applied.
- db/schema.sql: 31 new column definitions appended to
  player_game_logs alongside the prior context columns.
- Verified end-to-end:
  * Sample pitcher row has real values: days_rest=5 (5-day rotation),
    starts_last_21d=3, innings_last_21d=14.7, k_vs_lhh_30d=0.261,
    k_vs_rhh_30d=0.207, whiff_pct=0.19, csw_pct=0.252,
    series_game_number=3, is_getaway_day=True.
  * Sample hitter row: avg_last7=0.32, avg_last15=0.25,
    k_rate_last7=0.276, ops_last15=0.762, hr_last15=3,
    games_last_7d=8 (doubleheader showing up).
  * 32/32 graded pitchers have non-null values for every non-weather
    feature; 31/32 for the platoon splits (one had < 20 PAs vs side).
  * Weather columns: temperature_f, wind_speed_mph, precipitation_pct
    populate for the 8 dome rows (neutral baseline); the other 24
    log NULL until OPENWEATHER_API_KEY is added — pipeline never
    crashes on the missing key.
  * model.FEATURE_COLS still has exactly 11 entries. train()
    behaviour unchanged.
  * PGRST204 retry path tested: upserting one of the new rows before
    the migration is applied strips the new columns and persists the
    actuals; updated WARNING message references both
    add_context_features.sql and add_data_foundation.sql.

Featured Plays section (this session):
- web/lib/types.ts: new FeaturedPlay type (player + matchup + proj +
  line + signed-positive edge + lean direction + book + ids).
- web/app/FeaturedPlays.tsx: new client component. Renders a header +
  responsive grid of FeaturedPlayCard tiles (1 col mobile, 2 cols sm,
  3 cols lg). Returns null when plays.length < 3 — "nothing" is better
  than "marginal" at the top of the page. Card layout: player name +
  matchup at top, prop label upper-right, divider, then Proj/Line on
  one row and lean arrow + Edge on the next. Lean arrow ▲ OVER in
  emerald, ▼ UNDER in red, edge value always emerald (we abs-value
  the edge at build time so both lean directions surface symmetrically).
- web/app/page.tsx: built up-front constants for the filter
  (FEATURED_BOOKS, FEATURED_PROPS, FEATURED_MIN_EDGE, FEATURED_MIN_LEAN,
  FEATURED_MIN_LINE) with comments explaining each exclusion. After
  building byProp, indexes projections by (player_id, prop_type) and
  filters edgeData through:
  * book ∈ {pinnacle, draftkings, fanduel, bet365, caesars}
    (DFS apps don't post symmetric markets → no de-vig)
  * prop ∈ {strikeouts, hits_allowed, outs_recorded}
    (walks/earned_runs too thin; hitter props lean-biased; fantasy
    PrizePicks-only)
  * |edge| >= 0.12 (above the 0.10 display threshold)
  * line >= per-prop MIN_LINE (3.5 / 2.5 / 10.5)
  * |projection - line| >= 0.3 (meaningful lean)
  Sorted by abs(edge) desc, sliced to top 5. SlateResult and
  emptyResult plumbed for featuredPlays through both return paths
  (data and future-preview).
- web/app/PropBoard.tsx: accepts featuredPlays prop and renders
  <FeaturedPlays> between DateNav and the prop selector tabs. Prop is
  defaulted to [] so the FutureSlate path (which never sets it) keeps
  type-checking.
- Verified: 20 qualifying plays for the current 2026-06-01 slate;
  top 5 surface with real names (Luinder Avila, Ty Madden, Jacob
  deGrom, Kyle Freeland, ...) and edges from 0.36 to 0.55 against
  Pinnacle de-vigged baselines. tsc --noEmit clean.

Pitcher edges fix — three stacked bugs (this session):
- USER REPORT: home page fetched 184 edges (per Vercel diag) but no
  edge arrows showed on any pitcher card. Frontend JOIN logic was the
  suspect; turned out to be three stacked engine-side bugs.
- BUG 1 (engine/db.py: get_lines_for_date 1000-row cap).
  Supabase / PostgREST silently caps every response at 1000 rows.
  A full slate produces ~3k lines; the first 1000 sort as all-hitter
  rows (insertion order, hitters projected later in the cron). All
  pitcher lines were silently truncated out of the slice that
  edge.compute_edges received, so zero pitcher edges were ever
  computed even though the lines existed in the DB. Fixed with the
  same .range() paginator used in get_projections_for_date.
- BUG 2 (timezone disagreement at the 9 PM ET / 1 AM UTC cron).
  At 1 AM UTC, Python's date.today() returns the UTC date but
  statsapi.schedule() defaults to ET's date — they disagree any time
  it's after 8 PM ET and before midnight UTC. The 9 PM ET cron was
  storing the WRONG slate's pitchers under "today's" projection_date
  (e.g. May 31's pitchers under projection_date='2026-06-01'). Lines
  for the real June 1 slate are stored correctly (ParlayAPI returns
  game_date alongside each row), so the two were disjoint sets of
  player_ids and the edge JOIN produced zero matches.
- Fix: new et_today() helper in constants.py (zoneinfo America/
  New_York). Replaced every date.today() in engine/main.py with it.
  Pipeline now uses ET-anchored "today" everywhere it talks to MLB
  data, eliminating the disagreement at the cron boundary.
- BUG 3 (stale-data skip bypass).
  The pitcher / hitter pipelines skipped expensive work when
  >= 20 / >= 100 projections existed for today. With Bug 2 above,
  those projections were the WRONG slate's — but the skip still
  fired, so the bad data persisted across every subsequent cron.
- Fix: new db.get_projection_player_ids_for_date(date, prop_type)
  helper. Both _run_pitcher_pipeline and _run_hitter_pipeline now
  compare the stored projection player_ids against the just-fetched
  probable-starters / lineup-players. They only skip when >= 80% of
  the current slate's player_ids overlap with what's stored;
  otherwise they emit a "stale, rebuilding" WARNING and rebuild.
- Verified end-to-end: pipeline run detected 0/17 starter overlap on
  pitcher projections for 2026-06-01 (the stale May 31 data),
  rebuilt them, kept the hitter projections (36/45 match), produced
  58 fresh edges. Post-run DB sample for 2026-06-01:
    strikeouts:13  hits_allowed:14  walks:5  earned_runs:14
    outs_recorded:12 + 184 hitter edges as before.

"Last updated" reflects refresh-only runs (this session):
- web/app/page.tsx: the timestamp shown under "Last updated" used to
  read only projections.updated_at, which is bumped solely by full-
  projection runs. Refresh-only crons (which the 6/day cron schedule
  fires 5 out of 6 times) only touch lines + edges, so the displayed
  time would freeze at the most recent full run — even when fresh
  lines had been ingested 10 minutes ago.
- Added a parallel lines.fetched_at query to the existing Promise.all
  block (now 7 parallel reads instead of 6) and compute updatedAt as
  MAX(projections.updated_at, lines.fetched_at). Both columns are
  stored as UTC ISO-8601 strings in Supabase so plain string
  comparison gives the correct max.
- Verified: tsc --noEmit clean.

Home-page default-date + stale-banner fix (this session):
- web/app/page.tsx: getSlate() now resolves the default date as the
  EARLIEST projection_date >= todayET (ascending), falling back to the
  absolute latest only when nothing for today-or-later exists. Replaces
  the previous "latest projection_date desc" which silently displayed
  yesterday's slate when the overnight cron hadn't yet produced today's
  rows AND any past projection still won the order.
- Two parallel date-resolution queries run up-front: one for today-or-
  future (also doubles as the hasCurrentProjections probe) and one for
  the absolute latest as fallback. dateOverride still wins outright so
  › / ‹ navigation always renders the exact URL date.
- SlateResult gains hasCurrentProjections: boolean. The stale banner
  now requires (displayedDate < todayET) AND (!hasCurrentProjections),
  so a user browsing a past date intentionally while today's data
  exists does not see the misleading "today's slate updates after 8 AM
  ET" message.
- Both return paths from getSlate (projection-data path and
  future-preview path) plumb hasCurrentProjections through.
- Verified: tsc --noEmit clean.

Matchup-context feature logging (this session):
- engine/constants.py: PARK_FACTORS_HITS (31 teams) + PARK_FACTORS_K
  (sparse — only off-neutral parks listed) + get_park_factor_hits /
  get_park_factor_k helpers. Indexed by full team name so the lookup
  is a single dict get with no normalization.
- engine/model.py: _build_pitcher_features_from_df() now also computes
  pitcher_k_vs_lhh / pitcher_k_vs_rhh (platoon splits over bulk_df;
  20-PA floor before falling back to LEAGUE_AVG_K_PCT), pitcher_fastball_pct
  / breaking / offspeed (Statcast pitch_type buckets), pitcher_avg_velo
  (mean fastball release_speed), pitcher_velo_trend (last-2 starts vs
  prior over the bulk window), and park_factor_k. home_team parameter
  added to the signature so park factor can be looked up; predict()
  passes game_map's home_team through.
- engine/model.py: FEATURE_COLS extended from 5 to 11 (legacy 5 +
  lineup_lhh_pct, pitcher_k_vs_lhh, pitcher_k_vs_rhh,
  pitcher_fastball_pct, pitcher_avg_velo, park_factor_k). train()
  imputes each new column with its _CONTEXT_DEFAULTS entry so rows
  graded before the migration land in the training pool unchanged.
  predict() fills any missing context feature with the same defaults
  via dict.setdefault, so the legacy fallback _build_pitcher_features()
  (which only returns the 5 legacy keys) still produces a valid vec.
- engine/fetch.py: new compute_lineup_handedness(lineup_players) helper
  — {game_id: {lhh_pct, rhh_pct}} aggregator with switch hitters
  counted 0.5 to each side. Reserved for predict-time use; grade.py
  derives the same value at grade time from the actual batter list.
- engine/grade.py:
  * Per-row pitch mix from a single-day Statcast call
    (_pitcher_pitch_mix) — pitcher_fastball_pct / breaking / offspeed /
    avg_velo / pitches_last_start. Bounded ~15-20 API calls per
    grading run.
  * Opposing-lineup handedness from the boxscore's actual batter list
    (_opp_lineup_handedness) — no separate lineup fetch needed.
  * Opposing starting pitcher identified via box[side]["pitchers"][0]
    (NOT gameStatus.pitchingOrder — that field is empty in the modern
    boxscore shape, confirmed by direct probe). _opp_starting_pitcher
    returns (sp_id, sp_hand).
  * Opposing SP recent-5-start stats (_opp_sp_recent_stats) — ERA,
    WHIP, K-rate from stats.get_pitcher_starts. League-average fallback
    when sp_id is unknown or the pitcher has no logged starts.
  * Park factors (k + hits) on pitcher rows; park_factor_hits_h on
    hitter rows.
  * Hitter rolling 15-game hits-per-PA approximation as a rough
    hitter_avg_vs_hand — improves automatically once per-game opp hand
    is logged historically.
  * Sample-row log line at end of grade_yesterday() prints
    "context features sample (player N): {lineup_lhh_pct: ...,
    pitcher_k_vs_lhh: ..., pitcher_fastball_pct: ...,
    park_factor_k: ...}" so each cron's log shows the new features
    landing.
- engine/db.py: upsert_game_logs() now catches PGRST204 on the new
  context-feature column names and retries stripped of them. Pipeline
  keeps grading actuals correctly before db/migrations/
  add_context_features.sql is applied.
- db/schema.sql + db/migrations/add_context_features.sql: 23 new
  nullable columns on player_game_logs (12 pitcher-side, 11 hitter-side).
- Verified: full grade_yesterday() run produced rows with real
  pitcher_fastball_pct (0.522), pitcher_avg_velo (94.6), park_factor_k
  / park_factor_hits, lineup_lhh_pct derived from boxscore batters.
  grade_hitters_yesterday() produced real opp_sp_k_rate_last5 / era /
  whip / hand. train() succeeds on 58 pitcher rows with 11 features
  (all imputation-fillable, zero NaN after imputation pass). The new
  columns will be populated DB-side once add_context_features.sql is
  applied; until then the defensive retry strips them and the
  pre-existing columns continue to fill.

Future-slate browsing (this session):
- engine/fetch.py: refactored to a _resolved_schedule(date_str) helper
  cached via lru_cache(maxsize=8). One pass per date does the schedule
  fetch + per-pitcher statsapi.lookup_player resolution, returning
  (schedule, starter_records, starter_ids_by_game). fetch_games(),
  fetch_starters(), fetch_starters_for_date() and fetch_probable_pitchers
  all consume this so the same date doesn't trigger duplicate lookups
  in one cron run.
- engine/fetch.py: fetch_games() now populates home_starter_id and
  away_starter_id from the resolved schedule when the lookup succeeds.
  These keys are OMITTED (not set to None) when resolution fails so the
  upsert never clobbers a previously-known starter on a transient
  lookup miss.
- engine/fetch.py: new fetch_starters_for_date(date_str) — same shape as
  fetch_starters() but for an arbitrary date string. Powers future-slate
  previews. Not lru_cached itself; the underlying _resolved_schedule
  cache handles it.
- engine/db.py: upsert_games() now groups rows by their key signature
  before upserting so a heterogeneous batch (some games with starter_ids,
  some without) doesn't accidentally NULL the column via PostgREST's
  union-of-keys behavior. Also catches PGRST204 "missing column" on the
  starter_id keys and retries stripped of them, so the engine keeps
  working before the migration is applied.
- engine/main.py: new _run_future_previews() helper called at the end of
  main() after _run_calibration. Iterates days_ahead in (1, 2, 3) and
  for each calls fetch_games + fetch_starters_for_date + db.upsert_*
  inside its own try/except so one bad date never sinks the others.
  Wrapped by an outer try/except in main() so the previews are decoupled
  from the projection pipeline.
- db/schema.sql: games table now defines home_starter_id and
  away_starter_id as nullable FKs to players(player_id).
- db/migrations/add_starter_ids.sql: one-time manual migration to apply
  the two new columns to the live Supabase schema:
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS home_starter_id integer
        REFERENCES players(player_id),
      ADD COLUMN IF NOT EXISTS away_starter_id integer
        REFERENCES players(player_id);
- web/app/DateNav.tsx: extracted the date-navigation component out of
  PropBoard.tsx so both PropBoard and FutureSlate can share it.
- web/app/FutureSlate.tsx: new client component. Renders DateNav + a
  muted info banner ("Projections not yet available · Probable starters
  shown where announced") + one card per game with the matchup, start
  time, and home/away probable starter (or "TBD"). Used when the date
  has games in the DB but no projections yet.
- web/app/page.tsx: getSlate() now runs 6 parallel reads (the previous
  5 + a "next game date" query against games). nextDate is computed as
  the first of next-projection-date OR next-game-date so the › arrow
  works on future-preview dates. When the projections result is empty
  for selectedDate, a follow-up games query loads futureGames with the
  home_starter/away_starter joins (uses the explicit FK names
  games_home_starter_id_fkey / games_away_starter_id_fkey to disambiguate
  the two FKs that both reference players). hasAny gates rendering
  between PropBoard / FutureSlate / empty state.
- Verified: pipeline runs end-to-end pre-migration (graceful warnings
  on every games upsert, but projections + lines + edges + future
  previews all succeed). Locally: 3 future dates populated — 06-01 (9
  games, 17 starters), 06-02 (15 games, 27), 06-03 (15 games, 28).
  Frontend build clean: npm run build passes, tsc --noEmit clean.

Six-run cron + lines-only refresh mode (this session):
- .github/workflows/refresh.yml: cron is now 6/day (1/5/11/14/17/18 UTC =
  9pm/1am/7am/10am/1pm/2pm ET). First run of the day does a full
  projection pass; subsequent runs detect existing rows and skip the
  expensive baseline + XGBoost work, dropping run time from ~60s to ~20s.
- engine/db.py: two new count helpers — get_projection_count_for_date
  (optional prop_type filter) and get_game_log_count_for_date. Both
  use Supabase's count="exact" with limit(1) so they're a single
  round-trip with no row payload.
- engine/db.py: get_projections_for_date now paginates the select via
  .range() so it walks past the 1000-row Supabase server cap. A full
  slate produces 2000-3000 projection rows (200 players × 10-12 props);
  without pagination refresh-mode edges silently covered only the first
  1000. Verified: edges jumped from 89 → 180 in refresh mode after this
  fix on the same DB state.
- engine/main.py: mode header at the top of main() prints
  "lines-only refresh" or "full projection" + existing-projection count.
- engine/main.py: _grade_previous_slate bails out when player_game_logs
  already has rows for yesterday (one count round-trip).
- engine/main.py: _run_pitcher_pipeline + _run_hitter_pipeline both gain
  a skip-if-already-projected branch (>=20 total projections / >=100
  hitter_hits). name_to_id is built before the skip check so the lines
  fetch can still resolve names on skip-path runs.
- engine/main.py: _run_lines_and_edges + _run_calibration re-fetch
  today's projections from the DB when their caller passed [] (refresh
  mode). projection_date is injected so edge.compute_edges keys match.
- engine/main.py: total runtime logged at end and on failure.
- engine/lines.py: BOOKMAKERS expanded from 7 to 12 — added betmgm,
  bet365, espnbet, pointsbet, and re-added caesars. Books ParlayAPI
  doesn't list for a market are silent no-ops, so widening is free.
  Live verification: caesars now contributing 50+ lines/run.
- engine/lines.py: new diagnostic block after the existing summary —
  per-book breakdown (sorted desc), unmatched player names (first 10
  + total), and all market_keys returned by the API. Surfaces dead
  books, name-resolution misses, and unmapped markets per run.

Final-game result chip + late-night cron (this session):
- .github/workflows/refresh.yml: added a 4th cron at 06:00 UTC (2 AM ET)
  so the grader catches every game that finished overnight, including
  West Coast late games. Result: /results lands by ~2:05 AM ET instead
  of waiting for the 8 AM run.
- web/app/useLiveBoxScores.ts: now accepts TWO arrays — liveGamePks
  (poll every 60s, existing behavior) and finalGamePks (fetch each
  one exactly ONCE, tracked in a useRef Set so re-renders don't
  re-fetch). A loaded box score from either path is merged into the
  same Map<gamePk, Map<personId, StatLine>>. loadOne() was hoisted
  out of the effect so both can share it. The "clear stats when no
  live games" reset was dropped — Final stats would have been wiped
  every render — replaced with `setStats(prev => merge(prev))` on
  both effects.
- web/app/PropBoard.tsx: split today's slate into liveGamePks +
  finalGamePks and passes both to the hook. liveActualFor() now
  takes an `isFinal: boolean` so the pitcher_fantasy_score path can
  add the QS bonus (derivable from outs + ER) for Final games. The
  W bonus is still omitted because the boxscore doesn't carry the
  decision; the chip is consistent with the baseline's known ~6-FP-
  low bias.
- paceColor() gained a Final branch: actual > projection => green,
  actual < projection => red, equal => slate. Same calibration
  semantics the /results Model Tracker uses.
- Render gate: showActual = (live OR final); for scheduled / other
  states the right-side chip stays projection-only (existing
  behavior).
- Verified: tsc --noEmit clean. Existing live-game pace logic
  unchanged (the new Final branch returns before the live path is
  reached).

Audit follow-up (trackedFrom + projection column, this session):
- web/app/results/page.tsx: trackedFrom was issuing 12 separate
  round-trips (one per prop_type) sequentially-fired inside a
  Promise.all. Replaced with ONE paginated, ordered-ascending scan
  of (prop_type, game_date) on the lines table, then a JS reduce
  that keeps the first occurrence per prop_type (= earliest date).
  Fetched in parallel with projData/lineData/logData. Same
  semantic result, but reduces /results page load by 11 round-trips.
- player_game_logs.projection column dropped:
  * grade.grade_yesterday()/grade_hitters_yesterday() no longer
    write the "projection" key — the column held whichever prop's
    projection happened to be selected last (ambiguous and unread).
    Per-prop projections live in the projections table and are
    joined on (player_id, game_id, prop_type, projection_date) when
    needed.
  * db/schema.sql: removed the `projection numeric` definition.
  * db/migrations/drop_projection_column.sql: one-time manual
    migration (run in Supabase SQL editor):
      ALTER TABLE player_game_logs DROP COLUMN IF EXISTS projection;
  * Verified: no engine or frontend code reads
    player_game_logs.projection. The pipeline run on the existing
    column continues to work after the schema strip because
    PostgREST silently drops unknown payload keys.

Audit cleanup pass (Groups 1-5, this session):
- GROUP 1 (critical bugs):
  * web/app/page.tsx ALL_PROP_TYPES now includes both fantasy_score props
    — PropBoard.tsx already had the tabs but they were rendering empty
    because the home query excluded them.
  * web/app/useLiveBoxScores.ts: totalBases is NOT exposed by the MLB
    boxscore batting object. Live overlay now derives it from
    hits + doubles + 2*triples + 3*homeRuns (same formula grade.py uses).
  * engine/grade.py: _parse_innings was duplicated; deleted local copy
    and imported from engine/stats.py (single source of truth).
  * NOT removed: scikit-learn — per CLAUDE.md it's a runtime dep of
    XGBoost 3.x even though no engine .py imports it directly.
- GROUP 2 (engine efficiency):
  * db.get_game_logs() takes since_date floor; main.py + test_model.py
    pass a 60-day window so calibration no longer fetches the full
    season every cron run.
  * grade.grade_yesterday()/grade_hitters_yesterday() accept a
    projections kwarg. main._grade_previous_slate fetches projections
    once and passes to both — eliminates a duplicate
    get_projections_for_date round-trip.
  * baseline.build_strikeout_projections() accepts bulk_df from
    model._fetch_bulk_statcast. model.predict() returns (rows, bulk_df).
    When there's no trained model, main.py does a standalone bulk fetch
    for the baseline so both paths benefit from the one-call pattern.
- GROUP 3 (frontend types/constants):
  * web/lib/types.ts: single source for PropType, Pitcher, GameGroup,
    ByProp, Verdict, EvaluatedResult, TrackerResult, StatLine,
    LiveStatsMap, GameStatus.
  * web/lib/constants.ts: single source for ALL_PROP_TYPES,
    TRACKER_PROPS (Set form), HITTER_PROPS, EDGE_THRESHOLD, PROP_LABELS.
  * web/lib/supabase.ts: hoists fetchAllPages paginator so both
    page.tsx files share one Range-header pagination implementation.
  * PropBoard.tsx, ResultsBoard.tsx, useLiveBoxScores.ts,
    useLiveGameStatus.ts, both page.tsx files import from shared.
    Each file re-exports the names it previously owned so external
    imports keep working. npx tsc --noEmit passes clean.
- GROUP 4 (engine hygiene):
  * constants.py: drop unused HIT_EVENTS, WALK_EVENTS,
    BASELINE_LOOKBACK_GAMES.
  * baseline.py: drop unused LEAGUE_AVG_K_PCT import.
  * edge.py: drop "caesars" from CONSENSUS_BOOKS (never ingested).
  * model.py: tighten stats import to just _opp_k_rate; drop F401 noqa.
  * calibrate.py: docstring now reflects _ACTUAL_COL covers all 12
    prop types.
- GROUP 5 (workflow):
  * refresh.yml sanity grep targets strings unique to the CURRENT
    refactor (_fetch_bulk_statcast / _team_k_pcts).
  * Added pip cache via actions/setup-python's cache: "pip" mode,
    keyed on engine/requirements.txt.
  * Added timeout-minutes: 20 to cap a hung pybaseball request.
- Verification: full pipeline ran locally; bulk Statcast fetch:
  117,320 pitches covering 550 pitchers in one call; 30 pitcher
  projections × 6 prop types + 270 hitter projections × 6 prop types,
  312 lines ingested, 153 edges computed, no errors.

Engine refactor (Statcast bulk fetch, constants centralization, main.py shape):
- engine/model.py — XGBoost predict() now does ONE bulk pybaseball.statcast()
  call covering the whole STATCAST_LOOKBACK_DAYS window, then filters the
  resulting DataFrame per-pitcher in memory. Before the change every starter
  triggered its own statcast_pitcher() request (~30 round-trips per cron
  run). New helpers:
    _fetch_bulk_statcast(proj_date) -> DataFrame
    _build_pitcher_features_from_df(player_id, bulk_df, home_away, opp, date)
  The legacy _build_pitcher_features(player_id, ...) is kept as a defensive
  fallback when the bulk fetch returns empty (Savant flake). Verified
  locally on 2026-05-31: bulk fetch returned 117,320 pitches covering
  550 pitchers in one call; pipeline produced 30 pitcher + 270 hitter
  projections with no errors.
- engine/constants.py — centralized magic numbers used across the engine
  (existing constants kept as-is so baseline.py needs no change). Added:
    MIN_TRAINING_ROWS = 25                (from model.py)
    BLEND_MODEL_WEIGHT = 0.6              (from main.py MODEL_WEIGHT)
    BLEND_BASELINE_WEIGHT = 0.4           (from main.py BASELINE_WEIGHT)
    STATCAST_LOOKBACK_DAYS = 30           (from model.py local literal)
    PROP_CV = 0.35                        (from edge.py)
    MIN_STD = 0.5                         (from edge.py)
    EDGE_THRESHOLD = 0.1                  (frontend-only today; declared
                                           here for future Python use)
    MIN_GRADED_STARTS = 5                 (from calibrate.py)
    BASELINE_LOOKBACK_GAMES = RECENT_STARTS   (descriptive alias; baseline.py
                                               still imports RECENT_STARTS)
  model.py, main.py, edge.py, calibrate.py all import these from constants
  now instead of defining locally. Values unchanged.
- engine/main.py — single 150-line main() broken into semantic helpers
  so main() reads as an executive summary:
    _grade_previous_slate()
    _setup_games_and_pitchers()    -> (games, starters)
    _run_pitcher_pipeline(...)     -> (pitcher_projections, name_to_id, n)
    _run_hitter_pipeline(name_to_id) -> (hitter_projections, lineup_count)
    _run_lines_and_edges(name_to_id, all_projections)
    _run_calibration(all_projections)
  Logic inside each helper is identical to pre-refactor; the betting
  layer's existing try/except is preserved. Outer try/except in main()
  still surfaces failures with the PIPELINE FAILED traceback so a failed
  Actions run continues to email automatically.

Supabase 1000-row cap (root cause of months of phantom 'no data' on /results):
- PostgREST (which powers supabase-js .select()) caps every response at
  1000 rows by default unless the caller passes an explicit .limit() or
  .range(). When the query exceeds 1000 rows the rest of the data is
  silently truncated. NO error, NO warning. Downstream code sees fewer
  rows than the table actually contains.
- For /results, the 7-day window pulls projections (~20k rows expected),
  lines (~10k), and player_game_logs (~2k). The cap was eating ~95% of
  projections and ~90% of lines. The Vercel diag showed
  earned_runs=lines=0, outs_recorded=lines=0, etc. -- not because those
  rows didn't exist in the DB but because the most populous prop_types
  (hitter_hits, hitter_total_bases) filled the 1000-row quota and the
  rest of the prop_types were truncated to zero. This silently masked
  every upstream fix attempted for those props.
- For the home page, projections for ONE day across 280 players * 10
  props ≈ 2800 rows. Same cap, same silent truncation.
- Both pages now pass an explicit .limit() on every multi-row query:
  - /results: .limit(100_000) on projections + lines + logs
  - /: .limit(50_000) on projections + edges
  - single-row metadata queries (.limit(1) for latest dates etc.) are
    untouched.
- This is THE most important fix in the project's history -- it
  retroactively unblocks every prop_type that was being silently
  truncated, which is most of them.

Lines ingestion — many-to-one market_key map (fixes outs_recorded):
- ParlayAPI substring-matches the markets parameter against its internal
  catalog, then returns rows with NORMALIZED market_key values that don't
  always equal the request string. Previously MARKET_TO_PROP was the
  reverse of PROP_TO_MARKET (one request -> one response), which silently
  dropped any prop where ParlayAPI's response key differs from the
  request key.
- The big one we missed: requesting 'player_pitcher_outs' returns rows
  with market_key='player_outs' (10) or 'player_pitching_outs' (4) -- not
  'player_pitcher_outs'. Every one of the 14 daily outs lines was getting
  dropped at the market-key match step. The '/results' page's "Outs --
  no lines yet" tag was caused by this, not by a true upstream gap.
- engine/lines.py now defines MARKET_TO_PROP as an EXPLICIT many-to-one
  dict including every response market_key we want per prop:
    strikeouts:   player_strikeouts, player_pitcher_strikeouts
    hits_allowed: player_hits_allowed
    walks:        player_walks, player_walks_allowed
    earned_runs:  player_earned_runs, player_earned_runs_allowed
    outs_recorded: player_outs, player_pitching_outs        [FIX]
    hitter_*: unchanged
    pitcher_fantasy_score / hitter_fantasy_score: unchanged
- PROP_TO_MARKET is unchanged (still drives the request) -- only the
  reverse map gained new keys, so this is purely additive: more lines
  per cron run, no existing lines lost.
- Discovered via engine/_probe_keys.py (removed after the audit).
  The probe tried both canonical Odds-API names (pitcher_outs) and our
  legacy player_X names and tallied the response market_keys and books.

Results page — Total Bases bug fix + UI polish:
- TOTAL BASES BUG (silent since day one): the MLB boxscore batting
  object does NOT carry a totalBases field -- only atBats, hits,
  doubles, triples, homeRuns, rbi, baseOnBalls, etc. Verified via
  probe 2026-05-31: batting.get('totalBases') returns None even for a
  batter with a double. grade.py was writing actual_total_bases=0 for
  every hitter every game; the Model Tracker surfaced this as
  proj 1.36 / actual 0.00 / under 100% (the betting view conflated it
  with calibrated under-leans so the bug was invisible). Fixed:
  grade._hitter_result now computes
    total_bases = hits + doubles + 2*triples + 3*home_runs
  from components the boxscore DOES carry. New grading runs are
  correct; historical rows can be backfilled via this SQL (only
  recomputes rows where Phase 2's component columns are populated --
  older rows stay at 0):
    update player_game_logs
       set actual_total_bases =
             actual_hits + doubles + 2 * triples + 3 * actual_home_runs
     where player_type = 'hitter'
       and doubles is not null
       and triples is not null;

- BETTING PER-PROP CARD now shows all 5 betting props ALWAYS, even
  when 0 rows in the window. Empty rows render with dimmed slate-500
  label, '0/0', '—' rate, and either 'tracked from {date}' or
  'no lines yet' depending on whether the prop has any line history.
  A missing prop is much more informative than a missing row -- the
  user can see immediately whether the data gap is upstream
  (ParlayAPI not returning outs_recorded) or just a sparse window
  (fantasy_score not yet graded).

- UI POLISH (per spec):
    * Betting per-prop rows: py-3 (was py-2.5).
    * Betting result rows: py-3, player name font-medium.
    * Tracker calibration card: simplified to two big numbers
      ('▲ N% over · ▼ N% under') with the label centered below.
      Removed the 'over = actual > projection' explainer text.
    * Tracker per-prop card: two-line entries, prop name + sample
      count on top, 'proj X · actual Y' + 'N% / N%' on bottom,
      tracked-from beneath. py-4 spacing.
    * Tracker result rows: 6-column grid (Player | Prop | Proj |
      Actual | ▲▼ | Date) with bg-slate-900/30 zebra striping on
      odd rows. ▲ slate-300, ▼ slate-500 — the only color indicator.
    * Tracker filter chips: muted slate-700 active state (not
      emerald) so the section reads as 'stat tracker', not 'betting'.
    * Section divider replaced with a band — border-t with the label
      'MODEL TRACKER' centered, using bg-slate-950 to cut through.
      Matches the body bg from layout.tsx.

Results page — two-section redesign (Betting Edge + Model Tracker):
- /results now renders both sections inline, no tab switching:

  SECTION 1 -- Betting Edge (5 props)
    Props: strikeouts, hits_allowed, outs_recorded,
           pitcher_fantasy_score, hitter_fantasy_score
    Score: existing lean-vs-line ('correct'/'wrong'/'skip').
    Headline: hit % (≥60% emerald, 45-60% amber, <45% red).
    Components reused/renamed: BettingOverallCard, BettingPerPropCard,
    BettingFilterBar, GameFilter, BettingRow. Game dropdown stays only in
    this section. ⚠ lean-bias chip removed -- the four props that used to
    trigger it have moved to Section 2.

  SECTION 2 -- Model Tracker (4 props)
    Props: hitter_hits, hitter_total_bases, walks, earned_runs
    Score: actual vs MODEL PROJECTION (no book line).
      over  = actual > projection
      under = actual <= projection (no skip threshold)
    Headline: '▲ N% over proj · ▼ N% under proj' in slate-200/400 plus
    a calibration label:
      under% > 60 (>=10 samples)  -> '↓ Model tends to overestimate'
      over%  > 60                  -> '↑ Model tends to underestimate'
      else                         -> '~ Well calibrated'
    Per-prop card shows avg proj vs avg actual, over%/under% split, and
    sample count. Result row uses ▲/▼ only (no ✓/✗) in muted slate to
    signal 'diagnostic, not a betting hit rate'.
    Section has its own filter chips; uses slate-200 (not emerald) for
    the active chip so the visual identity stays 'stat tracker' rather
    than 'betting result'.

- page.tsx getResults() now returns { bettingResults, trackerResults,
  dateRange, trackedFrom }. One pass over the fetched projections emits
  EvaluatedResult into bettingResults OR TrackerResult into trackerResults
  based on TRACKER_PROPS set membership. The tracker join skips lines
  entirely so it produces results immediately for props whose lines aren't
  yet ingested.
- MIN_LINE narrowed to the five betting props only.
- ACTUAL_COLUMN keeps all 10 props -- tracker join needs the actual
  column for walks/earned_runs/hitter_hits/hitter_total_bases too.
- Page header subtitle simplified: '{start} – {end}'. Section headings
  carry the framing ('Model lean vs book line · main market props only'
  vs 'Actual outcomes vs model projection · calibration, not a betting rate').
- Footer split: Betting Edge / Model Tracker disclosures on separate
  lines so the user knows what each section measures.

Results page — forward-anchored window + per-prop diagnostics:
- Window end was previously max(player_game_logs.game_date). When a
  prop_type's first lines were ingested today, today's lines + today's
  projections lived OUTSIDE the window (anchored on yesterday's last
  graded game) so the prop showed proj=N lines=0 in the diag and never
  appeared. Window end now uses MAX(latest_log_date, latest_line_date).
  Newly-ingested prop_types appear as soon as the next grading cycle
  catches up, without waiting for them to drift into the historical
  log window.
- Per-prop diagnostic + drop counter now generalized: page.tsx logs
  [results-diag] proj=N lines=N logs=N tracked_from=... for every
  DIAG_PROPS entry (strikeouts, hits_allowed, walks, earned_runs,
  outs_recorded, pitcher_fantasy_score, hitter_hits, hitter_total_bases,
  hitter_fantasy_score). Per-stage drop counter is now a Map keyed by
  prop_type; each prop with non-zero rows gets its own
  '[results-diag] {pt} join drop: noLine=N belowMin=N noLog=N
  noActual=N survived=N (threshold=...)' line.
- 'Tracked from' date per prop: one supabase round-trip per prop_type
  (SELECT game_date FROM lines WHERE prop_type=X ORDER BY game_date
  ASC LIMIT 1). Returned as Partial<Record<PropType, string>> from
  getResults; passed through ResultsBoard into PerPropCard and
  rendered as a small slate-500 subtitle beneath the prop label
  ('tracked from May 31'). Hidden when null (prop never ingested).

Fantasy Score props — Phase 5 (frontend):
- web/lib/fantasyScore.ts is the TypeScript mirror of engine/fantasy_score.py.
  Same weights, same QS rule, same singles derivation. Comment on each
  file references the other; change in one => change in the other.
- PropBoard.tsx:
    * PropType union + PROPS list gain both new types. Labels "Fantasy
      Score" with unit "FP". Pitcher FP placed after Outs Recorded;
      Hitter FP placed after Home Runs.
    * HITTER_PROPS Set now includes hitter_fantasy_score so the pacing
      function treats it correctly.
    * PROP_STAT_KEY became Partial<Record<...>> -- fantasy-score props
      aren't 1:1 with a StatLine field. A new liveActualFor(propType,
      stat) function returns the live actual: simple props look up
      PROP_STAT_KEY; hitter_fantasy_score calls hitterFantasyScore over
      all components; pitcher_fantasy_score computes ONLY the
      outs/K/ER portion (W and QS withheld until the game is final, per
      spec). The render replaces the inline statKey lookup with this
      helper.
- useLiveBoxScores.ts extends StatLine with doubles, triples, hitByPitch,
  stolenBases so the live hitter FP has everything it needs.
- results/page.tsx ACTUAL_COLUMN + MIN_LINE both gain the two new
  prop_types:
    pitcher_fantasy_score floor 6.0  (filters short relief outings)
    hitter_fantasy_score  floor 4.0  (filters bench/pinch appearances)
- ResultsBoard.tsx PropType + PROP_LABELS ("Pitcher Fantasy",
  "Hitter Fantasy") + PITCHER_PROPS + HITTER_PROPS arrays all updated.
  New BIAS_EXEMPT Set lists both fantasy-score props so the lean-bias
  flag never fires for them -- PrizePicks posts a single balanced
  flat-payout line, so any tilt is model behavior, not a base-rate trap.
- Results footer now notes: "Fantasy score uses the official PrizePicks
  scoring formula and PrizePicks lines only."

Fantasy Score props — Phase 4 (lines + edges):
- engine/lines.py PROP_TO_MARKET adds pitcher_fantasy_score ->
  player_pitcher_fantasy_score and hitter_fantasy_score ->
  player_hitter_fantasy_score (confirmed market keys from Phase 0).
- New PRIZEPICKS_ONLY_PROPS set lists the two fantasy-score prop_types.
  fetch_prop_lines drops any row whose prop_type is in that set unless
  bookmaker == 'prizepicks'. The fantasy-score scoring formula is
  PrizePicks-specific, so a line from any other book would be a
  category error -- this is a hard contract enforced at ingest.
- ParlayAPI does substring matching on the markets parameter, so
  asking for player_hitter_fantasy_score also returns inning-variant
  keys (player_1st_inning_hitter_fantasy_score, _2nd_, _1+2+3_, etc.).
  MARKET_TO_PROP is an exact map and unrecognized keys were already
  dropped by the existing code path, so partial-game variants can
  never sneak through.
- Per-run summary line now appends '[N non-PrizePicks fantasy lines
  dropped]' when applicable so the filter is auditable in the Actions log.
- engine/edge.py is already prop-type-generic (keys on
  (player_id, prop_type, game_date)) so edges flow without any change.

Fantasy Score props — Phase 3 (baselines):
- HITTER PATH (no cold start): extended stats.get_hitter_games to return
  doubles, triples, walks, hit_by_pitch, stolen_bases alongside the
  existing five fields, all sourced from the same MLB Stats API
  person/gameLog response. Per-game FP is computed with the shared
  fantasy_score.hitter_fantasy_score helper -- the baseline works on
  day one without waiting for player_game_logs to accumulate.
- PITCHER PATH (with documented bias): build_pitcher_fantasy_score_
  projections computes per-start FP from outs + K + ER + QS only.
  Historical W decisions are not exposed by get_pitcher_starts and
  refetching the live feed for each historical start would balloon API
  calls. The baseline is systematically low by ~2.4 FP (league-avg W
  rate × 6 pts), but the bias is uniform across pitchers so leans vs
  the PrizePicks line still reflect real model signal. Upgrade path:
  once player_game_logs has enough graded actual_pitcher_fantasy_score
  rows, switch to reading those directly -- they already include W.
- engine/main.py now calls both new builders in the same loops as the
  other pitcher + hitter props. They share the existing upsert
  pipeline; no schema or DB changes needed beyond Phase 1.

Fantasy Score props — Phase 2 (grading):
- engine/grade.py imports from fantasy_score and computes both actuals
  end-to-end on each grading pass:
    * pitcher: outs + K + ER (already extracted) + W decision via new
      _decisions(game_id) helper (one statsapi.get('game', ...) call per
      finished game; boxscore_data does not expose decisions). QS is
      derived from outs + earned_runs inside the helper. Persists
      actual_win + actual_pitcher_fantasy_score.
    * hitter: _hitter_result now also pulls doubles, triples, walks
      (baseOnBalls), hit_by_pitch, stolen_bases from the same boxscore
      pass. Persists those four components + actual_hitter_fantasy_score.
- engine/calibrate.py _ACTUAL_COL gains both prop_types so per-prop
  hit-rate calibration kicks in for fantasy score once each player has
  5+ graded games. No other change there -- calibrate is generic.
- Per-row log lines now print FP and a W/— marker for pitchers and FP
  for hitters so the Actions log shows the new metric directly.

Fantasy Score props (PrizePicks-only) — Phase 1 (DB + constants):
- New prop_types added end-to-end: pitcher_fantasy_score, hitter_fantasy_score.
  PrizePicks is the SOLE book for both — never ingest or score from any
  other book. Confirmed via Phase 0 probe: ParlayAPI market keys are
  player_pitcher_fantasy_score and player_hitter_fantasy_score, both
  returned only by 'prizepicks'.
- engine/fantasy_score.py is the single source of truth for both PrizePicks
  scoring formulas. ALL Python callers must import from here -- no weights
  duplicated anywhere else. Mirror file at web/lib/fantasyScore.ts (Phase 5)
  carries the same constants for live in-game frontend math.
- Schema changes to player_game_logs. One-time migration SQL (run in
  Supabase SQL editor before the next grading run):
    alter table player_game_logs
      add column if not exists doubles                       integer,
      add column if not exists triples                       integer,
      add column if not exists hit_by_pitch                  integer,
      add column if not exists stolen_bases                  integer,
      add column if not exists actual_win                    boolean,
      add column if not exists actual_hitter_fantasy_score   numeric,
      add column if not exists actual_pitcher_fantasy_score  numeric;
  doubles/triples/hit_by_pitch/stolen_bases are component columns used to
  recompute hitter fantasy score from history. actual_win is the pitcher's
  W decision pulled from the boxscore decisions block.

Results page — bias detection, diagnostics, outs, by-game grouping:
- MIN_LINE thresholds tightened where alternates were still leaking in:
    strikeouts:     2.5 -> 3.5
    hits_allowed:   2.5 -> 3.5
  outs_recorded stays at 10.5 (column is actual_outs_recorded, verified
  in grade.py). Outs now appears in the per-prop card + filter chips.
- Excluded entirely (one-sided markets that reflect base rate, not
  model signal): hitter_runs, hitter_rbis, hitter_home_runs. The
  earlier 0.5-line hitter_runs/hitter_rbis rows were polluting the
  hit rate without telling us anything actionable.
- Lean-bias detection (ResultsBoard.tsx::isBiased): per prop, if >=5
  evaluable rows AND one direction (over/under) holds >80% share, flag
  the prop with an amber "⚠ lean bias" chip in the per-prop card and
  dim its hit-rate percent to slate-500. The 94% on hitter_runs the
  user saw was a 94% under-base-rate, not model accuracy; the chip
  makes that legible at a glance.
- earned_runs diagnostic: page.tsx now logs to the Next.js server log
  (visible in Vercel function logs / dev terminal):
    [results-diag] earned_runs window YYYY-MM-DD..YYYY-MM-DD:
      proj=N lines=N logs=N
    [results-diag] earned_runs join drop:
      noLine=N belowMin=N noLog=N noActual=N survived=N
      (threshold=1.5)
  Pinpoints exactly which stage drops rows. Earned-runs string
  verified consistent across baseline.py, grade.py, calibrate.py,
  lines.py, and ACTUAL_COLUMN -- the wiring isn't the bug.
- By-game grouping: results list now renders as game-card sections
  (matchup + date header, per-game hit-rate badge) instead of a flat
  table. Added a Game dropdown filter (separate from prop-type chips)
  that lets the user drill into a single game's results. Both filters
  compose; the OverallCard recomputes against the post-filter set.

Results page — main-market filtering (web/app/results/page.tsx):
- Added MIN_LINE thresholds so the hit rate reflects only main-market
  lines, not alternates that resolve as easy hits and inflate accuracy:
    strikeouts >= 2.5 | hits_allowed >= 2.5 | walks >= 1.5
    earned_runs >= 1.5 | outs_recorded >= 10.5
    hitter_hits >= 1.5 | hitter_total_bases >= 1.5
    hitter_rbis >= 1.5 | hitter_runs >= 0.5
  Props absent from MIN_LINE are excluded entirely -- currently
  hitter_home_runs, because the 0.5 line dominates and there is no
  real HR signal in the model yet. Adding HRs back is a one-line
  change to MIN_LINE once HR-specific features land.
- BOOK_PREFERENCE expanded from ['draftkings','prizepicks'] to all 7
  ingested books in main-market order: draftkings, fanduel, pinnacle,
  prizepicks, underdog, betr, sleeper. Earned-runs-style props that
  weren't listed at DK or PrizePicks now resolve to Pinnacle/FanDuel
  lines instead of falling through to "no line, skipped".
- earned_runs sanity-checked end-to-end: same string used in baseline.py,
  grade.py, calibrate.py, lines.py, and ACTUAL_COLUMN. The prop wasn't
  missing from the wiring -- the broader book list is what unblocks it.
- Footer copy updated: "Main market lines only -- alternate lines and
  home run props excluded."

Results page — line-lean hit rate (web/app/results/):
- Replaced the old "actual >= projection" metric (which showed 40% the
  user flagged) with the metric that actually matters for betting:
  whether the projection's lean direction vs the book line matched the
  actual outcome.
- Scoring (web/app/results/page.tsx::classify):
    over lean  (proj > line):  correct if actual > line, else wrong
    under lean (proj < line):  correct if actual < line, else wrong
    no lean    (|proj-line| < 0.1):  skip (too close to call)
- Joins three tables in memory over a 7-day window anchored on the
  latest graded date: projections + lines + player_game_logs.
  Single book per (player, prop, date): DraftKings preferred,
  PrizePicks fallback, any other book as last resort -- so the hit
  rate is consistent and not mixing books with different vig.
- ACTUAL_COLUMN maps every prop_type to its column in
  player_game_logs (e.g. strikeouts -> actual_strikeouts,
  hitter_total_bases -> actual_total_bases). All 10 prop types.
- Display: OverallCard (correct / wrong / skip / total + headline %),
  PerPropCard (per-prop hit rate), filter chips (All / Pitcher /
  Hitter / each individual prop type that has rows), and a flat
  results table sorted newest-first. The overall card recomputes
  against the filtered set so the headline matches the table.
- Old per-day ResultsBoard removed; date navigation gone in favor of
  the 7-day window. /results link in the home header is unchanged.

Team K% via MLB Stats API (engine/stats.py):
- _team_k_pcts(year) now sources team batting K% from the MLB Stats API
  teams_stats endpoint (group=hitting, stats=season). Same authoritative
  source MLB.com publishes -- no scraping, no User-Agent shim, no 403,
  no fallback warning on every Actions run.
- Computes K% = strikeOuts / plateAppearances per team. Keys by
  TEAM_NAME_MAP lookup so the FanGraphs abbr keyspace is preserved and
  _opp_k_rate's resolution logic is unchanged.
- _TEAM_K_PCT_2024 retained as a last-resort fallback: activates only if
  the MLB API call throws or fewer than 20 of 30 teams resolve (e.g.
  catastrophic name-mapping drift or very early-season runs with no
  sample). Verified locally: 30 teams resolve, NYY=0.229 BAL=0.236
  LAD=0.203 KC=0.216 ATH=0.222.
- pybaseball + the FanGraphs UA shim + the 3x retry loop all removed
  from stats.py. requests.Session UA monkey-patch retained at module
  load -- harmless and benefits any other library that uses requests.
- pybaseball stays in requirements.txt because baseline.py still uses
  Statcast for per-pitcher histories.

scikit-learn dependency (engine/requirements.txt):
- XGBoost 3.x no longer bundles a fallback sklearn shim. Instantiating
  XGBRegressor raises "ImportError: sklearn needs to be installed in
  order to use this module" without scikit-learn in the env.
- Pinned scikit-learn==1.8.0 (matches local). Earlier runs only failed
  on this once the XGBoost path actually executed -- i.e. after the
  b636a28 + 201729c fixes finally let train() reach model.fit().

Workflow stale-code diagnostic (.github/workflows/refresh.yml):
- Investigation found nothing in the workflow that could serve stale .py
  files: actions/checkout@v4 runs against the default branch with no ref
  pin, no actions/cache step, no __pycache__ persistence between runs.
  Each Actions VM is fresh. The "stale output" reports were almost
  certainly queued runs whose checkout happened before the new commits
  landed (cron triggers can fire and queue mid-push).
- Added a "Debug — confirm checkout is fresh" step that prints git HEAD,
  the last 3 commits, and the mtimes of the engine python files. Then
  greps engine/model.py for "pitcher rows after type filter" and
  engine/stats.py for "unrecognized keyspace" — strings that only exist
  in post-b636a28/post-201729c code. Prints "MISSING: ... is stale" if
  not found. Next stale-output report is diagnosable from the log alone.
- Local mtime touches deliberately skipped: git clone always resets file
  mtimes to checkout time, so touching files locally does nothing for
  the runner. The grep is the real verification.

Live in-game stat overlay (web/app/useLiveBoxScores.ts + PropBoard.tsx):
- useLiveBoxScores(liveGamePks) is a client hook that polls
  statsapi.mlb.com/api/v1/game/{gamePk}/boxscore for each live game
  every 60s. Returns Map<gamePk, Map<personId, StatLine>>.
  - personId is the MLBAM id, identical to our players.player_id, so
    the join is a Map.get() in render.
  - Re-fetches only when the SET of live gamePks changes (stringified
    sorted key) — order-only swaps from useLiveGameStatus don't
    retrigger the wave of box-score requests.
  - Never throws; on any per-game failure that gamePk drops from the
    Map and the row falls back to projection-only.
- PROP_STAT_KEY maps each PropType to the StatLine field it reads:
    strikeouts → strikeOuts | hits_allowed → hitsAllowed (pitching.hits)
    walks → baseOnBalls | earned_runs → earnedRuns | outs_recorded → outs
    hitter_hits → hits | hitter_total_bases → totalBases
    hitter_rbis → rbi  | hitter_runs → runs | hitter_home_runs → homeRuns
- ProjectionBadge replaces the right-side green chip when liveActual is
  defined: '{actual} {unit} · proj {projection}'. The actual is colored
  by paceColor():
  - Hitters: green if actual > 0, neutral if 0.
  - Pitchers: innings_elapsed = (currentInning - 1) +
    (half === 'bottom' ? 0.5 : 0); expected = projection *
    innings_elapsed / 9; green if actual >= 0.8 * expected, amber if
    >= 0.5 * expected, red otherwise. Neutral before innings_elapsed > 0.
- Only LIVE games show overlay; final games keep projection-only (the
  /results page covers that view) and pre-game games are unchanged.
- Pitcher type gained player_id; page.tsx now passes r.player_id through.

Chronological game ordering on the frontend (web/app/page.tsx):
- games table gained a start_time timestamptz column (first-pitch UTC).
  Populated by engine/fetch.py from statsapi schedule's game_datetime.
  Migration SQL (run once in Supabase SQL editor):
    alter table games
      add column if not exists start_time timestamptz;
- page.tsx now selects games(home_team, away_team, start_time) and stores
  startTime on each GameGroup. After grouping, the games array for every
  prop type is sorted ascending by start_time. Games with null start_time
  (TBD slots) sort to the end via Number.POSITIVE_INFINITY.
- Sort happens server-side once, so order is identical across all 10 prop
  tabs (Strikeouts, Hits Allowed, ..., Home Runs) with no client work.
  Matches MLB's schedule page ordering (10:35 AM ET → 4:20 PM ET, etc.).
- Live/in-progress games keep their chronological position — no special
  reordering by status.

Live game status on the frontend (web/app/useLiveGameStatus.ts + PropBoard.tsx):
- useLiveGameStatus(date) is a client hook that polls the MLB Stats API
  (statsapi.mlb.com/api/v1/schedule?sportId=1&date=...&hydrate=linescore)
  every 60 seconds and returns Map<game_id, GameStatus>. game_id is the
  MLB gamePk, which matches our games.game_id / projections.game_id 1:1.
- Each game card header now renders three modes:
    - LIVE: pulsing green dot (Tailwind animate-ping ring over a static
      bg-emerald-500 dot), "LIVE", away-abbr score @ home-abbr score,
      and the current inning ("▶ ▲ 3rd" / "▶ ▼ 5th").
    - Scheduled: localized start time in ET ("1:05 PM ET").
    - Final: "Final · MIL 4 @ HOU 1".
  All three live below the matchup title with a short date prefix
  ("Sun, May 31").
- Graceful degrade: the hook never throws. On fetch failure it keeps the
  prior Map, and the GameHeader's StatusLine renders nothing until the
  next 60s tick succeeds — the matchup + date are always visible.
- Pure presentation. No engine changes, no DB changes. The frontend is
  still ZERO math: it only displays projections from Supabase + status
  from the MLB API.

FanGraphs keyspace validation (engine/stats.py, follow-up to the 403 hardening):
- The 403 hardening (UA shim + retry + 2024 fallback) covered the failure
  case. The Actions log surfaced a different failure: FanGraphs returns a
  response but with keys that don't match TEAM_NAME_MAP's FanGraphs abbrs
  (e.g. full team names, trailing whitespace, alternate abbreviations).
  Every team then silently fell through to the league-average warning.
- _team_k_pcts now validates that the returned dict's keys overlap
  TEAM_NAME_MAP.values() by >= 20 of 30 teams. If not, it logs the actual
  sample keys ('sample keys: [...]') and falls back to _TEAM_K_PCT_2024.
- Keys are also .strip()'d defensively in case FanGraphs decorates with
  whitespace. grade.py is unchanged — it already routes opp_k_rate through
  stats._opp_k_rate, which now resolves real per-team values regardless of
  whether FanGraphs succeeds with a sane keyspace or the fallback activates.

FanGraphs 403 hardening (engine/stats.py):
- Module-level monkey-patch on requests.Session.request installs a browser
  User-Agent + Accept-Language header as defaults on every requests call so
  pybaseball's internal HTTP inherits a non-bot UA. Idempotent (only fills
  when caller didn't set its own UA).
- _team_k_pcts(year) retries pybaseball.team_batting up to 3 times with a
  2-second backoff, logging each failed attempt.
- After 3 failures it falls back to _TEAM_K_PCT_2024, a hardcoded table of
  2024 season team batting K% (fraction form) covering all 30 teams plus
  the 'ATH' rebrand. The fallback shares the FanGraphs abbr keyspace so
  _opp_k_rate's resolution logic is unchanged.
- Net effect: opp_k_rate is never silently constant — either FanGraphs
  succeeds (real current-season values) or the 2024 table activates (real
  per-team values, last-season prior). Restores model signal beyond is_home.

XGBoost training threshold:
- MIN_TRAINING_ROWS = 25 (lowered from 50). Verified against live data: pool
  is currently 30 pitcher rows (270 hitters + 30 pitchers in player_game_logs),
  one start per pitcher. Threshold 50 was blocking training entirely; 25 lets
  the model fit while the season accumulates. engine/test_model.py reproduces
  the row-survival accounting against live Supabase.
- Signal warning: with 1 start per pitcher, imputed last5/last30 are constant
  (in-pool mean); opp_k_rate/days_rest are NULL on ~all pitcher rows because
  FanGraphs 403s during grading, so imputation also yields constants. Net:
  only is_home varies until more starts accumulate. The ensemble blends with
  the baseline (model.py predict() + main.py), so this degrades gracefully.

XGBoost feature set (engine/model.py train()):
- FEATURE_COLS = [last5_k_rate, last30_k_rate, is_home, days_rest, opp_k_rate].
  Target: actual_strikeouts. Only pitcher rows train the model.
- Required (drop if missing): actual_strikeouts, home_away.
- Optional / imputed (never drop, always fill):
    - last5_k_rate / last30_k_rate: shift(1).rolling(...).mean() makes the
      FIRST row per pitcher NaN. Imputed with the league pitcher K average
      from the current pool (fallback 5.0).
    - opp_k_rate: NULL when FanGraphs 403s on the Actions runner. Imputed
      with constants.LEAGUE_AVG_K_PCT.
    - days_rest: NULL on a pitcher's first row of the season. Imputed with 5.
- train() filters to player_type='pitcher' BEFORE feature engineering. Without
  this, hitter rows (actual_strikeouts=NULL) silently void the entire pool —
  the original bug behind the "300 training rows / 0 usable" symptom.
- Diagnostics: train() prints row count after the type filter and per-column
  NaN counts after imputation, so the next zero-row failure is immediately
  attributable to a specific column.

PrizePicks line on the Fantasy Score board tabs (this session):
- Report (STEP 0, live DB): the edges table has ZERO rows for
  hitter_fantasy_score / pitcher_fantasy_score — on EVERY date, not just
  today. Root cause: edge.py::_fair_over_prob only seeds a de-vig baseline
  from pinnacle / draftkings / fanduel and explicitly excludes DFS books,
  so a PrizePicks-only prop always hits skipped_no_baseline and never
  produces an edge row. Lines DO exist (125 today, all prizepicks,
  +100/-100). So the fantasy board tabs showed the "FP · proj" badge but
  no line/edge line beneath the name (every other tab reads its line off
  the edges join). User chose line-only (no fabricated edge; engine
  untouched).
- Frontend-only fix:
  * web/app/page.tsx getSlate(): new ISOLATED, failure-tolerant query for
    bookmaker='prizepicks' lines on the two fantasy props for the slate
    date -> ppLineByKey `${player_id}|${prop_type}` -> line. ~125 rows, no
    pagination. On any error the map stays empty and the tabs just show no
    line (never a broken board). The byProp row build now sets
    `line: e?.line ?? ppLineByKey.get(key)` so fantasy rows (which have no
    edge) fall back to the PP line; non-fantasy rows are unaffected (the PP
    map only holds fantasy props).
  * web/app/PropBoard.tsx EdgeDetail: now renders when a line is present
    even if there's NO edge. Two-sided book (edge present) keeps the exact
    "Line X · ▲ Edge ±Y" rendering. Line-only (PrizePicks fantasy) shows
    "Line X · ▲ Over / ▼ Under / ~Even" — the model's LEAN vs the line,
    i.e. the SAME proj-vs-line comparison /results uses to grade these
    props (over if proj>line, under if proj<line). New local constant
    LINE_LEAN_THRESHOLD = 0.1 mirrors /results NO_LEAN_THRESHOLD so the
    board's ~Even cutoff and the grading agree. No de-vigged edge number
    is shown for DFS lines (none exists). No BOOKS/sharp badge on fantasy
    tabs (prizepicks excluded from REAL_BOOKS — already correct).
- Results page was ALREADY correct + live: classify() implements exactly
  the user's rule (over lean = proj>line, correct iff actual>line; under
  lean = proj<line, correct iff actual<line; |proj-line|<0.1 = skip).
  Verified vs raw DB on 12 graded HFS rows — every mark correct (e.g.
  Jordan Walker proj 8.5>line 5.5 over, actual 5.0<5.5 -> wrong; Masyn
  Winn under, actual<line -> correct). Both fantasy props already render
  in the Betting Edge section (Pitcher Fantasy 2/2, Hitter Fantasy 7/14
  on the current window). Coverage is thin only because PrizePicks line
  ingestion started 2026-05-31; it fills in automatically going forward.
- Verified: tsc --noEmit clean; npm run build passes. Board cross-check
  vs raw DB (2026-06-01): Cavalli proj 31.2 line 21.5 -> Over; Jax 17.8
  line 20.5 -> Under; Wood 10.6 line 12.5 -> Under; Abrams 10.0 line 9.5
  -> Over; Young 6.6 line 4.5 -> Over. Players with no PP line (Madden,
  Avila, Ruiz, Lopez) show nothing extra, consistent with other tabs.
  FEATURE_COLS untouched (frontend-only).

PrizePicks fantasy "alt line" bug — store the STANDARD rung (this session):
- Report: user flagged that PFS/HFS sometimes showed a wrong line (e.g.
  Shohei Ohtani HFS "Line 4.5" when his real line is ~8.5; Marte/Carroll
  similarly off). The board faithfully shows lines.line, and the `lines`
  unique key (player,prop,book,date) allows only ONE prizepicks row per
  prop/day — so the wrong value was being INGESTED, not mis-displayed.
- Root cause (probed ParlayAPI live): PrizePicks fantasy-score props ship a
  goblin/standard/demon ALT-LINE LADDER and ParlayAPI returns a RANDOM rung
  on each call (confirmed: 3 separate calls seconds apart returned Ohtani
  4.5 / 8.5 / 8.5; 18 spaced calls enumerated {4.5, 8.5, 13.5}). All rungs
  report the SAME flat payout (over 100 / under -100; effective -137/-137,
  impl 57.8%), and `dfs_normalized: true` — so NO field distinguishes the
  standard from an alt. The old lines.py dedup "keep first row" therefore
  kept whichever rung the API happened to surface that run, and the 6-7
  daily crons overwrote it with a new random rung each time.
- The standard line is the MEDIAN rung (verified: Ohtani 8.5, Trout 6.5,
  Marte 6.0, Soto 7.0, Carroll 6.5 — all = median of their 3-rung ladder).
  Rejected alternatives: (a) mode is useless — the dominant rung is random
  between two; (b) "rung closest to our projection" INVERTS the lean when
  our model disagrees with PP (Marte proj 9.1, standard 6.0, demon 10.5 ->
  closest-to-proj picks the demon 10.5 and flips over->under). Median is
  model-INDEPENDENT and correct.
- HARD CONSTRAINT: ParlayAPI free tier = 1000 credits/MONTH and EVERY
  props() call costs 3 credits (measured). The pipeline already spends
  ~21/day (7 crons x 3). So per-run multi-sampling to enumerate the ladder
  (~18 calls = 54 credits/run) is financially impossible. The fix had to be
  FREE — reuse the ONE call each cron already makes and accumulate across
  the day's runs.
- Fix (engine + DB, free):
  * db/schema.sql + db/migrations/add_observed_lines.sql: new
    `observed_lines text` column on `lines` (comma-joined distinct rungs
    seen today; NULL for non-fantasy props). MUST be run once in the
    Supabase SQL editor for the fix to activate.
  * engine/db.py: _resolve_fantasy_ladder(rows) — for prizepicks fantasy
    rows, reads the existing row's observed_lines (seeding from the existing
    `line` for legacy/pre-column rows so it SELF-HEALS from the polluted
    state), merges this run's just-observed rung into the distinct set, sets
    line = median(set) rounded to the 0.5 grid, and writes the set back to
    observed_lines. Model-independent; converges to the true standard as the
    day's runs enumerate all 3 rungs (simulated: all 6 sample players land
    on the correct standard within ~5 runs). Mid-day partial-ladder values
    are estimates, still far better than a random rung.
  * upsert_lines now calls _resolve_fantasy_ladder first, then upserts with
    a PGRST204 fallback that strips observed_lines + retries (so the
    pipeline runs cleanly BEFORE the migration is applied — verified: the
    read errors with code 42703, _resolve returns False, upsert proceeds
    single-sample as before).
  * engine/schemas.py: LineRow gains observed_lines: Optional[str].
- Frontend: NO change — the board already reads lines.line, which is now the
  standard. Results grading also reads .line, so future fantasy grades use
  the standard (already-graded past rows keep whatever rung was caught at
  grade time; not backfilled).
- Verified: median math + daily convergence simulated correct; merge wiring
  unit-tested with a mock client (accumulation, legacy-seed self-heal,
  non-fantasy untouched); pre-migration fallback confirmed against live DB;
  all engine modules import clean. FEATURE_COLS untouched.
- ACTION REQUIRED: run db/migrations/add_observed_lines.sql in Supabase.
  Until then the pipeline keeps working but fantasy lines stay single-sample
  (the old random-rung behavior).

PrizePicks-direct standard fantasy lines (this session — the real fix):
- Follow-up to the median-accumulation fix above: user showed PrizePicks'
  own board (clean standard lines, O -119 / U -119) vs our board still wrong
  for several players. Root cause confirmed: the median-of-accumulated-rungs
  approach is only exact once ALL THREE ladder rungs (goblin/standard/demon)
  are observed; with only 2 rungs caught the median is the MIDPOINT, not the
  standard (e.g. Julio observed {2.5,6.0} -> median 4.0, but 6.0 IS the
  standard; Ohtani {4.5,13.5} -> 9.0 vs real 8.5). ParlayAPI normalizes away
  the goblin/standard/demon distinction entirely (reports flat -137/+100 for
  every rung), so it can never identify the standard from a single call.
- THE FIX: read fantasy lines straight from PrizePicks' own public API
  (api.prizepicks.com/projections?league_id=2), which tags every projection
  with odds_type ('standard' | 'goblin' | 'demon'). Filtering to
  odds_type=='standard' gives the exact line DETERMINISTICALLY — no ladder
  guessing, no accumulation needed. Free (no ParlayAPI credits — critical
  given the 1000-credit/month, 3-credits-per-call budget). Verified: every
  flagged player matches the screenshots exactly (Ohtani 8.5, Soto 7.0,
  Julio 6.0, Crawford 5.0, Raley 4.5, Benge 5.5, Bichette 5.0, Marte 6.0,
  Carroll 6.5, E-Rod 22.5).
- engine/lines.py:
  * _fetch_prizepicks_standard_fantasy(name_to_id, normalized_to_id) — new.
    urllib (stdlib, no new dep) GET with a browser UA, paginates meta
    .total_pages, reads included[] new_player -> display_name, keeps
    odds_type=='standard' rows for the two fantasy stat_types, maps PP names
    to our player_ids via the same exact/normalized matching ParlayAPI uses.
    Returns {(player_id, prop_type): standard_line}. FULLY DEFENSIVE: any
    failure (network, Cloudflare block on the GitHub Actions IP, shape drift)
    prints + returns {} and the pipeline falls back to the ParlayAPI ladder +
    median accumulation — no regression.
  * fetch_prop_lines: after the ParlayAPI dedup, calls the PP-direct fetch and
    REPLACES the fantasy rows for covered players with authoritative standard
    rows (bookmaker=prizepicks, observed_lines=str(standard) as the
    authoritative marker). Players PP-direct doesn't cover keep their ParlayAPI
    row -> median fallback. Log line reports pp_applied count or
    "PrizePicks-direct unavailable -- fantasy via ladder/median".
- engine/db.py: _resolve_fantasy_ladder now SKIPS rows that already carry
  observed_lines (authoritative PP-direct) — they upsert verbatim and reset
  the day's accumulation to the true standard. Only ParlayAPI-fallback rows
  (no observed_lines) get median-merged.
- CI-reliability caveat: PrizePicks is behind Cloudflare and MAY block
  datacenter IPs (GitHub Actions). Works from local/residential IPs (verified).
  If blocked in CI the defensive fallback keeps the median-ladder behavior,
  so fantasy lines still resolve (less precisely) rather than breaking. Watch
  the cron logs for "PrizePicks-direct unavailable" to know which path ran.
- Immediate correction: ran the PP-direct fetch + upsert manually for the
  2026-06-01 slate (39 standard fantasy lines) so the live board shows the
  correct lines NOW instead of waiting for the next cron. Verified in DB:
  Ohtani 8.5 / Soto 7.0 / Crawford 5.0 / Bichette 5.0 / Raley 4.5 / Benge 5.5.
- Note: PP-direct coverage varies by time of day — PrizePicks pulls lines as
  games start, so a late run sees fewer standard rows (39 at ~00:30 UTC with
  West Coast games imminent) than a midday run. Uncovered players fall back to
  the ParlayAPI/median path. Frontend unchanged; FEATURE_COLS untouched.

Featured Plays redesign — 3 sections + AI insights (this session):
- Replaced the single top-5 Featured Plays list with THREE independently
  ranked sections (each capped at 3 cards, never padded), each with an
  AI-generated one-sentence insight per card. Frontend + a new API route;
  engine untouched.
- web/lib/types.ts: FeaturedPlay.line/edge/bookmaker/lean are now OPTIONAL
  (HR plays carry none); added parkFactor?, hrScore?, oppKRate?, insight?.
  New FeaturedSection { label, plays }.
- web/app/page.tsx getSlate():
  * FEATURED_PROPS split into FEATURED_PITCHER_PROPS ({strikeouts,
    hits_allowed, outs_recorded}) and FEATURED_HITTER_PROPS ({hitter_hits,
    hitter_total_bases}).
  * buildEdgePlays(propSet) helper — same qualification as the old featured
    build (FEATURED_BOOKS, |edge|>=0.12, line>=MIN_LINE, |proj-line|>=0.3),
    sorted by abs(edge) desc, sliced to 3. Used for sections 1 + 2.
  * Section 3 (HR MATCHUPS): from byProp["hitter_home_runs"], score =
    projection × PARK_FACTORS_HITS[home_team] (home_team parsed from the
    "Away @ Home" matchup, same as ParkTag), filter proj>0.05, sort desc,
    top 3. No edge/line — pure matchup context.
  * graded-start counts now cover all 3 sections (FEATURED_ACTUAL_COL
    extended with actual_hits / actual_total_bases / actual_home_runs; one
    player_game_logs query across both player types).
  * Returns featuredSections: FeaturedSection[] (replaces featuredPlays);
    emptyResult + future-preview path return [].
- web/app/api/featured-insights/route.ts (NEW): POST { sections } -> builds a
  compact per-play context, batches ALL plays into ONE Anthropic call
  (claude-haiku-4-5-20251001, max_tokens min(60*n,1024)), parses numbered
  responses back by index, returns { enabled, insights: {`pid|prop`: text} }.
  HR-play prompts omit edge/lean and lead with park context. Wrapped in
  unstable_cache(revalidate=1800) keyed on the play contexts so identical
  slates reuse insights and a new slate regenerates. Degrades gracefully:
  no ANTHROPIC_API_KEY -> { enabled:false, insights:{} }; any API error ->
  logged + {} (page never breaks). Uses fetch (no @anthropic-ai/sdk dep).
- web/app/FeaturedPlays.tsx (rewritten): accepts sections; on mount POSTs the
  sections (deps on a stable play-set signature, not object identity, so soft
  refreshes don't refetch) and merges insights by `pid|prop`. Renders all 3
  section headers always (thin border-t, text-[10px] uppercase tracking-widest
  slate-400); empty section shows "No qualifying plays". Card: name + prop
  label, matchup, divider, then for edge plays proj/line + lean arrow + Edge
  (book in the Edge title tooltip — the "BOOK: PINNACLE" line was removed) +
  sharp badge; for HR plays "Park ↑ 1.12 · Proj 0.12 HR" + park label, no
  badge. Insight line: animate-pulse shimmer while loading (only when a key is
  expected), AI sentence once loaded, nothing if no key. Confidence dot +
  graded-history line kept. Whole section hidden only when ALL sections empty.
- web/app/PropBoard.tsx: passes featuredSections instead of featuredPlays;
  FutureSlate path unchanged (Featured Plays absent on future-preview dates by
  construction — that path renders FutureSlate, not PropBoard).
- Verified: tsc --noEmit clean; npm run build passes (route shows as
  ƒ /api/featured-insights). Cross-checked vs live DB: pitching top-3 (Avila
  outs +0.56, Madden hits-allowed +0.48, Drohan +0.42), hitting top-3 earlier
  in the day (Schmitt/Julio/Bleday total-bases ~0.55), HR ranking proj×park
  (JJ Bleday 0.40×1.08=0.432 ranks above Dingler 0.40×0.96=0.384 — park
  weighting active, not raw proj). Dev-server render confirmed all 3 headers,
  cards, sharp badges, park labels, and a legitimate "No qualifying plays"
  for hitting when late-night line pulls leave it empty. No-key route path
  returns {enabled:false} and the page renders insight-free with no error.
- ANTHROPIC_API_KEY added to Vercel env by the user (confirmed). Without it
  the sections still render correctly; insights are simply blank.

Weekly Betting Edge trend chart on /results (Feature 6, this session):
- Adds a weekly hit-rate trend chart between the Betting Edge OverallCard and
  the per-prop breakdown. Frontend-only (data extension + new client
  component); classify() / the 7-day main window / engine all untouched.
- STEP 0 finding: recharts is NOT installed (spec assumed it was). Rather than
  add a ~500KB chart dep for one 120px chart (against the project's simplicity
  rule + zero existing chart deps), built a dependency-free Tailwind bar chart
  that matches the spec visual exactly.
- web/lib/types.ts: WeeklyBucket { week, correct, wrong, skip, rate }.
- web/app/results/page.tsx getResults(): a SECOND 42-day (6-week) window
  anchored on the same endDate as the 7-day main window. Same tables, same
  fetchAllPages pagination (1000-row cap), same BOOK_PREFERENCE reduction,
  same MIN_LINE floor, same classify() — scoped to the 5 Betting Edge props
  (MIN_LINE keys) to keep the fetch lean. Buckets by ISO week via
  startOfISOWeek() (UTC Monday, server-TZ-independent); omits weeks with
  correct+wrong==0; sorts ascending. Returns weeklyTrend: WeeklyBucket[].
  TREND_LOOKBACK_DAYS=42. [results-diag] logs the evaluable-week count.
- web/app/results/ResultsTrendChart.tsx (new client component): one bar per
  week, height = hit rate %; dashed 50% reference line + faint 25/75 gridlines;
  y-axis 0–100% every 25%; x labels "MMM D" (parsed as local midnight so no
  TZ day-shift); bar color emerald>=55% / amber 45–55% / slate<45%; hover
  tooltip "Week of <date>: N correct, M wrong — X% hit rate". <2 buckets ->
  "Trend builds as more graded slates accumulate" placeholder (no single-bar
  glitch); 0 buckets -> null.
- web/app/results/ResultsBoard.tsx: accepts weeklyTrend, renders
  <ResultsTrendChart> between OverallCard and per-prop card. The chart is the
  FULL unfiltered trend — prop/game filter chips don't touch it.
- Verified: tsc clean; npm run build passes. Live DB (42-day window
  2026-04-21..2026-06-01): exactly 1 evaluable week (2026-05-25: 43 correct /
  21 wrong / 3 skip -> 67%), which MATCHES the live OverallCard (67%, 43/21/3)
  — confirms the trend join is consistent with the main path. With 1 week the
  placeholder renders (confirmed on dev server); the bar chart activates
  automatically once a 2nd week accumulates. 7-day main results unchanged.

Featured Plays hit-rate row on /results (this session):
- A single "Featured Plays" row added to the Betting Edge "By prop type" card
  (BettingPerPropCard) — SAME row UI as Strikeouts/Hits Allowed/etc. (label +
  muted subtitle "high-edge subset" + correct/evaluable + rate%). NOT a
  separate section (an earlier attempt at a full section was scrapped per the
  user — they wanted just the one row in the existing card).
- The row aggregates featuredResults: the high-conviction subset matching the
  home board's Featured Plays criteria (buildEdgePlays in web/app/page.tsx):
  prop ∈ {strikeouts, hits_allowed, outs_recorded, hitter_hits,
  hitter_total_bases}, |edge| >= FEATURED_MIN_EDGE (0.12), |proj-line| >=
  FEATURED_MIN_LEAN (0.3), REQUIRES MIN_LINE (same as bettingResults +
  buildEdgePlays), same BOOK_PREFERENCE + classify(). HR matchups never count.
- KEY FINDING (the reason for requiring MIN_LINE): MIN_LINE has no entry for
  hitter_hits/hitter_total_bases, so — exactly like the board's HITTING EDGES
  section, which is structurally always empty — those props never qualify here
  either. So featuredResults is pitcher-only in practice, a STRICT SUBSET of
  bettingResults (verified: 22 featured of 67 betting; an earlier "apply
  MIN_LINE only where defined" variant ballooned to 328 rows / 93% un-featured
  hitter plays, which would have been misleading — rejected).
- web/app/results/page.tsx getResults(): added ONE edges fetch (paginated, 7-day
  window, scoped to the featured props) — the de-vigged |edge| lives ONLY in the
  edges table and the main betting join is line-based, so the |edge| gate
  genuinely needs it (the spec's "no new query" was not achievable). Builds
  featuredResults by reusing the existing linesByKey/logsByKey + edgeByKey;
  returns it alongside bettingResults. [results-diag] logs the featured count.
- web/app/results/ResultsBoard.tsx: BettingPerPropCard takes featured:
  EvaluatedResult[] and renders the aggregate row first in the list. The chips
  do NOT filter it (always the full featured set).
- Verified vs live DB (2026-05-26..06-01): Featured Plays row = 12/22 = 55%
  (strikeouts 7/7, hits_allowed 4/3, outs 1/0); strict subset of 67 betting.
  classify(), bettingResults, Model Tracker, the weekly-trend chart, engine,
  FEATURE_COLS all unchanged. tsc clean; build passes.

Whiff%/CSW% feature swap — INTENTIONAL model change (this session):
- Swapped the two highest-signal strikeout predictors INTO FEATURE_COLS and
  dropped two weak ones. Predictions WILL change — that's the point, not a bug.
- FEATURE_COLS held at EXACTLY 11: added pitcher_whiff_pct_30d +
  pitcher_csw_pct_30d; removed last5_k_rate (high-variance on tiny samples,
  subsumed by last30 + whiff) AND pitcher_fastball_pct (only crudely proxies
  the swing-and-miss whiff/CSW measure directly). NOTE the prompt's arithmetic
  (add 2, drop 1) = 12; to honor "exactly 11" a SECOND drop was required —
  fastball_pct per the stated weak-feature ranking.
- COLUMN NAMES: the live DB columns are pitcher_whiff_pct_30d /
  pitcher_csw_pct_30d (PREFIXED), not the un-prefixed names in the prompt.
  FEATURE_COLS uses the prefixed names so train() (get_game_logs select("*"))
  reads the real stored values.
- grade.py ALREADY logs both at grade time (_pitcher_platoon_30d). The gap was
  PREDICT time: _build_pitcher_features_from_df didn't compute them, so without
  the fix every prediction would have gotten the imputed constant. Added the
  predict-time computation from the bulk Statcast df using grade.py's EXACT
  definitions — whiff% = whiffs/swings (whiffs = swinging_strike/_blocked;
  swings += foul/foul_tip/hit_into_play), CSW% = (called_strike + whiffs)/
  pitches. Strict-prior (the bulk 30d window excludes today's unplayed game).
- _CONTEXT_DEFAULTS: dropped pitcher_fastball_pct; added whiff 0.22 / CSW 0.27
  (live-pool means — these are grade.py's per-SWING/per-pitch rates, NOT the
  ~0.11 per-pitch SwStr% the prompt guessed). train() imputes nulls; predict()
  setdefault fills them for the legacy _build_pitcher_features fallback (which
  still returns a valid 11-vec).
- Verified end-to-end: FEATURE_COLS = exactly 11 (last5 + fastball_pct gone,
  whiff + csw in); train() on 60 rows -> all NaN counts 0 after imputation,
  XGBoost fits; predict-time whiff/CSW VARY across pitchers (8 distinct, 0.06-
  0.36, not the 0.22 constant -> predict wiring confirmed); cross-check EXACT
  vs direct statcast_pitcher 30d (pid 670280: model 0.328/0.275 = direct
  0.328/0.275); python engine/main.py clean in refresh mode; predict() runs
  end-to-end with the 11-feature vec (real K projections, no shape error).
- Design note (deferred, per the matchup-baseline discussion): the next real
  step is a deterministic batter-by-batter matchup-expected-K BASELINE (posted
  lineup x per-batter K% x platoon x logged whiff/CSW), blended into the
  rolling baseline — NOT another XGBoost feature (a near-complete causal
  estimate as a feature is gated on the training pool exactly like everything
  else; as a baseline it contributes full signal day one). Validate as a
  baseline on calibration + realized edge. Skip raw zone-location (collinear
  with whiff once it's in) and the pitch->PA->start rebuild (gated on data).

Feature liveness audit + matchup-K shadow baseline (this session):

PART A — FEATURE LIVENESS AUDIT (report only, no code changed):
- Ran the predict-time feature build across 18 of today's starters and checked
  each of the 11 FEATURE_COLS for distinct values + whether every pitcher got
  the imputed _CONTEXT_DEFAULTS constant.
- FINDING: exactly ONE dead feature — lineup_lhh_pct. All 18 starters got 0.42
  (distinct values = [0.42]); it's HARDCODED to 0.42 in
  _build_pitcher_features_from_df ("only knowable once lineups post") while
  grade.py logs the real value at grade time. So it VARIES in training but is
  CONSTANT at inference — the same train/predict skew we fixed for whiff/CSW;
  it's dead weight (1 of XGBoost's 11 inputs is a constant at predict).
- All other 10 are live (vary across pitchers). park_factor_k showed only 2
  distinct today but that's slate-coincidental (most parks neutral), not
  structural — it's live. NO CHANGES MADE; a lineup_lhh_pct fix (compute it at
  predict from today's posted lineup, like matchup-K does) is a separate
  future task.

PART B — MATCHUP-EXPECTED-K BASELINE (SHADOW MODE):
- Deterministic batter-by-batter expected-K, computed + LOGGED per start but
  NEVER the live projection/edge/blend. It's prior knowledge (doesn't train,
  can't overfit), shadowed until its calibration is validated against actuals.
- engine/matchup_k.py (NEW, pure math, prop-agnostic per-PA core):
  expected_K = Σ over 9 posted batters of log5(regressed batter K%, pitcher
  K%/PA) × platoon × expected_PAs(slot). Named, documented PRIORS:
  K_PCT_REGRESSION_PA=50 (the one most likely miscalibrated — shrinks a
  12-PA/5-K hitter from 0.417 -> 0.258 toward league 0.22), CSW_TO_K_SLOPE,
  W_STUFF_CSW=0.6/W_STUFF_RECENT=0.4 (EDGE DESIGN — lean on FAST whiff/CSW so
  it can diverge from a slow line), bounded PLATOON_SAME/OPP_HAND, SLOT_PA_CURVE
  scaled by expected IP. NO DOUBLE-COUNT: standalone in shadow; at flip-time it
  becomes primary with the rolling average demoted to a light regularizer (NOT
  50/50).
- engine/main.py: _run_matchup_shadow(starters, games) runs AFTER the hitter
  pipeline (needs the OPPOSING posted lineup; no-ops on morning runs).
  Gathers recency-weighted pitcher K%/PA + expected IP (get_pitcher_starts),
  recent CSW (db.get_latest_pitcher_csw), throws (fetch._fetch_handedness_by_id),
  and per-batter recent K%/PA (get_hitter_games) + bats per slot, computes
  matchup-K, and does a TARGETED update of projections.matchup_expected_k.
  Wrapped in try/except so it never affects the real pipeline. Diagnostic logs
  matchup-K vs baseline (verified they DIVERGE: Cavalli 6.86 vs 5.4, Richardson
  1.41 vs 3.7 — not consensus-replication).
- engine/db.py: update_matchup_expected_k (per-row UPDATE of ONLY the shadow
  column, PGRST204 strip-and-skip pre-migration) + get_latest_pitcher_csw.
- db/schema.sql + db/migrations/add_matchup_expected_k.sql: new nullable
  projections.matchup_expected_k. ACTION REQUIRED: run that migration in
  Supabase — until then the step computes + logs but the write PGRST204-skips
  (verified).
- engine/_validate_matchup_k.py (NEW, standalone): joins matchup_expected_k to
  actual_strikeouts + the book line and reports, for BOTH matchup-K and the
  current baseline, (a) calibration in the line region (reliability of P(over),
  not MAE) and (b) realized edge on divergences (when leans disagree, who won).
  Notes ~60 starts is a sanity check, not enough to tune priors. Runs clean
  now and reports the pre-migration/no-data state gracefully.
- Verified: FEATURE_COLS still EXACTLY 11, matchup_expected_k never in it;
  python engine/main.py clean (edges still 554, no change to displayed
  projection/edge); hand-check EXACT (Griffin Jax 9-batter breakdown sums to
  3.64 = compute()); small-sample regression confirmed (0.258); PGRST204
  pre-migration path works. SHADOW ONLY — flipping to primary is a separate
  future step gated on the validation scaffolding.

lineup_lhh_pct now LIVE at predict — resolves PART A dead feature (this session):
- INTENTIONAL model change: the feature PART A flagged as dead-at-inference
  (hardcoded 0.42 in _build_pitcher_features_from_df) now computes its real
  value from the OPPOSING posted lineup. Post-lineup pitcher predictions shift —
  expected. FEATURE_COLS unchanged at exactly 11 (no add/drop; an existing slot
  made live). matchup_expected_k stays out of FEATURE_COLS.
- Ordering fix = option (a): fetch lineups BEFORE the pitcher pipeline.
  main._opposing_lineup_lhh(starters) fetches fetch_lineups() once, splits by
  side, calls fetch.compute_lineup_handedness PER SIDE, and maps each starter to
  the team it FACES (home pitcher → away lineup, away pitcher → home lineup) ->
  {player_id: lhh_pct}. Threaded through _run_pitcher_pipeline into
  mlb_model.predict(..., lineup_lhh_by_pid=...).
- predict() OVERRIDES the 0.42 placeholder with the real value when present;
  stays 0.42 only when no lineup is posted (morning runs / unconfirmed game) —
  a genuine "no lineup yet" fallback, not a permanent hardcode. The legacy
  _build_pitcher_features fallback path also benefits (override before the
  _CONTEXT_DEFAULTS setdefault).
- DEFINITION matches grade.py exactly: opposing starting nine, lhh =
  Σ(L=1.0 / S=0.5 / R=0.0)/n, round 3 (compute_lineup_handedness uses the same
  weighting; minor edge case — it defaults unknown bats to R while grade skips
  them, negligible because fetch_lineups backfills all bats via /people). So the
  trained weight applies correctly.
- PRODUCTION TIMING CAVEAT: the pitcher predict runs in FULL mode (first run of
  the day, morning) when lineups aren't posted -> 0.42; afternoon runs are
  refresh-mode and SKIP the predict. So in steady state the DISPLAYED strikeouts
  projection still uses 0.42 UNLESS a predict happens post-lineup (manual run,
  stale rebuild — one fired during this session's verify run and the feature
  went live: "using real opposing-lineup handedness for 18 starters"). Making it
  live for the displayed projection on every slate would need a post-lineup
  re-predict step (like matchup-K); out of scope here. The fix resolves the
  STRUCTURAL hardcode and makes the feature live whenever predict runs.
- Verified: FEATURE_COLS still 11; lineup_lhh_pct went from 1 distinct value
  (DEAD) to 8 distinct across 18 starters (LIVE); hand-check EXACT (Griffin Jax
  opp lineup R:5/L:3/S:1 -> 0.389 = predict value, matches grade.py); no-lineup
  -> 0.42 cleanly; train() 0 NaN after imputation; python engine/main.py clean
  (exit 0; the live predict log appeared + rebuilt 18 strikeout projections).

Next: ongoing — let the cron run, accumulate data, monitor Actions logs for
WARNING lines.

## Keeping this file current
At the end of each session, update the "Current status" section and record any
new decisions or conventions, so the next session stays in sync.