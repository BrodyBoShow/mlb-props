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

datetime cleanup + PrizePicks-direct proxy support (this session):
- PART A (datetime deprecation): grep found exactly ONE datetime.utcnow() —
  engine/main.py:671, the run-header print. It's .strftime('%Y-%m-%d %H:%M')
  with NO %z, so swapping to datetime.now(timezone.utc) renders a byte-
  identical log string (tz-aware object, but tzinfo never printed). No
  isoformat/comparison consumers, so zero behavior change. Added `timezone`
  to the datetime import. Verified: no datetime.utcnow() remains; pipeline
  header unchanged; no DeprecationWarning.
- PART B (PrizePicks-direct proxy): _fetch_prizepicks_standard_fantasy gets
  HTTP 403 from GitHub Actions' datacenter IP (Cloudflare), so production
  falls back to the imprecise ladder/median path. Fix (stdlib urllib, no new
  dep):
  * _PP_HEADERS: realistic browser headers (User-Agent + Accept +
    Accept-Language + Origin + Referer) — a free header-based-block defeat;
    likely insufficient against an IP block but harmless.
  * PRIZEPICKS_PROXY_URL env var (http://user:pass@host:port). When set, ONLY
    this request routes through a DEDICATED urllib opener
    (build_opener(ProxyHandler(...))) — never a global proxy, so other urllib
    traffic is unaffected. When unset, behaves exactly as a direct request
    (urlopen).
  * Distinct path logging: "PrizePicks-direct standard (direct)|via proxy:
    N lines" on success; "PrizePicks-direct unavailable (HTTP {code}) {via}
    -- ladder/median fallback" on HTTPError; same for other errors. Makes the
    next cron log show at a glance whether the proxy worked.
  * Fallback chain UNCHANGED: PP-direct (proxied if var set, else direct) ->
    ParlayAPI ladder/median -> never crash. PRIZEPICKS_ONLY_PROPS unchanged.
  * Verified: unset -> direct path works locally (201 standard lines, "(direct)"
    log); bad proxy -> routes through ProxyHandler (connection-refused proves
    it) + graceful {} fallback with "via proxy" log; Accept-Language attached;
    python engine/main.py clean both ways.
- USER ACTION (Part B): add PRIZEPICKS_PROXY_URL (a RESIDENTIAL proxy) to the
  GitHub Actions repo secrets AND to refresh.yml's env block. Until then CI
  runs exactly as today (direct -> 403 -> median fallback). The real CI proof
  is the next post-lineup cron log showing "via proxy" instead of the 403.

Featured Plays HITTING EDGES populated — MIN_LINE floor fix (this session):
- DIAGNOSED (per-stage drop counter vs live DB, 2026-06-02 post-lineup) why the
  board's HITTING EDGES section was always empty. TWO distinct causes:
  * hitter_total_bases: 183 edges, 179 real-book (pinnacle posts two-sided TB
    lines), 170 clear |edge|>=0.12 (magnitudes up to 0.55) — then ALL dropped at
    buildEdgePlays' `lineMin === undefined` check because the shared MIN_LINE has
    NO hitter_total_bases entry. The floor stage zeroed them; 88 would surface
    with a real floor + the |proj-line|>=0.3 gate.
  * hitter_hits: 114 edges but ALL bookmaker='consensus' (pinnacle posts no
    two-sided hitter_hits line, so edge.py emits only the synthetic consensus
    baseline) -> dropped EARLIER, at the FEATURED_BOOKS filter. A floor fix
    can't help this one; deliberately NOT forced in (broadening books would
    change the protected PITCHING section + risks the hitter under-lean bias).
- FIX (frontend-only, a Featured-Plays-specific floor — kept SEPARATE from the
  shared MIN_LINE, exactly like SHARP_MIN_LINE):
  * web/lib/constants.ts: new FEATURED_MIN_LINE { strikeouts 3.5, hits_allowed
    2.5, outs_recorded 10.5, hitter_hits 0.5, hitter_total_bases 1.5 }. Pitcher
    values IDENTICAL to MIN_LINE (PITCHING EDGES unchanged); hitter values are
    each prop's real main market (TB 1.5; 0.5 is the alt. hits 0.5 = 1+ hit).
  * web/app/page.tsx buildEdgePlays: uses FEATURED_MIN_LINE instead of MIN_LINE
    (MIN_LINE import removed — unused). The shared MIN_LINE (/results Betting
    Edge + the featured-row + sharp badge floors) is untouched.
- VERIFIED: qualifying hitter plays 0 -> 34 (all hitter_total_bases; hitter_hits
  stays 0 as diagnosed). Top 3 surface: Ezequiel Duran 0.55 / Ben Rice 0.55 /
  Miguel Vargas 0.53 (all pinnacle, line 1.5, OVER). Cross-checked Duran vs raw
  DB: pinnacle two-sided 1.5 TB line (+152/-206) -> fair_over 0.371, model_over
  0.923 (proj 2.0), edge 0.553 — legitimate, de-viggable, real-book. tsc clean;
  npm run build passes. PITCHING/HR/classify()/engine/FEATURE_COLS unchanged.
- KNOWN (not changed): the /results "Featured Plays" hit-rate row still uses the
  shared MIN_LINE (pitcher-only), so it won't yet count the new hitter_total_bases
  featured plays. A board↔results alignment (point both at FEATURED_MIN_LINE) is
  a clean follow-up but out of this task's scope (board section only).

/results Featured row unified with the board (FEATURED_MIN_LINE + REAL_BOOKS):
- Goal: the board (page.tsx buildEdgePlays) now qualifies featured hitter plays
  via FEATURED_MIN_LINE, but the /results "Featured Plays" hit-rate join still
  used the shared MIN_LINE (pitcher floors only) -> the 34 board hitter_total_
  bases plays weren't counted. Align the two definitions.
- The task scoped this to "switch the floor only," BUT the diagnostic showed
  featuredResults was ALSO missing the FEATURED_BOOKS filter the task assumed it
  had. Switching only the floor surfaced the 35 hitter_total_bases (good) but
  ALSO leaked 52 hitter_hits plays the board NEVER features (all hitter_hits
  edges are bookmaker='consensus' — pinnacle posts no two-sided hits line — and
  the board's FEATURED_BOOKS drops consensus). So floor-only FAILED the "same
  prop/player rows" requirement. Fixed BOTH, entirely within the featured row:
  * web/app/results/page.tsx featuredResults floor: MIN_LINE -> FEATURED_MIN_LINE
    (the same map buildEdgePlays uses; shared MIN_LINE for Betting Edge untouched).
  * Its edges fetch now also selects `bookmaker`; edgeByKey only keeps edges
    whose bookmaker is in REAL_BOOKS (= FEATURED_BOOKS). consensus baselines
    (hitter_hits, the 1 stray consensus strikeout) are dropped, matching the board.
- VERIFIED (2026-06-02, paginated): /results Featured selection 38 (pitcher-only)
  -> 73; board buildEdgePlays selection 72; overlap 72, only-board 0, only-results
  1 (a benign line-source residual — the board grades vs the EDGE's line while
  /results uses the BOOK_PREFERENCE line). Ezequiel Duran hitter_total_bases
  (proj 2.0 vs 1.5) now in BOTH; hitter_hits = 0 in both. Betting Edge hit-rate
  byte-identical (bettingResults uses MIN_LINE, never reads edgeByKey). tsc clean;
  npm run build passes. Grading lag: today's hitter plays are mostly ungraded, so
  the row counts them as they grade, not retroactively (expected, not backfilled).
- Sim gotcha re-learned: a verification using .limit(50000) silently truncated at
  Supabase's 1000-row cap and dropped Duran (beyond the first 1000); only .range()
  pagination (fetchAllPages, which the real /results uses) returns the full set.

HR-card dynamic situational display — wind vector + sweet-spot (this session):
- Upgraded the Featured Plays "HR MATCHUPS" cards from a static park tag to two
  dynamic, DISPLAY-ONLY situational readouts. NOT model inputs — FEATURE_COLS
  stays 11; no projection / edge / classify() math changed; the HR projection
  number on each card is byte-identical (only NEW context fields were added).
- STEP-0 finding (the task assumed "frontend-only"): the data the cards needed
  was NOT reachable by the frontend for today's games. Wind is fetched only at
  GRADE time into player_game_logs (and only as a compass abbr, not degrees),
  with OPENWEATHER_API_KEY; sweet-spot/EV lived only in model.py's in-memory
  bulk_df. So delivering either tag required an engine→DB(migration)→frontend
  pipeline. User chose full pipeline; OPENWEATHER_API_KEY already in CI secrets.
- PRE-REQ — PARK_ORIENTATION (engine/constants.py + web/lib/constants.ts mirror,
  keep in sync): home-plate→CF compass bearing (0=N) per venue, display-only.
  Per the task's "DO NOT guess" rule, ONLY the two parks with an authoritative
  published reference are populated — Boston/Fenway 45°, Chicago Cubs/Wrigley
  30° (the task's own anchors). The other 29 entries (incl. the 8 domes, where
  bearing is moot) are null → the wind tag degrades to the static park label for
  those venues. Authoritative numeric azimuths for the rest aren't on any
  fetchable source (Baseball Almanac is quadrant-only + unreliable; Clem's site
  has a broken TLS cert; archive.org blocked). FOLLOW-UP: fill the nulls from a
  satellite-derived measurement pass; the pipeline lights up per-park as each
  bearing lands.
- SUB-CHANGE A — wind vector tag (replaces the "Neutral/Hitter-friendly park"
  line on HR cards):
  * engine/weather.py: get_game_weather now also returns wind_dir_deg (raw OWM
    meteorological FROM degrees; the existing wind_dir compass is derived from
    the same value). schemas.WeatherFields gains wind_dir_deg.
  * engine/main.py: new _run_game_weather(games) — fetches today's wind per game
    (dome → wind 0 / is_dome True) and writes {wind_speed_mph, wind_dir_deg,
    is_dome} to the games table via db.update_game_weather (targeted per-game
    UPDATE, PGRST204 strip-and-skip, mirrors update_matchup_expected_k). Runs
    EVERY cron tick (full + refresh) so wind stays fresh; wrapped in try/except
    so weather flakiness never touches projections. _parse_start_time helper
    converts games.start_time ISO → naive-UTC datetime for the forecast bucket.
  * db/schema.sql + db/migrations/add_game_weather.sql: games gains
    wind_speed_mph, wind_dir_deg, is_dome (nullable). ACTION REQUIRED: run it.
  * web/app/page.tsx getSlate(): ISOLATED, failure-tolerant games-wind query
    (NOT joined into the main select — a missing column would 400 the board);
    windByGame map attached to HR plays (windSpeed/windDirDeg/isDome/homeTeam).
  * web/app/FeaturedPlays.tsx windTag(): OWM gives the FROM direction, so we add
    180 to get the blowing-TOWARD bearing, then rel = normalize(toward - park
    bearing) to (-180,180]. |rel|<=45 → OUT (green ↑, sub LF/CF/RF by sign),
    |rel|>=135 → IN from CF (red ↓), else CROSS (slate →, to LF/RF). Graceful
    degrade precedence: dome → "Dome · neutral"; no wind OR null bearing OR null
    deg → static park label; wind < 5 mph → park label + "· calm".
- SUB-CHANGE B — sweet-spot footer (replaces "N games tracked" on HR cards ONLY):
  * engine/sweet_spot.py (new): compute_sweet_spot(bulk_df, player_ids, proj_date,
    window_days=7, min_bbe=5) → {pid: {sweet_spot_pct, avg_exit_velo,
    batted_balls}} from the SAME bulk Statcast frame the pitcher predict already
    fetched (no extra API call). Sweet-spot = BBE with launch_angle in [8,32]
    (Statcast's real definition, NOT 25-35 the barrel window); BBE = rows with
    both launch_angle + launch_speed measured. Hitters with < 5 BBE (or no
    frame) are omitted → footer degrades.
  * engine/main.py: _run_pitcher_pipeline now returns bulk_df (4-tuple; None on
    the refresh skip path); threaded into _run_hitter_pipeline →
    _build_and_upsert_hitters, which attaches sweet_spot_pct/avg_exit_velo to
    the hitter_home_runs rows before upsert. None bulk_df (refresh runs) → no
    sweet-spot that run; existing rows keep prior full-run values.
  * db.upsert_projections: sweet_spot_pct + avg_exit_velo added to
    _PROJECTION_OPTIONAL_COLS (PGRST204 strip-and-retry pre-migration).
    schemas.ProjectionRow + db/schema.sql + db/migrations/add_sweet_spot.sql
    (projections gains the two nullable cols). ACTION REQUIRED: run it.
  * web/app/page.tsx: ISOLATED sweet-spot query (hitter_home_runs rows) →
    sweetByPlayer map → HR plays. FeaturedPlays.tsx SweetSpotLine renders
    "🔥 7-day: 95.1 avg EV · 38% sweet-spot" (text-[10px] uppercase slate-400);
    only when sweetSpotPct + avgExitVelo present, else ConfidenceLine.
  * web/lib/types.ts FeaturedPlay gains homeTeam?/windSpeed?/windDirDeg?/isDome?/
    sweetSpotPct?/avgExitVelo? (all optional, all display-only).
- VERIFIED:
  * Wind math (deterministic): task's worked example (blowing toward 270° = OWM
    FROM 90°, CF bearing 45°) → rel -135° → IN, matches the spec; tailwind→OUT,
    headwind→IN, perpendicular→CROSS all correct. End-to-end with a mocked OWM
    forecast: wind FROM 225° / 8 m/s at Fenway (bearing 45) →
    get_game_weather wind_dir_deg=225.0, wind_speed_mph=17.9 → windTag
    "↑ 18 mph Out to CF" (toward 45 == bearing 45 → rel 0, straight tailwind).
  * Sweet-spot (synthetic frame): 6 BBE, 3 in [8,32] → 0.5, avgEV correct;
    old-window + foul (null launch) rows excluded; a < 5-BBE hitter dropped;
    empty/None frame → {} (graceful).
  * Pre-migration full pipeline run: EXIT 0, weather step logs "missing weather
    columns -- skipping wind write" + "wrote wind to 0 games" (graceful degrade),
    projections untouched. Engine import clean; FEATURE_COLS still 11.
  * Frontend: tsc --noEmit clean; npm run build passes (/ still ƒ, 9.55 kB).
  * Dome → "Dome · neutral"; null-bearing open-air park (e.g. Yankees) → static
    park label, both confirmed.
- ACTION REQUIRED (one-time, Supabase SQL editor):
  run db/migrations/add_game_weather.sql AND db/migrations/add_sweet_spot.sql.
  Until then the pipeline runs cleanly (PGRST204 strip/skip) and both tags
  degrade to the current static labels.

PARK_ORIENTATION filled — 22 parks from the MLB venue feed (this session):
- Data-population follow-up to the HR-card wind tag. Filled the open-air park
  home-plate→CF bearings in PARK_ORIENTATION (engine/constants.py AND
  web/lib/constants.ts, kept identical). No logic/schema/model change — only the
  constant. FEATURE_COLS untouched; windTag/sweet_spot/pipeline untouched.
- SOURCE (better than the task's literal "eyeball CF coords off satellite"
  method): the MLB Stats API venue feed has a `direction` field = the compass
  azimuth (0=N, clockwise) from home plate toward CF. Pulled it from a public
  mirror of the feed (benelsen gist of the MLB venues CSV). Used `direction`
  directly rather than computing from CF coords — it IS the derived bearing.
- ANCHOR BACK-CHECK (the gate): Fenway `direction`=45 → EXACT match to the known
  45° anchor (proves `direction` is the home→CF azimuth). Wrigley=37 (NNE) — the
  task's "~30°" hint was approximate; 37 is the authoritative value, same
  quadrant. Method validated, so used the feed for all parks. (Wrigley updated
  30→37 to match the authoritative source.)
- FORBIDDEN-ARC CHECK (no MLB park faces 150°–315°): every populated value lands
  in [0,149] ⊂ the legal arc. ONLY Detroit (Comerica feed=151°, 1° into the
  forbidden arc) was flagged → left null for manual review rather than writing a
  suspect SSE value. The higher legal values (PNC 116, GABP 123, Rate 127,
  Truist 149) are real SE/SSE riverfront/skyline orientations, not errors.
- POPULATED (22): ATL 149, BAL 31, BOS 45*, CHC 37*, CWS 127, CIN 123, CLE 359,
  COL 5, KC 47, LAA 44, LAD 25, MIN 90, NYM 14, NYY 75, OAK(Oakland Athletics)
  56, PHI 9, PIT 116, SD 0, SF 85, SEA 49, STL 62, WSH 29. (* = anchor.)
  Seattle (retractable) populated per the task (valid roof-open).
- LEFT NULL (9): 7 fixed/closed-roof domes intentionally skipped (Arizona,
  Houston, Miami, Milwaukee, Tampa Bay, Texas, Toronto — wind never reaches the
  field, frontend shows "Dome · neutral"); Detroit (forbidden-arc, flagged); and
  "Athletics" = Sacramento/Sutter Health Park (2025+ relocation, not in the
  venue feed yet — "Oakland Athletics" legacy key carries the Coliseum 56).
  FOLLOW-UPS for the user: confirm/measure Comerica + Sutter Health Park.
- VERIFIED: the two files' PARK_ORIENTATION maps are byte-identical (31 keys,
  same values — scripted compare); python -c "import engine.constants" clean
  (22 populated); npx tsc --noEmit clean; npm run build passes. No other file
  touched.

PARK_ORIENTATION — Detroit + Sacramento filled (this session):
- Populated the two parks the bearings pass had flagged/left null. Data-only
  change to PARK_ORIENTATION in BOTH engine/constants.py and web/lib/constants.ts
  (kept byte-identical). No logic/schema/model/other-file change.
- Detroit (Comerica Park) = 151°: the MLB feed value tripped the 150°–315°
  forbidden-arc heuristic by 1°, but Comerica is a confirmed real-world SSE
  outlier — 151° is correct. Populated (technically inside the heuristic arc; the
  guard was a sanity check, Comerica is the documented exception).
- "Athletics" = 330°: the A's play 2025–26 home games at Sutter Health Park,
  West Sacramento (NOT the Coliseum). CF points NNW (~330°, just past 315° → a
  rare but valid orientation, OUTSIDE the forbidden arc). RESOLUTION CONFIRMED:
  the HR card derives homeTeam from games.home_team, and fetch.fetch_games sets
  home_team = statsapi home_name = "Athletics" for the relocated club — so a 2026
  A's home game resolves through the "Athletics" key and now gets 330°, not 56°.
  The "Oakland Athletics" key (Coliseum 56°) is retired in place — no current
  game resolves to it (kept only as a historical value).
- Populated count now 24 (was 22). Null is now ONLY the 7 fixed/closed-roof
  domes (Arizona, Houston, Miami, Milwaukee, Tampa Bay, Texas, Toronto).
- VERIFIED: the two maps are byte-identical (31 keys, same values — scripted
  compare, 0 diffs); python -c "import engine.constants" clean (24 populated);
  npx tsc --noEmit clean; npm run build passes. Forbidden-arc validation: 330°
  outside [150,315]; 151° the confirmed Comerica exception.

HR MATCHUPS smart selection — composite ranking (this session):
- Replaced the HR-section SELECTION ranking. OLD: hrScore = projection ×
  PARK_FACTORS_HITS[home] (near-flat proj × static park → cards didn't
  differentiate). NEW: a composite ranking heuristic. Frontend-only selection
  change — NOT a model feature (FEATURE_COLS stays 11, model byte-identical),
  NOT a calibrated probability, NOT an edge. Does NOT change the displayed HR
  projection (still h.projection — verified byte-identical), does NOT touch
  PITCHING/HITTING EDGES, buildEdgePlays, classify(), or any edge math.
- COMPOSITE (web/lib/hrComposite.ts): score = projection × windAdjPark ×
  powerFactor × platoonFactor. Each factor is a bounded multiplier around 1.0
  that DEGRADES TO 1.0 when its data is missing — so with no extra data the
  composite reduces EXACTLY to the old projection × parkFactor ranking (verified:
  OLD top-3 == NEW top-3 today, since power/platoon are currently degraded).
  Named, tunable weights in web/lib/constants.ts HR_COMPOSITE (WIND_WEIGHT 0.25 /
  WIND_STRONG_MPH 15, POWER_WEIGHT 0.30 + sweet/EV floor→elite refs, PLATOON_
  WEIGHT 0.12).
  * windAdjPark: park hit-factor scaled by today's wind. REUSES the Phase-1 wind
    math — extracted to web/lib/wind.ts as windRelativeAngle() + windBucket() +
    windParkMultiplier(); FeaturedPlays.windTag() now imports the SAME helpers
    (no duplicate wind implementation). Tailwind out → scale up, headwind in →
    down, cross/calm/dome → park factor unchanged.
  * powerFactor: recent batted-ball quality (sweet_spot_pct + avg_exit_velo, the
    same Statcast data the sweet-spot footer uses), normalized floor→elite.
  * platoonFactor: hitter bats vs opposing SP throwing hand (favorable +W, same-
    hand −W, switch favorable). Sourced via TWO isolated, failure-tolerant reads
    in page.tsx getSlate (games starters + players bats/throws/team) — no new
    external fetch, pre-existing schema (no migration gating). Hitter side =
    players.team vs games.home/away_team → opposing starter → its throws.
  * opp-SP HR vulnerability: OMITTED — not logged on the hitter row anywhere
    (player_game_logs has opp_sp_k/era/whip but no HR/9, and not on projections).
    Documented as a future add (would need an engine/schema change).
- HONESTY GUARDS honored: a missing term degrades THAT hitter's factor to neutral
  (never drops the hitter, never fabricates). The card copy / AI insight are
  unchanged and still say HR cards have "NO betting line or edge" — the composite
  is internal (never shown as a number, never passed to the AI).
- CURRENT LIVE STATE (2026-06-02 slate, 158 HR candidates): wind LIVE for 43
  (reorders the mid-pack — e.g. Schwarber 0.42→0.368 on a −12% headwind, Joc
  Pederson 0.294→0.241 −18%); power DEGRADED (add_sweet_spot.sql applied but
  values null until a FULL run computes sweet-spot — refresh runs skip it);
  platoon DEGRADED (players.team AND probable-pitcher throws are None — the known
  lookup_player bio-field gap). So today the composite = old ranking + wind. It
  progressively sharpens as a full run populates sweet-spot and as probable-
  pitcher throws / hitter team get enriched (a known follow-up). Illustrative
  check (injecting power+platoon) confirmed the full composite reorders sensibly
  — JJ Bleday (0.40 proj, elite contact + hitter park + favorable platoon) leaps
  Acuña (0.60 proj, poor contact).
- VERIFIED: FEATURE_COLS still 11 (printed); engine imports clean; tsc --noEmit
  clean; npm run build passes; displayed HR proj byte-identical; PITCHING/HITTING
  selections unchanged. Future adds: enrich probable-pitcher throws + hitter team
  (lights up platoon); add opp-SP HR/9 (the omitted 4th term).

HR composite — probable-pitcher bio fix + min-sample guard + sweet-spot finding:
- PART A (commit 6e6b9e8) — probable-pitcher team/bats/throws now resolve, so the
  HR-composite platoon term works. ROOT CAUSE (diagnosed): statsapi.lookup_player
  returns batSide/pitchHand=None and a nameless currentTeam ({'id':139}), so
  _resolved_schedule's records had null team/bats/throws. FIX (engine/fetch.py):
  keep lookup_player for name→id resolution ONLY; backfill bio in ONE bulk MLB
  /people call inside _resolved_schedule (lru_cached → once per date, shared by
  fetch_games/fetch_starters/fetch_probable_pitchers/fetch_starters_for_date).
  REUSED the existing _fetch_handedness_by_id helper the lineup path uses — now
  also returns team (added hydrate=currentTeam; the default /people omits the
  team name). No second integration. Verified: 29/29 starters resolve
  team/bats/throws (Steven Matz → Tampa Bay Rays, throws L). Lineup path
  unaffected (ignores the new team key). NOTE: the platoon term goes LIVE on the
  frontend only after the NEXT cron upserts the enriched starters (players.throws
  is None in the DB until then); audited fresh via /people = 172/180 candidates
  get a non-neutral platoon factor.
- PART B (this commit) — min-sample guard so thin-history hitters stop topping the
  HR section. PROBLEM: the composite MULTIPLIES the HR projection, and a hitter
  with ~1 recent game gets baseline-projected (baseline._build_hitter_from_games
  weights the last-30-day MLB game log; [1.0]→1.0) straight to ~1.0 HR, which
  dominates (Torres 1.00/0 graded + Ward 1.00/1 graded ranked #1/#2 over real
  ~0.40 hitters). SIGNAL: the "N GAMES TRACKED" footer = gradedStarts = count of
  player_game_logs rows with a non-null actual_home_runs — but it's computed
  AFTER selection, so it didn't gate. APPROACH = Option 1 (EXCLUSION), chosen
  because the live distribution (180 candidates, graded {0:7,1:24,2:80,3:69},
  max 3) shows threshold ≥2 leaves 149 eligible (NOT empty) while excluding the
  0–1-game hitters. web/lib/constants.ts HR_MIN_GAMES_TRACKED = 2 (named,
  tunable — raise as graded history deepens). web/app/page.tsx: a manually-
  paginated (avoids the 1000-cap under-count as history deepens), failure-
  tolerant graded-count read; on query FAILURE the gate DISABLES (degrades to the
  prior composite top-3 — a broken query never empties the section); <3 eligible
  → show fewer (honest empty > padded). Hitters below the floor still appear on
  the normal HR prop tab (byProp untouched). DISPLAYED HR PROJECTION UNCHANGED
  (exclusion, no ranking-projection regression). Verified: NEW top-3 = Acuña
  (0.539, R-vs-R unfavorable platoon 0.88, 2 graded) / Jarren Duran (0.479,
  tailwind 1.07 × L-vs-R favorable 1.12, 2 graded) / Miguel Vargas (0.448, R-vs-L
  favorable, 3 graded); Torres (0 graded) + Ward (1 graded) EXCLUDED. Attribution:
  platoon = PART A (live, 172/180); power/sweet-spot = STILL NEUTRAL (0 live).
  PITCHING/HITTING/normal-HR-tab/other selections unchanged; FEATURE_COLS 11;
  model byte-identical; tsc clean; npm run build passes; engine imports clean.
- PART C (report only — NO code change) — sweet-spot / power term does NOT
  self-heal on a fresh slate; it's a STRUCTURAL wiring gap, not the one-time
  mid-day-ship gap the task assumed. Findings:
  * GATE: main.py line 771 is_refresh = (proj_count >= 20); _run_pitcher_pipeline
    (line 251 `if existing >= 20`) SKIPS and returns bulk_df=None (line 271) on
    refresh runs. Sweet-spot (line 488 `if bulk_df is not None` →
    sweet_spot.compute_sweet_spot) sits inside _build_and_upsert_hitters, so it
    fires ONLY when (a) the pitcher pipeline ran FULL this run (bulk_df present)
    AND (b) the hitter pipeline actually builds (lineups posted — else it returns
    early at line 374).
  * Those two conditions NEVER coincide in the normal cron flow: the first run
    with et_today()=D is the 1 AM ET tick — it builds D's pitcher projections
    FULL (bulk_df fetched) but lineups aren't posted yet → hitter pipeline skips →
    no sweet-spot. Every later run that day finds pitcher projections already
    exist → refresh → bulk_df=None → sweet-spot skipped even once lineups post.
    So TOMORROW's fresh slate does NOT compute sweet-spot. (Only coincidental
    exception: a day where the morning full run fails and the first SUCCESSFUL
    full pitcher build happens after lineups post — not reliable.)
  * WORKFLOW: there is NO separate full-run workflow — refresh.yml is the ONLY
    workflow; all 7 crons run main.py and full-vs-refresh is a RUNTIME decision
    (the projection-count gate). So "which workflow populates sweet-spot" =
    refresh.yml, but as shown none of its runs currently do.
  * RECOMMENDED FIX (flagged, NOT built per instructions): decouple sweet-spot
    from the pitcher pipeline's bulk_df — e.g. in _build_and_upsert_hitters, when
    bulk_df is None but we're building hitter_home_runs, fetch the bulk Statcast
    frame independently (model._fetch_bulk_statcast(et_today())), or add a
    dedicated sweet-spot step that always fetches Statcast when hitters are built.
    Until then the HR-composite power term stays permanently neutral.

Sweet-spot decoupled from pitcher bulk_df — HR composite power term now LIVE:
- Fixes the structural deadness reported last session (PART C): sweet-spot only
  computed when bulk_df was present, but bulk_df is None on every refresh run and
  the only full pitcher run (1 AM ET) precedes lineups, so the hitter pipeline
  early-returned and the sweet-spot step never ran — every run, every day.
- FIX (engine/main.py _build_and_upsert_hitters): resolve the Statcast frame from
  EITHER the pitcher pipeline's bulk_df (full run, free) OR — when that's None
  (refresh run) — an INDEPENDENT mlb_model._fetch_bulk_statcast(et_today()) call
  (the SAME helper the pitcher pipeline uses; no new fetch). The independent
  fetch fires ONLY when ALL hold: (a) building hitter_home_runs (this function),
  (b) no full-run bulk_df, (c) sweet-spot is actually MISSING for these hitters'
  hitter_home_runs rows. Guard (c) = new db.get_players_with_sweet_spot(date)
  (player_ids whose hitter_home_runs row already has non-null sweet_spot_pct) —
  if all present, the expensive fetch is SKIPPED. One fetch per run (covers all
  hitters), pybaseball-cached (cache.enable() at startup, unchanged), wrapped in
  try/except so a Statcast flake leaves sweet-spot null (composite power term
  degrades to neutral). A full pitcher run still reuses its own bulk_df (the
  independent branch is skipped when a frame is passed) — no double fetch.
- WHY THIS WORKS in the normal flow: the FIRST hitter build of the day (when
  lineups post, ~1 PM ET) runs in refresh mode (existing_hitter < 100 → full
  build path → _build_and_upsert_hitters), so the independent fetch fires there
  and populates sweet-spot for the whole slate. Later runs skip it via guard (c).
  This is NOT a backfill script — it's the regular pipeline computing sweet-spot
  when missing, so it self-heals each fresh slate (and backfilled today's slate
  as a side effect during verification).
- NOT a model input — sweet-spot never enters FEATURE_COLS (still 11). Untouched:
  the is_refresh gate, the lineup early-return, the composite logic, model,
  projections, edges, wind tag, the HR min-sample guard.
- VERIFIED (live, 2026-06-02): refresh-path build (bulk_df=None) → "independent
  bulk Statcast fetch for sweet-spot (270/270 hitters missing)" fired ONCE →
  "computed for 254 hitters"; hitter_home_runs sweet-spot coverage 0 → 254 (16
  with < 5 BBE correctly omitted). Re-run → "sweet-spot already present ...
  skipping independent bulk Statcast fetch" (guard c, no double fetch). Spot-
  check player 802415: compute_sweet_spot {sweet 0.174, EV 77.8, BBE 23} ==
  hand-filter (launch_angle 8–32°, ≥5 BBE) {0.174, 77.8, 23} exactly. FEATURE_
  COLS 11; model byte-identical; engine imports clean; no migration needed
  (add_sweet_spot.sql already applied). Composite audit: power term NON-neutral
  for 159/184 candidates (was 0) — now live alongside platoon (PART A, 176) and
  the min-sample gate (PART B, 31 excluded). New top-3: Acuña (power 0.839 ×
  platoon 0.880), Soto (0.929 × 1.120), Duran (1.056 × 1.120 × tailwind 1.070).

Wind tag extended to game headers + total-bases cards (this session):
- DISPLAY-ONLY frontend change. The wind tag (live on HR cards) now also renders
  on (A) the per-game board's game-header park tag and (B) total-bases prop cards.
  Wind affects all batted balls, so it's legitimately additive on these power-
  adjacent surfaces. No engine/model/FEATURE_COLS/schema/migration change; reuses
  the existing wind math (wind.ts) — nothing reimplemented.
- REFACTOR (no behavior change to HR cards): extracted the wind-tag display logic
  from FeaturedPlays.tsx into a shared web/lib/windTag.ts with TWO entry points
  off one core (directionalClause, which reuses wind.ts windRelativeAngle/
  windBucket):
  * windTag(input) — the FULL HR-card line: directional wind, else the static
    park label ("Neutral park" / "· calm"). FeaturedPlays now imports this
    (byte-identical output — pf still = PARK_FACTORS_HITS[homeTeam]); parkLabel
    moved here too (its "Park ↑ 1.12" line imports it).
  * windClause(input) — directional wind ONLY (or "Dome · neutral"); null when no
    usable wind / calm / unknown bearing. For surfaces that ALREADY show the
    static park label elsewhere, so we don't duplicate it.
  Same arrow + mph + direction text + colors (out=green, in=red, cross=slate) on
  every surface.
- DATA WIRING: web/lib/types.ts GameGroup gains windSpeed?/windDirDeg?/isDome?
  (mirrors the HR-play wind fields). page.tsx getSlate attaches them to each
  GameGroup from the EXISTING windByGame map (no new query). PropBoard reads them.
- (A) GAME HEADER (PropBoard.GameHeader): renders windClause ALONGSIDE the
  existing ParkTag (not replacing). A "·" separator shows only when BOTH a
  non-neutral ParkTag and a wind clause render. Subordinate styling (text-[11px],
  HR-card colors). Verified live (2026-06-02): Cincinnati "HITTER PARK ↑ · → 9
  mph Cross to RF", Philadelphia "HITTER PARK ↑ · ↓ 7 mph In from CF", Cubs "↓ 8
  mph In from CF", LA Angels "↑ 9 mph Out to LF"; dome (Arizona/Houston/Tampa) →
  "Dome · neutral"; Boston (calm/no wind) → park label only (degrade). The static
  park label is always preserved alongside.
- (B) TOTAL-BASES CARDS ONLY (active === "hitter_total_bases"): new WindCardLine
  renders windClause per card (same colors/arrow/format as HR cards, card-sized,
  no park fallback since the header carries the park label). Returns null on no
  usable wind. NOTE the header wind clause shows on every tab (it's the per-game
  header); the per-CARD wind tag is gated to total_bases only.
- EXPLICITLY EXCLUDED from the per-card wind tag (wind is noise there): strikeouts,
  hits_allowed, walks, earned_runs, outs_recorded, hitter_hits, hitter_rbis,
  hitter_runs, pitcher_fantasy_score, hitter_fantasy_score, and ALL pitcher props.
  Only HR cards (existing) + total_bases cards + the game header carry wind.
- DON'T-TOUCH honored: windTag math, HR composite/ranking, sweet-spot footer, the
  min-sample guard, prop selection, edges, engine, FEATURE_COLS (11), schema — all
  unchanged. VERIFIED: tsc --noEmit clean; npm run build passes.

AI insight K-rate mis-attributed to the pitcher's own team — fixed (this session):
- BUG (user-reported, Eric Lauer card): the Featured-Plays AI insight attributed
  the opposing-lineup K-rate to the WRONG team. Abbott (Reds pitcher facing the
  Royals) read "backed by the Reds' 21% K-rate" — but 21% is the ROYALS' rate;
  the Reds are his own team.
- DIAGNOSIS (live, 2026-06-02): the stored opp_k_rate is ALWAYS correct (the
  opponent's): Lauer (away/Dodgers, faces ARI) opp_k_rate 0.2035 = Diamondbacks'
  actual 0.2035; Abbott (home/Reds, faces KC) 0.214 = Royals' 0.214; Gage Jump
  (faces CHC) 0.2119 = Cubs' 0.212. The data is right — only the AI labeling was
  wrong. ROOT CAUSE: featured-insights/route.ts told the LLM "opposing lineup
  strikes out X%" WITHOUT naming the team, so the LLM guessed and named the
  pitcher's own team.
- FIX (frontend + prompt, no engine/model/schema change):
  * page.tsx: moved the gameInfoById (per-game starters + teams) isolated query
    ABOVE buildEdgePlays so it can name the opponent. For each featured pitching
    play the featured player IS the game's starter, so oppTeam = the OTHER team
    (player_id == homeStarter → awayTeam, == awayStarter → homeTeam; undefined
    when the starter id isn't resolved → falls back to "the opposing lineup").
    Attached oppTeam to the FeaturedPlay. (gameInfoById is still reused by the HR
    composite platoon term — just defined earlier now.)
  * types.ts: FeaturedPlay gains oppTeam?: string.
  * featured-insights/route.ts: PlayCtx carries oppTeam; the K-rate prompt bit is
    now "the {oppTeam} lineup (the team {pitcher} is facing) strikes out X%", and
    a CRITICAL system rule was added: "any strikeout/K rate given is the OPPONENT
    lineup's — attribute it to that opponent, NEVER the pitcher's own team." The
    unstable_cache key includes oppTeam, so insights regenerate with the fix.
- VERIFIED: oppTeam resolves correctly (Lauer→Arizona Diamondbacks, Abbott→Kansas
  City Royals, Jump→Chicago Cubs); new prompt line names the right team; tsc
  --noEmit clean; npm run build passes. Engine/model/FEATURE_COLS/schema
  untouched. (The board's OppContextLine "Facing a X% K lineup" was already
  correct — it never named a team.)

HR composite 4th term — opposing-starter HR/9 (this session):
- STEP 0 finding: the existing opp-SP metrics (opp_sp_k_rate_last5 / era_last5 /
  whip_last5 / hand) are computed in grade.py::_opp_sp_recent_stats at GRADE time
  and persisted to player_game_logs — NOT on projection rows. The HR composite
  reads PROJECTION rows, so opp_sp_hr9 can't "ride the same path"; it needed a NEW
  projection-time computation (like sweet_spot). The DATA SOURCE
  (stats.get_pitcher_starts) is reusable — it just wasn't exposing HR.
- STEP 1 (compute + persist):
  * stats.get_pitcher_starts now also returns home_runs (HR allowed) — same fetch,
    additive. New stats.get_pitcher_hr9_last5(sp_id, lookback, ref_date) → HR/9
    over the last 5 starts (HR*27/total_outs), None on no-starts/zero-outs.
  * main._build_and_upsert_hitters gained a `starters` param (threaded
    main → _run_hitter_pipeline → here). For each lineup hitter it finds the
    OPPOSING starter (the OTHER side's probable pitcher via starters' game_id/
    home_away), computes that SP's HR/9 (cached per SP), and attaches opp_sp_hr9
    to the hitter_home_runs rows. NULL when the opp starter is unknown / no recent
    starts. NOT a model input (FEATURE_COLS stays 11 — verified).
  * schemas.ProjectionRow + db/schema.sql + db/migrations/add_opp_sp_hr9.sql
    (projections.opp_sp_hr9 numeric). ACTION REQUIRED: run that migration.
  * db.upsert_projections PGRST204 strip made GRANULAR (was all-or-nothing): it now
    strips ONLY the specific missing column PostgREST names and retries in a loop,
    so opp_sp_hr9 being absent pre-migration no longer drops sweet_spot_pct on the
    same row. VERIFIED: pre-migration run stripped only ['opp_sp_hr9'] and
    sweet-spot coverage stayed 254 (unchanged).
- STEP 2 (composite, ranking only): web/lib/hrComposite.ts gains the 4th term —
  score = projection × windAdjPark × powerFactor × platoonFactor × hr9Factor.
  Higher opp HR/9 = boost (homer-prone arm), lower = suppression; bounded
  ±HR9_WEIGHT, normalized HR9_FLOOR 0.8 → HR9_ELITE 1.8 (named in HR_COMPOSITE).
  Missing → 1.0 (neutral). page.tsx adds an ISOLATED, failure-tolerant opp_sp_hr9
  query (separate from sweet-spot so a missing column can't blank the footer) →
  oppHr9ByPlayer → passed to hrComposite. Display HR projection unchanged; AI
  insight untouched (no probability/edge implied).
- STEP 3 (populate-path): opp_sp_hr9 is computed in _build_and_upsert_hitters —
  the SAME lineups-posted hitter build that populates sweet-spot, with NO bulk_df
  / full-pitcher-run dependency (just `starters`, always available). So it self-
  heals each fresh slate exactly like sweet-spot now does; no gating gap. Verified
  it ran on the refresh-path build (computed for 261/270 hitters).
- VERIFIED: FEATURE_COLS 11; model byte-identical; tsc --noEmit clean; npm run
  build passes; engine imports clean. Spot-check exact (Steven Matz last-5 HR=3 /
  44 outs → get_pitcher_hr9_last5 1.841 = 3×27/44). Composite audit (HR/9 computed
  fresh, since the DB column lands post-migration): term NON-neutral for 178/186;
  reorders sensibly — Soto #1 (faces a 2.08 HR/9 arm, boost) over Acuña (faces a
  0.36 HR/9 stingy arm, suppress). Neutral-degrade confirmed (None → factor 1.0 →
  3-term ranking unchanged). Pre-migration the frontend query 400s → term degrades
  to neutral, so the live board is unchanged until the migration + next build.

Hitter/pitcher fantasy-score projected Over for ~every player — fixed (this session):
- USER-REPORTED: the hitter_fantasy_score tab leaned Over on almost every player.
- DIAGNOSIS (not assumed): (1) SCORING is correct — the official PrizePicks MLB
  hitter chart EXACTLY matches engine/fantasy_score.py (single 3 / double 5 /
  triple 8 / HR 10 / run·RBI·walk·HBP 2 / SB 5), verified via the PrizePicks
  playbook. (2) LINES are correct — all 178 are PrizePicks-direct STANDARD rungs
  (single observed_lines value). (3) The bug was the PROJECTION STATISTIC:
  build_hitter/pitcher_fantasy_score_projections used the recency-weighted MEAN
  of per-game FP, but fantasy score is heavily RIGHT-SKEWED (a few 20–30 FP games)
  so the mean sits well above the MEDIAN — and a PrizePicks flat-payout DFS line
  is set at the ~50% (median) point. Measured slate-wide (178 hitters): mean proj
  → 155/178 Over (87%), avg(proj − line) = +1.99; MEDIAN proj → 72 Over / 83 Under
  / 23 push (40/47/13%), avg(median − line) = −0.08 (centred on the line). So the
  lines track the median; the mean projection was the systematic Over bias.
- FIX (engine-only, baseline.py): new _median_projection(values) = median of the
  per-game/per-start FP. build_hitter_fantasy_score_projections and
  build_pitcher_fantasy_score_projections now use it instead of
  _weighted_projection. The empty/zero → LEAGUE_AVG_HITTER_FP floor is unchanged.
  Other props (hits/TB/etc.) keep the weighted mean — they're far less skewed and
  their lines come from real de-vigged books, not median DFS lines.
- SCOPE: NOT a model change — fantasy score is not a FEATURE_COL (still 11), the
  model is untouched, no schema/migration. web/lib/fantasyScore.ts is the SCORING
  formula (live in-game overlay), NOT the projection — untouched. The displayed
  "proj" for the two fantasy props now shows the MEDIAN (e.g. Cruz 9.9→7.0,
  Ohtani 10.8→9.0, Reynolds 8.8→7.0), which is the right central estimate to
  compare against a median-set line.
- VERIFIED: scoring chart matches PrizePicks; slate-wide leans rebalance 87%→40%
  Over; new builder returns the median (spot-checked Reynolds 7.0 / Ohtani 9.0 /
  Marte 8.0 / Gonzales 5.0); FEATURE_COLS 11; engine imports clean; py_compile OK.
  Goes live for the displayed projections + /results grading on the next
  lineups-posted hitter build (cron) — or a manual rebuild.

Fantasy lines corrupted by the ParlayAPI ladder when PP-direct fails — fixed:
- SYMPTOM (user): some fantasy_score LINES went wrong after a LOCAL python
  engine/main.py run (e.g. Ohtani standard 8.5 shown as 11.5). NOT caused by the
  median-projection change (that only touched projections, not lines).
- ROOT CAUSE: that run logged "PrizePicks-direct unavailable (HTTP 403) via proxy
  -- ladder/median fallback" — PrizePicks-direct 403s from a non-proxied/blocked
  IP (works in GitHub Actions via the residential proxy, but not from the user's
  local machine). With PP-direct down, fantasy rows fell back to the ParlayAPI
  goblin/standard/demon ladder, and db._resolve_fantasy_ladder MEDIAN-MERGED a
  random demon rung into the last-good authoritative standard: Ohtani
  observed_lines "8.5" -> "8.5,14.5" -> median 11.5. Confirmed live (Tucker
  "5.5,10.5"->8.0, etc.).
- FIX (engine/lines.py): fantasy-score lines are now sourced ONLY from the
  authoritative PrizePicks-direct standard. Any fantasy row PP-direct doesn't
  cover (failed entirely OR doesn't list that player) is DROPPED rather than
  ingested, so the existing DB line is preserved (last-good snapshot) instead of
  being polluted. The PP-direct filter ALWAYS runs now (previously gated on
  `if pp_standard:`, so a total 403 skipped it and let every fantasy row pollute).
  Every upserted fantasy row now carries an authoritative single-value
  observed_lines, so the median merge never runs on a fantasy row again.
  Trade-off: when PP-direct partially covers, ParlayAPI-only players lose a rough/
  unreliable line in favor of correctness; existing polluted lines self-heal on
  the next PP-direct-covered run (authoritative overwrite).
- OPERATIONAL NOTE: running python engine/main.py LOCALLY re-pollutes fantasy
  lines (PP-direct 403 locally) PRE-fix; POST-fix a local run just drops fantasy
  rows and keeps last-good. The hitter PROJECTION rebuild (_build_and_upsert_
  hitters) does NOT fetch lines, so it's line-safe. The median-projection fix
  currently applies only to the 2 fill-in hitters from that run; the other ~268
  self-heal on the next fresh-slate full build (or a line-safe projection rebuild).

Condensed, best-edge-first, collapsible per-game board (this session):
- PROBLEM (user): a 15-game slate rendered every game fully expanded, stacked
  vertically — a very long scroll where the games at the bottom were buried.
  User asked to "condense the props into game labels."
- DETERMINATION (delegated to me; user said "compare successful prop sites").
  Research (Outlier.bet +EV tab, PrizePicks "Discrepancies", Props.cash "EDGE"
  feature; common UX failure = "getting lost clicking through menus to find
  lines"): every successful prop tool SURFACES VALUE FIRST and never makes you
  hunt for the edge. So a plain accordion (hide everything behind a tap) is the
  anti-pattern; the right design is condense-but-keep-the-signal. Decisions:
  * Collapsed row = the game's single best play inline (name · line · edge/lean
    + "+N more"), never blank ("No edge" / "No lines yet" fallback).
  * Sort = best-edge-first, banded bettable(scheduled) → live → final so an edge
    on an unbettable live/final game can't outrank an upcoming play. Fixes
    "good stuff buried at the bottom."
  * Default = smart: a game with a qualifying edge auto-expands; all-even games
    collapse to a thin row; final games collapse (that's /results' job).
  * Plus an Expand all / Collapse all control.
- SCOPE: web/app/PropBoard.tsx ONLY — pure presentation. NO edge math, NO
  selection logic, NO Featured Plays / HR composite / sharp-badge / live-overlay
  changes; engine + FEATURE_COLS (11) untouched. The expanded player list is the
  EXACT prior card layout (EdgeDetail / ConfidenceBar / RecentFormDots /
  OppContextLine / WindCardLine / ProjectionBadge / SharpBadge all reused as-is).
- IMPLEMENTATION (PropBoard.tsx):
  * summarizeGame(g) → {bestPlay, qualifyingCount, hasAnyLine, topMagnitude}.
    Per player with a line: two-sided book → |edge| vs EDGE_THRESHOLD (same as
    EdgeDetail); DFS fantasy → |proj−line| vs LINE_LEAN_THRESHOLD (same rule
    /results grades on). bestPlay = strongest QUALIFYING play; topMagnitude
    (qualifying-or-not) drives the sort.
  * stateRank (scheduled/other 0, live 1, final 2) + topMagnitude desc +
    startTime asc tiebreak. NOTE: game order now differs PER TAB (each tab's
    best edge differs) — intentional, supersedes the old "identical order across
    all 10 tabs" note.
  * defaultExpanded(summary,status): final → collapsed; else qualifyingCount>0.
  * Manual overrides keyed `${activeTab}:${gameId}` (so a choice on one tab never
    leaks to another — game ids are shared across tabs); no useEffect/reset
    needed. allExpanded + toggleAll for the Expand/Collapse-all button.
  * New sub-components: Chevron (▶, rotate-90 when open), CollapsedSummary,
    GameCard (clickable role=button header — can't wrap an <h2> in a <button> —
    + collapsed summary OR the full <ul> player list). The old GameHeader
    function was folded into GameCard (deleted; no stray refs).
  * GameGroup added to the type import.
- VERIFIED: tsc --noEmit clean; npm run build passes (/ 10.8 kB, was 9.55).
  Dev-server screenshot (2026-06-02 slate, Strikeouts tab): games sorted
  best-edge-first → LA Dodgers @ Arizona on top (Eric Lauer +0.49, the slate's
  strongest); collapsed summary renders "Eric Lauer 3.5 K ▲ +0.49 +1 more";
  edge games auto-expanded, Expand/Collapse-all toggles the whole slate; park/
  wind tags + live-status line preserved on the header. Frontend-only.

Board sort reverted to chronological (same session, user follow-up):
- User: "i want them to still be sorted by date and chronologically by the time
  they start." Reverted the best-edge-first sort to start-time ascending (TBD
  start times sink to the end; live games keep their chronological slot).
  Removed stateRank(); label "Games sorted by strongest edge" → "Games in
  start-time order". The condensing/collapsible cards + collapsed best-play
  summary + smart auto-expand + Expand/Collapse-all are KEPT — only the game
  ORDER changed. summarizeGame still computes topMagnitude (now unused by the
  sort, retained for the collapsed summary + any future re-sort). tsc clean;
  build passes.
Game-first board redesign — prop becomes a filter, not the entry point (same session):
- The "disorganized" follow-up above, BUILT. Root problem: the data's natural
  unit is a PLAYER-IN-A-GAME (each carries ~6 projections) but navigation was
  metric-first (12 prop tabs), so a game/player was never shown whole and you
  tab-hunted to reassemble one entity. Researched the leading tools (Outlier
  +EV tab, PrizePicks "Discrepancies", Props.cash "EDGE"): all surface value
  first and never bury the line behind a metric pick. User chose GAME-FIRST.
- web/app/PropBoard.tsx (full rewrite of the board layer; verbatim sub-components
  — liveActualFor / paceColor / ProjectionBadge / EdgeDetail / ConfidenceBar /
  RecentFormDots / OppContextLine / WindCardLine / StatusLine etc. — preserved):
  * The 12 prop tabs are now a FILTER with an "All props" default (focus state =
    PropType | "all"). You never pick a prop to start.
  * buildGameViews(byProp): client-side INVERSION of prop→game→players into
    game→{pitchers,hitters} where each PlayerRow carries ALL its props. page.tsx
    + the queries + the ByProp payload are UNTOUCHED — pure frontend restructure,
    still ZERO projection math in the UI. A player's kind (pitcher/hitter) is
    inferred from which props it appears under.
  * ALL-PROPS mode (default): each expanded game shows Pitchers then "Hitters
    with edges", each player as ONE row of compact PropChips (short label + proj
    or live actual + edge/lean badge; emerald=over, red=under, neutral=no edge).
    Hitters default to those with a qualifying edge + a "Show N more hitters"
    toggle (per-card useState). Tapping a chip FOCUSES that prop.
  * FOCUSED mode (a specific prop selected): renders the EXACT old rich per-prop
    card (FocusedPlayerCard) — EdgeDetail line, ConfidenceBar, RecentFormDots,
    OppContextLine (strikeouts), WindCardLine (total_bases), SharpBadge, live
    ProjectionBadge. Nothing lost; the deep context just lives one tap in.
  * Shared evalRow(row) is the single classifier (|edge| vs EDGE_THRESHOLD for
    two-sided books; |proj−line| vs LINE_LEAN_THRESHOLD for DFS fantasy) feeding
    the chips, collapsed summary, "has edge" hitter filter, and edge-first
    in-section ordering.
  * Games stay CHRONOLOGICAL by start time, collapsible, smart-default-expand
    (qualifying edge → open; all-even/final → collapsed), Expand/Collapse-all.
    Collapsed summary now shows the game's best play across ALL props (e.g.
    "Logan Gilbert · K 6.5 · ▲ +0.49 · +2 more"). Overrides keyed `${focus}:${gid}`.
- SCOPE: PropBoard.tsx only. Engine + FEATURE_COLS (11) untouched; page.tsx,
  types.ts, FeaturedPlays, HR composite, sharp/edge logic untouched.
- VERIFIED: tsc --noEmit clean; npm run build passes. Dev-server DOM checks
  (2026-06-02 slate): chronological order (SD@PHI first); All-props chip rows
  render every prop per player (e.g. "K 8 ▲+0.12 · HA 4 ▲+0.18 · ER 2 ▲+0.38 ·
  Outs 15 · FP 33 ▼") with live actuals + pace color on final/live games;
  "Pitchers" + "Hitters with edges" sections; tapping a K chip switches focus to
  Pitcher Strikeouts and renders the full rich cards (Schlittler ◆5/5 OVER Line
  6.5 ▲+0.19 + "Facing a 20.3% K lineup"; Abbott ◆5/5 UNDER −0.53). Frontend-only.

Game-first board — edge classification fix (same session, from user screenshots):
- BUG the user could see: every collapsed game headlined a FANTASY play
  ("Aaron Nola FP 29.5 ▼ Under · +47 more") and the hitter list showed the whole
  lineup. Cause: the cross-prop "best play" / ordering / hitters-with-edges all
  compared evalRow magnitudes, but DFS fantasy leans are |proj−line| in POINTS
  (can be ~25) and consensus hitter edges are de-vigged vs a SYNTHETIC line (a
  HR can read +0.85) — both dwarf real-book edge probabilities (~0.1–0.5).
- FIX (PropBoard.tsx evalRow + chip): a row now classifies into three tiers,
  mirroring how Featured Plays already defines a trustworthy edge:
  * qualifiesEdge  = REAL two-sided book (REAL_BOOKS = pinnacle/draftkings/
    fanduel/bet365/caesars) AND |edge| > EDGE_THRESHOLD. ONLY this drives the
    collapsed best-play, the "+N more" count, edge-first ordering, and the
    "hitters with edges" filter. Chip = colored (emerald/red) tint + signed #.
  * qualifiesConsensus = de-vigged edge vs a `consensus` synthetic line. Chip
    shows the number but MUTED (slate, no tint); never structural.
  * qualifiesLean = DFS fantasy proj-vs-line. Chip shows a muted ARROW only;
    never structural.
  evalRow gained isRealBook (row.bookmaker ∈ REAL_BOOKS — bookmaker is already
  on the row from page.tsx) + qualifiesConsensus; consumers (summarizeGameView,
  playerHasEdge, playerBestMag) switched from .qualifies to .qualifiesEdge. Chip
  title now names the book.
- VERIFIED (dev server, 2026-06-02): headlines became real-book edges (Harper HR
  0.5 ▲+0.55 pinnacle, Alonso TB 1.5 ▲+0.50 pinnacle); "+N more" dropped (+35→+24
  as consensus rows stopped counting); hitter_hits chips (all `consensus`) render
  muted slate "H 1 ▲+0.27" with NO colored tint while pinnacle TB/HR chips stay
  colored. tsc clean; build passes. Frontend-only; engine + FEATURE_COLS (11)
  untouched.
- OBSERVATION (engine, NOT fixed here — flagged for the user): the largest
  real-book edges are now hitter HR/TB pinnacle at +0.4..+0.85. Those magnitudes
  look inflated — almost certainly the crude model_over_prob normal approximation
  (std = proj×0.35) overstating P(over) for low-mean count props (HR especially)
  and thin-history baseline-floored ~1.0 HR projections. Same root cause as the
  HR min-sample / floor notes above; affects Featured Plays + the HR tab too. A
  proper Poisson/empirical over-prob (or calibrated confidence) is the real fix —
  separate engine task, out of scope for the board display.

Phase-aware chips — final games show actual vs line + hit/miss (same session):
- USER: on a FINISHED game the all-props chip "just shows what actually happened"
  with no projection/line, so you can't tell how it did vs the line; and a final
  game should look different from one that hasn't started. The pre-game edge arrow
  is also stale once the game's over.
- FIX (PropBoard.tsx PropChip — now PHASE-AWARE off `live`/`isFinal`):
  * pre-game (live === undefined): projection + edge/consensus/lean badge, colored
    border tint on real edges (UNCHANGED — forward-looking scan view).
  * live (live !== undefined, !isFinal): "K 5 · 6.5" — actual-so-far · line (the
    target), pace-colored, no verdict yet.
  * final (isFinal): "K 8 · 6.5 ✓" — actual · line + a ✓/✗ on whether the model's
    LEAN won. Actual colored emerald=won / red=lost / slate=push-or-no-lean. The
    two numbers show over/under at a glance; ✓/✗ + color give the betting result
    without a third number. No line → "K 8" colored by actual-vs-projection.
  PlayerChipsRow passes isFinal; win/loss uses evalRow(row).direction (the
  pre-game lean still on the row) vs actual-vs-line, same rule /results grades on.
  Chip title (tooltip): "<prop> · line X (book) · actual N".
- VERIFIED (dev server, 2026-06-02 SD@PHI final 2-3): Aaron Nola K 8·5.5 ✓ (over
  lean hit), HA 4·5.5 ✗ (over lean missed), BB 0·1.5 (no lean → no verdict), ER
  2·2.5 ✗, FP 33·29.5 ✗ (under lean lost); Bryce Harper all ✓ (big game), Schwarber
  all ✗ (0-fer); no-line props (RBI/R) show actual only. Reads clean, not congested
  (≈3 chips/row at narrow width). tsc clean; build passes. Frontend-only; engine +
  FEATURE_COLS (11) untouched.
- POSSIBLE follow-up (not done): scheduled chips still don't show the line number
  (proj + edge only; line is in the focus card / tooltip). Could add it but it's a
  3rd element — left out to avoid pre-game congestion.

Board result grading now mirrors /results (projection-lean vs line) (same session):
- USER (screenshots, live CLE@NYY): the chip/focused result was graded by the
  de-vigged EDGE direction, but it should be graded by the PROJECTION'S LEAN vs
  the line — exactly like /results. Schlittler ER proj 1.0 / line 1.5 (leans
  UNDER) / actual 4 (over) is a clear MISS, but the chip drew no ✗ because the
  edge was "~Even", and the focused card showed stale "~Even" + a misleading
  GREEN "4 ER" (paceColor treats actual>proj as good, wrong for lower-is-better
  props on an under lean).
- FIX (PropBoard.tsx): new shared gradeLean(projection, line, actual, isFinal)
  → "win"|"loss"|"push"|"alive"|"none", the EXACT /results rule:
    lean   = sign(proj − line), |gap| < LINE_LEAN_THRESHOLD ⇒ no lean
    result = sign(actual − line); win when lean matched result.
  Because every stat only counts UP in-game, a line already crossed (over) is
  LOCKED even live; an actual still under the line is "alive" (undecided) while
  live and decided once final. Rewired:
  * PropChip (all-props chip): live + final both grade via gradeLean. Actual
    colored win=emerald / loss=red / alive·push·none=slate; ✓/✗ shown once
    decided. Replaced the old evalRow-edge-direction win/loss AND the live
    paceColor. Schlittler now reads "ER 4 · 1.5 ✗" (red); undecided live props
    (K 3 · 6.5) stay neutral.
  * ProjectionBadge (focused right chip): actual colored by gradeLean (+ ✓/✗),
    not paceColor — so a high ER on an under lean reads RED, not green.
  * EdgeDetail (focused line): when an actual exists (live/final) it now shows
    the proj-vs-line LEAN + result ("Line 1.5 · proj ▼ Under · ✗ miss") instead
    of the stale pre-game edge; pre-game still shows the de-vigged edge.
  * Removed paceColor entirely; dropped isHitter from ProjectionBadge and
    liveColor/isHitterKind from PlayerChipsRow (all paceColor-only).
- NOTE: this is the RESULT/grading lean (proj-vs-line, matches /results). The
  PRE-GAME edge arrows (de-vigged, real-book) are unchanged — a separate
  forward-looking signal. The two intentionally differ; the board now uses
  proj-vs-line wherever it's showing a realized result.
- VERIFIED (dev server, live CLE@NYY 9th): all-props chips — Schlittler ER
  4·1.5 ✗, Cantillo BB 3·2.5 ✓ (over lean won) / HA 6·4.5 ✗ / ER 4·2.5 ✗,
  Goldschmidt TB 7·1.5 ✓ / FP 28·5.5 ✓; no-line props (H/RBI/R) neutral; alive
  props neutral. Focused ER: "Line 1.5 · proj ▼ Under · ✗ miss" + "4 ER ✗ ·
  proj 1.0". tsc clean; build passes. Frontend-only; engine + FEATURE_COLS (11)
  untouched.

Projections verified frozen pre-game + strict-prior hardening (this session):
- USER concern: are projections updating mid-game? The board grade must track the
  PRE-GAME projection (the lean you could have bet); a mid-game rewrite could flip
  a win to a loss.
- DIAGNOSED (read-only live-DB probe, since removed): projections ARE frozen
  pre-game. For NYM@SEA (first pitch 01:40 UTC) all 18 hitter_hits projections
  were written 22:55 UTC (~3h before), single build, no drift. Slate-wide: 268/270
  written before first pitch; 0 drift on any starter. The 2 post-first-pitch rows
  were mid-game FILL-INs for pinch-hitters/subs (new players entering), never
  starters. MECHANISM: once today's projections exist, every later cron (incl.
  ones during games) hits the skip path — it does NOT rebuild already-projected
  players, only fills in newly-posted lineups. So a starter's projection is built
  once and frozen.
- LATENT HOLE found + CLOSED: the baseline builders fetch game logs via
  stats.get_hitter_games / get_pitcher_starts, which filtered
  `start_date <= game_date <= end_date`. With end_date = proj_date (today), that
  `<=` INCLUDES today's game. VERIFIED today's in-progress game IS exposed by the
  MLB gameLog (Julio Rodríguez: today present in raw gameLog = True), so a rare
  mid-game stale-rebuild could have pulled the in-progress line into a starter's
  own projection. FIX (engine/stats.py): both fetchers now use STRICT-PRIOR
  `start_date <= game_date < end_date` — a projection/grade anchored to end_date
  can NEVER include the game ON end_date. Verified post-fix: get_hitter_games for
  Julio returns through 2026-06-01 only (0 today-dated games).
- ZERO impact on normal pre-game values: when a game hasn't started it isn't in
  the log, so `<` and `<=` are identical; the fix only changes the (now-excluded)
  in-progress/rebuild case. Form helpers (get_hitter_form / get_pitcher_form /
  get_pitcher_rest_metrics) ALREADY re-filter `< game_date`, so they're unaffected;
  grade-time opp-SP stats want strict-prior too (the SP's form ENTERING the game),
  so `<` is correct there as well. py_compile clean. Engine-only; FEATURE_COLS (11)
  untouched. (Statcast strikeout path is lower-risk — Savant data lags, so an
  in-progress start isn't available mid-game; not changed.)

Matchup-K daily scorecard — log-only flip gate (this session):
- CONTEXT: user wants the skill-led matchup-K to eventually drive the strikeouts
  projection, but with NO harm. Ran the validator (_validate_matchup_k.py) on the
  live DB: 17 graded shadow starts, 5 divergences, matchup-K won 2/5 (40%) on
  divergences vs baseline 3/5 — NOT proven better, so flipping now would be a
  coin-flip gamble. Correct no-harm call: do NOT flip; leave the live model as-is.
- IMPLEMENTED (the no-harm forward step): engine/matchup_k_scorecard.py — a
  daily LOG-ONLY scorecard. ZERO projection impact, NEVER auto-flips. Reads
  projections.matchup_expected_k (shadow) + player_game_logs.actual_strikeouts +
  the strikeouts line, computes line-region Brier per predictor + realized edge
  on divergences, and prints a "FLIP-READY? yes/no" verdict against a
  PRE-COMMITTED gate. Hooked into engine/main.py after the shadow step, gated on
  `not is_refresh` (full run only, once/day after grading), wrapped in try/except.
- FLIP GATE (engine/constants.py, objective so the flip is a data check, not a
  debate): MATCHUP_K_FLIP_MIN_DIVERGENCES=40 AND MATCHUP_K_FLIP_MIN_WINRATE=0.55
  AND matchup-K Brier <= baseline Brier. Until all three hold, matchup-K stays
  shadow. A "FLIP-READY? YES" log line is a PROMPT for a human to make the
  (small, rolling-avg-regularizer-backed) code change — it never switches itself.
- LIVE READING NOW: 17 starts, 5 divergences, matchup-K 40% win-rate (gate not
  met — only 5/40 divergences), Brier matchup-K 0.188 vs baseline 0.210 (matchup-K
  calibration slightly BETTER — an early encouraging sign, but the divergence
  win-rate + sample size are the binding gates). Verdict: NOT flip-ready.
- VERIFIED: py_compile clean (constants / scorecard / main); scorecard runs
  read-only and prints the correct verdict; FEATURE_COLS (11) + live projections
  untouched. Engine-only; takes effect on the next FULL cron run (the daily log
  line). _validate_matchup_k.py kept as the verbose manual deep-dive.

Poisson over-probability — kills inflated low-count edges (this session):
- MONETIZATION-PREP correctness fix. edge._model_over_prob used a NORMAL
  approximation (std = projection * 0.35) for P(over). For low-mean COUNT props
  (HR, RBI, runs, TB) that math is just wrong and massively overstated the over:
  a HR projected 1.0 vs a 0.5 line read P(over)=0.977 → inflated, implausible
  +0.5..+0.88 "edges" the board would have sold a paying user.
- FIX (engine/edge.py): integer count props now use the POISSON survival
  function — over wins when actual > line, so for a half-point line L,
  P(over) = P(X >= floor(L)+1) = poisson.sf(floor(L), mu). prop_type threaded
  into _model_over_prob (it was already in scope in compute_edges). Fantasy-score
  props (continuous points, never a two-sided edge anyway) keep the normal approx.
- VERIFIED on live edges (read-only old-vs-new): HR 1.0/0.5 MOP 0.977→0.632;
  TB 2.0/1.5 0.923→0.594; K 6.0/5.5 0.683→0.554 (higher means barely move);
  worst real cases hitter_rbis 0.7/0.5 +0.877→+0.462; a real pinnacle TB edge
  +0.55→+0.22 (still real, now believable). Across 719 edges with |old edge|>=0.30,
  avg |edge| 0.458 → 0.116. py_compile clean.
- IMPACT: takes effect on the next cron run (edges recompute). The board will
  show FEWER green edges — correctly, because most of the big ones were artifacts.
  Existing edge rows persist until overwritten. Frontend untouched (reads the
  recomputed edges). FEATURE_COLS (11) untouched.
- SEPARATE known issue, NOT fixed here: consensus 0.5-line hitter_rbis/runs still
  carry an implausibly low fair_over_prob (base-rate junk from the one-sided
  de-vig) — these are ALREADY muted on the board (consensus) + excluded from
  Featured Plays + /results, so they don't reach a paying user as "edges". A
  negative-binomial (over-dispersed) model_over_prob is a future refinement once
  calibration data accumulates.

Build-readiness audit (this session, for monetization):
- Migration audit (read-only, since removed): 13/13 column-adding migrations
  APPLIED. player_game_logs has all 81 columns (every data-foundation +
  context-feature col present, prefixed pitcher_*/hitter_*). All 11 FEATURE_COLS
  resolve (last30_k_rate/is_home are derived at train time, not stored). Nothing
  dark, nothing for the user to run.
- Prioritized build to-do recorded: (1) DONE — Poisson edges above; (2) CLV
  (closing-line-value) tracking as the fastest credible proof of edge for the
  paid product; (3) line-data reliability (PRIZEPICKS_PROXY_URL in CI; ParlayAPI
  credit budget); (4) pitcher-ID resolution hardening; (5) gated/later —
  calibration (isotonic/Platt), context models for the non-K props, flip
  matchup-K when the scorecard goes green.

CLV (closing-line-value) tracking — the proof-of-edge engine (this session):
- WHY: for a monetizable product the one thing that matters is a provable edge.
  CLV (does the market move TOWARD the model's side between open and close) is the
  gold-standard LEADING indicator — measurable in WEEKS, before W/L accumulates.
- DATA GAP found: the `lines` table upserts on
  (player_id, prop_type, bookmaker, game_date), so it only ever holds the LATEST
  (closing-ish) line — NO history. CLV is therefore NOT computable retroactively;
  we have to start capturing the OPENING line going forward (like the matchup-K
  shadow, this is a "start collecting the proof" build).
- BUILT (all defensive, ZERO impact on the fragile lines pipeline):
  * db/migrations/add_line_opens.sql + db/schema.sql: new `line_opens` table
    (player, prop, book, day -> opening_line + prices + opening_fetched_at),
    unique on the same 4-key. ACTION REQUIRED: run it in Supabase to start CLV.
  * engine/db.py record_line_opens(rows): keep-FIRST capture via
    upsert(..., ignore_duplicates=True) = INSERT ON CONFLICT DO NOTHING, so only
    the day's EARLIEST line per key is stored; later crons are no-ops. Verified
    ignore_duplicates IS supported by supabase-py 2.30.1. Catches a missing table
    (pre-migration) and skips — never touches upsert_lines.
  * engine/main.py: calls record_line_opens(line_rows) right after upsert_lines
    (own try/except). Separate table + ignore-duplicates, so it can't affect the
    live lines.
  * engine/clv_scorecard.py: daily LOG-ONLY, READ-ONLY scorecard (mirrors the
    matchup-K one). Joins line_opens (open) + lines (close) + projections (frozen
    proj) per (player, prop, day), picks the sharpest book present in BOTH
    (Pinnacle first), and computes lean = proj vs OPENING line, clv_points =
    (close - open) * (+1 over / -1 under). Reports, over the lines that MOVED, the
    share that moved toward the model + avg signed CLV, broken out for Pinnacle
    (the credible signal). Hooked into main() on the full run (after the matchup-K
    scorecard), try/except wrapped.
- VERIFIED: py_compile clean (db / main / clv_scorecard); the scorecard degrades
  gracefully pre-migration ("line_opens read skipped (PGRST205) -- apply
  add_line_opens.sql" -> "no opening lines captured yet"); ignore_duplicates
  confirmed in the installed supabase-py. Engine-only; FEATURE_COLS (11) + live
  projections/edges untouched.
- HOW IT FILLS IN: after the migration, every cron records opening lines
  (keep-first); the closing line is the live lines.line; CLV needs the line to
  MOVE (open != close), so the daily log shows real numbers within days-to-weeks.
  Positive CLV on Pinnacle = the market is moving toward the model = the receipt
  you need to charge for picks.
- ACTION REQUIRED (user): run db/migrations/add_line_opens.sql in the Supabase
  SQL editor. Until then the pipeline runs cleanly and the CLV log says "no
  opening lines captured yet".

End-of-session health check + line_opens RLS fix (this session):
- Read-only health check: ALL engine modules import clean; FEATURE_COLS=11;
  model.train() fits against live data (830 rows -> 78 pitcher rows -> 0 NaN
  after imputation -> XGBoost FITTED). GitHub Actions: last 7 runs all green +
  a scheduled run mid-session succeeded exercising the new Poisson/CLV code.
- BUG caught via the production Actions log (would have been silent): the CLV
  capture was failing with "new row violates row-level security policy for table
  line_opens" (code 42501). add_line_opens.sql enabled RLS with a read-only
  policy, but the engine writes with the ANON key (db._client falls back to anon;
  the project's other write tables have RLS OFF — the engine never used a
  service_role key in CI). RLS + read-only policy therefore BLOCKED every CLV
  insert — CLV would have captured nothing, silently (record_line_opens degrades
  gracefully).
- FIX: line_opens is engine-internal (frontend never reads it), so it needs NO
  RLS. add_line_opens.sql now does `disable row level security` instead of
  enabling it. db/schema.sql already had no RLS on line_opens (only the migration
  did). USER ACTION (one-time, live DB already has the table):
    alter table line_opens disable row level security;
  After that the next cron's record_line_opens succeeds and CLV starts capturing.
  (Proper long-term alternative: set SUPABASE_KEY to the service_role in CI
  secrets — then RLS can stay on everywhere and writes bypass it. Separate
  hardening; not required for CLV to work.)
- NOTE (not a bug): the 11 PM ET scheduled run logged "edges: 0 computed, 1620
  skipped (no line)" — expected late-night behavior (that day's markets closed,
  next day's lines keyed to the next date), not the Poisson change. Existing
  edges persist (upsert, not delete); the morning full run recomputes them.

Projection-date timezone bug — hitters misfiled to the next day (this session):
- USER report: Featured Plays "left" (June 2 Hitting Edges + HR Matchups empty)
  AND June 3 showed "the same HR guys" as June 2. Read-only check nailed it:
  2026-06-02 hitter_home_runs = 0 rows; 2026-06-03 = 270 rows whose game_ids
  (822971, 823129, 823460, ...) are JUNE 2's games (e.g. 823129 = NYM@SEA, 9:40
  PM ET June 2). One bug caused BOTH symptoms: June 2's hitter projections were
  filed under projection_date 2026-06-03.
- ROOT CAUSE: the baseline/model projection builders default
  `proj_date = projection_date or date.today()` — date.today() is the SERVER's
  UTC date. After 8 PM ET (midnight UTC) the UTC date is already TOMORROW while
  et_today() (Eastern) is still today. main.py called the builders WITHOUT
  projection_date (main.py:343 pitcher loop, :584 hitter loop), so evening crons
  dated the build with UTC (June 3) while the skip/delete logic used et_today
  (June 2) — the mismatch emptied June 2 and dumped its hitters onto June 3. The
  pitcher full-build only runs in the morning (UTC==ET) so it never manifested;
  hitters rebuild/fill-in in the evening, so they did. This is the same class as
  the earlier "9 PM ET / 1 AM UTC" tz bug; the date.today() default was the
  remaining hole.
- FIX (root + explicit, engine-only): baseline.py (5 builders) and model.py
  (predict) now default `projection_date or et_today()` (Eastern), with et_today
  imported in both. main.py also passes projection_date=et_today()/today
  EXPLICITLY at both builder loops (belt-and-suspenders). Verified: py_compile
  clean; et_today resolves in baseline+model and all agree; FEATURE_COLS=11;
  the local check shows et_today (June 3 ET) differs from date.today (June 2
  local) — proving the gap the bug rode on.
- DATA CLEANUP (user runs once in Supabase): the already-misfiled rows are
  orphaned (June 2 games under projection_date June 3). Delete any projection
  whose date doesn't match its game's Eastern date:
    delete from projections p using games g
     where p.game_id = g.game_id and g.start_time is not null
       and p.projection_date <> (g.start_time at time zone 'America/New_York')::date;
  (June 2's hitter data for that past slate is lost — acceptable; June 3+ build
  correctly now.) Featured Plays "leaving" was THIS bug, not a design issue;
  they populate normally on a correctly-dated slate with real edges.

Stale banner now judged from the VIEWER's local date, not Eastern (this session):
- USER (Arizona, 9:34 PM June 2): the board showed the June 2 slate but with the
  amber "Showing June 2 projections — today's slate updates after 8 AM ET" banner,
  i.e. it called their CURRENT slate stale. Cause: page.tsx computed the stale
  flag as `date < todayET` where todayET = America/New_York. At 9:34 PM MST it's
  already 12:34 AM EDT (June 3), so June 2 (the viewer's actual today) read as a
  past slate.
- DISTINCTION: the slate DATA stays ET-keyed (MLB schedules are ET; the engine
  date fix above keeps projections on the right ET slate). Only the "is this
  stale FOR THE VIEWER" judgment should use the viewer's own calendar day — which
  is only knowable client-side.
- FIX (frontend-only): new web/app/StaleBanner.tsx (client). Computes the
  viewer's local date (new Date().toLocaleDateString("en-CA")) and shows the
  banner only when `date < browserToday && hasData && !hasCurrentProjections`.
  Renders null on SSR/first paint (state starts false, set in useEffect) so
  there's no hydration mismatch. page.tsx removed the server `todayET`/`isStale`
  computation + the dead formatDate helper (moved into StaleBanner) and renders
  <StaleBanner date hasData hasCurrentProjections/>.
- The DEFAULT slate date is unchanged and already lands correctly: getSlate
  resolves earliest projection_date >= todayET else the latest, and since a new
  ET day's projections aren't built until ~8 AM ET, an evening viewer in any US
  tz falls back to the latest (current) slate. So only the banner needed fixing.
- VERIFIED: tsc --noEmit clean; npm run build passes (/ 12.9 kB). For the Arizona
  9:34 PM case, June 2 == browserToday -> banner suppressed.

Self-healing misdated-projection guard — no manual cleanup ever (this session):
- CONTEXT: after the et_today() builder fix, the manual SQL cleanup of the
  already-misfiled June 3 rows was a one-time chore (I ran it via the client:
  1800 misdated rows under projection_date 2026-06-03, all referencing June 2
  game_ids, deleted -> 0; the correct future-preview June 3 games + starters,
  e.g. SD@PHI 823456 Buehler/Sánchez, were verified intact). The future-preview
  was never broken — the misdated projections were just overshadowing it.
- USER wants it to "update automatically every day" with no manual SQL.
- IMPLEMENTED: db.cleanup_misdated_projections() — pure-Python SELF-HEAL (NO
  migration). Each run it deletes any projection whose projection_date != its
  game's Eastern (start_time) date. Scoped to projection_date >= et_today()-1
  (only current/future rows can be misdated). Paginates projections, maps
  game_id -> ET date from games.start_time, deletes the mismatches grouped by
  the wrong date. Fully defensive (try/except, never raises). main.py calls it
  right after the pitcher+hitter pipelines (before lines/edges), wrapped again.
- Belt-and-suspenders: the et_today() fix PREVENTS misdating; this self-heal
  CATCHES anything that ever slips through, on the very next cron — so the daily
  slate stays clean automatically, zero manual SQL. Normally deletes 0.
- VERIFIED: py_compile clean (db, main); standalone run removed 0 (June 3
  already clean, nothing else misdated) — confirms it doesn't touch correct rows
  and runs without error. Engine-only; takes effect next cron run.

New prop: hitter_hits_runs_rbis (H+R+RBI combo) end-to-end (this session):
- Added a full new prop type mirroring hitter_total_bases across EVERY layer.
  Combo = hits + runs + RBIs, graded against the standard ~1.5 main betting
  line. It is a BETTING-EDGE prop (real two-sided book lines), NOT a Model-
  Tracker prop. FEATURE_COLS unchanged (11) — not a model input.
- Engine:
  * stats.get_hitter_games: new computed field hits_runs_rbis = hits + runs +
    rbis (same MLB Stats API gameLog response, additive).
  * baseline.build_hitter_hits_runs_rbis_projections — thin wrapper over the
    generic _build_hitter_from_games("hits_runs_rbis", "hitter_hits_runs_rbis",
    "HRR"). Weighted rolling mean like the other hitter props (NOT median —
    that's only for the skewed fantasy_score props).
  * main.py: added to the hitter builder loop (builds in the same lineups-
    posted pass as hits/TB/etc.).
  * grade.py: _hitter_result + grade_hitters_yesterday write
    actual_hits_runs_rbis = hits + runs + rbi from the boxscore batting line.
  * lines.py: PROP_TO_MARKET hitter_hits_runs_rbis -> player_hits_runs_rbis;
    MARKET_TO_PROP maps player_hits_runs_rbis (+ defensive _thrown /
    +-separated response-key variants) back. Two-sided book, so edges flow
    through edge.py unchanged (prop-generic).
  * db.py: _HITTER_PROP_TYPES + _CONTEXT_COLS strip list include the new prop
    / actual column (PGRST204 strip-and-retry pre-migration).
  * calibrate.py _ACTUAL_COL + schemas.HitterGameLogRow field.
- DB: db/migrations/add_hits_runs_rbis.sql (actual_hits_runs_rbis integer on
  player_game_logs) + schema.sql. ACTION REQUIRED: run the migration once in
  Supabase — until then grading PGRST204-strips the actual gracefully;
  projections/lines/edges/board all work immediately, the graded actual lands
  once applied.
- Frontend: types.ts PropType; constants.ts ALL_PROP_TYPES + HITTER_PROPS +
  MIN_LINE 1.5 + FEATURED_MIN_LINE 1.5 + PROP_LABELS "Hits+Runs+RBIs" (NOT in
  TRACKER_PROPS); PropBoard.tsx PROPS tab + liveActualFor combo branch
  (hits + runs + rbi from the live boxscore); page.tsx FEATURED_HITTER_PROPS +
  FEATURED_ACTUAL_COL; results/page.tsx ACTUAL_COLUMN + FEATURED_RESULT_PROPS +
  DIAG_PROPS; ResultsBoard.tsx BETTING_HITTER_PROPS; FeaturedPlays.tsx +
  featured-insights route labels/noun.
- VERIFIED: get_hitter_games computes the combo (hits 1 + runs 1 + rbis 2 = 4);
  builder produced a real projection (Julio Rodriguez 2.3 HRR); py_compile clean
  (8 engine files); tsc --noEmit clean; npm run build passes. Committed +
  pushed (d1fe41f). Goes live on the board/lines/edges on the next cron; graded
  results populate once the migration is applied and games grade.

HFS (hitter fantasy score) collection — fixed going forward (confirmed):
- Yes. The June 2 gap (empty Hitter Fantasy + missing June 2 game on /results)
  was the projection-date timezone bug (hitters misfiled to the next ET day),
  now fixed at root (builders default et_today(); main.py passes it explicitly;
  cleanup_misdated_projections self-heals on every cron). HFS itself was already
  correct (PrizePicks-direct standard line + median projection + grading). So
  from a correctly-dated slate forward, HFS collects and grades normally; the
  one-time June 2 hitter data is lost (acceptable, not backfilled).

All-Props game cards show pitchers + hitters (already built; lineup-visibility
fix) (this session):
- STEP 0 confirmed the game-first redesign ALREADY renders both a Pitchers
  section AND a Hitters section in the SAME GameCard under the "All props"
  filter (focus === "all"), both folded into the card's smart expand/collapse,
  both using the same PlayerChipsRow/PropChip (H/TB/HRR/RBI/R/HR/FP chips), with
  the existing "Show N more hitters" expander and governed by Expand/Collapse
  all. The earlier "only pitchers" screenshot was the June 2 slate (zero hitter
  projections — the timezone-bug data gap), NOT a rendering gap; June 3 has full
  hitter data (incl. 54 HRR rows) so both sections render.
- The one genuine gap closed: when an expanded game had hitters but NONE with a
  qualifying real-book edge, the hitters section rendered EMPTY (just a "Show all
  N hitters" button) — the lineup was fully hidden until a click. PropBoard.tsx
  now shows DEFAULT_HITTER_COUNT=3 hitters by default in that case (gv.hitters is
  already sorted strongest-edge-first), with the rest behind the existing "Show N
  more" expander. Common games (with TB edges) are UNCHANGED — defaultHitters =
  edgeHitters there. Collapsed cards are untouched (still header + one-line
  CollapsedSummary), so a 15-game slate stays compact when collapsed; the top-3
  hitters only render when a card is EXPANDED.
- Single-prop focus unchanged: a pitcher prop shows only pitchers, a hitter prop
  shows only hitters (FocusedPlayerCard path). Scope: PropBoard.tsx presentation
  only — no edge math, selection, Featured Plays, HR composite, /results,
  live-overlay, or engine touched; FEATURE_COLS still 11. tsc clean; npm run
  build passes (/ 13 kB).

Pre-game hitter coverage — two evening crons close the 2-8 PM ET gap (this
session):
- USER want: see the HITTERS section pre-game (to analyze hitters), like the
  live game shows it. STEP-0 diagnosis (read-only, live DB) proved this is a
  DATA/TIMING issue, NOT a frontend gap: on the 2026-06-03 slate, 6 of 15 games
  had hitter_hits projections, and those 6 were EXACTLY the games whose lineups
  were currently posted (fetch_lineups() returned the same 6 game_ids); the
  check "games with a POSTED lineup but NO hitter projections" = [] — i.e. the
  board already renders hitters for every game that HAS a posted+built lineup.
  The 9 without hitters had no lineup posted yet (first pitches 6:40-9:40 PM ET).
  Hitter projections are per-batter in the posted batting order, so they CANNOT
  exist until MLB posts the lineup ~60-90 min before first pitch.
- ROOT CAUSE of the missing pre-game coverage: the cron schedule had a 6-hour
  hole between the 2 PM ET (18 UTC) and 8 PM ET (0 UTC) runs. Evening lineups
  post in that window (~4:30-7 PM ET) but nothing built them until 8 PM ET —
  often AFTER first pitch — so pre-game evening games showed only pitchers.
- FIX (.github/workflows/refresh.yml ONLY): added two crons — 0 21 * * *
  (5 PM ET) and 0 23 * * * (7 PM ET) — so the _run_hitter_pipeline fill-in
  builds newly-posted evening lineups within ~1h of posting. Now 9 runs/day.
  Capped at TWO extra runs to respect the ParlayAPI credit budget (1000/month,
  3 credits/props() call): 7 runs ~= 630/mo -> 9 runs ~= 810/mo (safe margin;
  adding more would risk blowing the budget and breaking LINES ingestion).
  No engine change needed — the refresh-path hitter fill-in already builds
  late-posting lineups (documented in the hitter-coverage notes above).
- Expectation set: hitters appear ~60-90 min before first pitch (when MLB posts
  the lineup), NOT hours before — an MLB constraint, not ours. The two new runs
  just make them show up promptly once the lineup is up, instead of waiting for
  the 8 PM ET run. YAML validated (9 crons parse).

Featured Plays diagnosis + hitter min-history gate (this session):
- USER concern: a Featured Plays card (Gleyber Torres, Total Bases, proj 4.0 vs
  line 1.5, edge +0.54) looked like it might be reflecting LIVE in-game data
  (Torres already had 3 TB mid-game). DIAGNOSED against the live DB:
  * NOT a live-data leak. All featured projections (Torres/Vargas/Yandy) were
    written at 15:26 UTC (11:26 AM ET) and never updated; first pitch was
    17:10 UTC (1:10 PM ET) — locked ~1h44m PRE-GAME. Featured Plays reads the
    stored, frozen projections/edges (page.tsx getSlate -> buildEdgePlays); the
    live box-score overlay is ONLY on the main board (PropBoard), never here. So
    the pre-game-freeze behavior is CORRECT.
  * The REAL issue: Torres had 0 graded TB games -> the baseline rolling average
    just echoed one recent big game -> absurd 4.0 TB projection -> inflated +0.54
    edge -> headlined the section. Verified the pattern across the candidate pool:
    every hitter with >=2 graded games had a sane proj (2.1-2.7) + edge
    (+0.24-0.30); only the 0-history Torres was the 4.0/+0.54 outlier.
- FIX (frontend-only, mirrors the HR min-sample guard): new
  HITTER_MIN_GAMES_TRACKED=2 in web/lib/constants.ts. page.tsx buildEdgePlays no
  longer slices to top-3 internally; the PITCHING section slices as before, but
  the HITTING section now gates candidates on >= 2 graded games (counted via
  actual_total_bases, non-null on every graded hitter row, so it covers hits AND
  TB) BEFORE the top-3 cut. Same paginated graceful-degrade-on-error as the HR
  gate (a broken query never empties the section). NOT applied to pitchers —
  pitchers have ~1 graded start early-season, so a 2-gate would empty PITCHING.
- RESULT: Torres (0 graded) drops out; the new hitting top-3 becomes
  Bleday/Acuña/Kurtz (all 2-3 graded, proj 2.5-2.7, edge +0.29-0.30). Section
  stays full with legit, track-record-backed plays. Note: this gates only the
  curated Featured Plays top-3 — thin-history hitters still appear on the normal
  hitter prop tabs (the 4.0 is still a real, if poor, pre-game projection; the
  deeper fix is regression-to-mean on thin-sample hitter baselines, an ENGINE
  change deferred). tsc clean; npm run build passes (/ 13 kB). Scope: page.tsx +
  constants.ts only; no engine, no /results, no FEATURE_COLS change (still 11).

Calibration scorecard — measure before correcting (this session):
- Calibration plan agreed: (1) MEASURE first, (2) fix upstream projection bias,
  (3) pooled per-prop probability calibration, (4) per-prop isotonic/Platt once
  data is deep. Isotonic now would overfit thin early-season data — deferred.
- BUILT step 1: engine/calibration_scorecard.py — daily LOG-ONLY, READ-ONLY,
  mirrors the CLV/matchup-K scorecards (full-run only, in the `not is_refresh`
  block in main.py). Joins edges.model_over_prob to the graded actual (one
  sharpest-book pair per player/prop/day, via calibrate._ACTUAL_COL on
  player_game_logs), drops pushes, and logs per prop: Brier, the base-rate Brier
  (p̄(1-p̄) = always-predict-base-rate reference), calibration-in-the-large
  (mean predicted vs mean over = the bias gap), and a coarse reliability table.
  NEVER touches projections/edges. _LOOKBACK_DAYS=180; _MIN_PAIRS=12 below which
  a prop reads "thin sample"; _BIAS_GAP=0.05.
- FIRST FINDING (1535 graded pairs, live DB) — big + actionable:
  * POOLED pred 0.70 vs actual 0.41 (gap +0.29), Brier 0.357 > base 0.242 —
    i.e. the probabilities are currently ANTI-informative in aggregate, driven
    entirely by a severe hitter OVER-bias.
  * WELL-CALIBRATED: strikeouts (pred 0.59 / act 0.60) and earned_runs (0.60 /
    0.62) — the props with good projections. hits_allowed (+0.10) / outs (+0.05)
    are mild. strikeouts being clean VALIDATES the scorecard itself.
  * HEAVILY OVER-BIASED (predict the over far too often): hitter_rbis +0.44,
    hitter_home_runs +0.44, hitter_runs +0.34, hitter_hits +0.31, hitter_total_
    bases +0.28, walks +0.22. hitter_hits reliability is damning: 384/474 pairs
    sit in the top bucket at pred 0.92 vs act 0.55 — the model slams "over" with
    huge confidence and it's a coin flip.
  * KEY: hitter_total_bases uses REAL pinnacle two-sided lines (not just the
    consensus synthetic line) and STILL shows +0.28 — so the hitter over-bias is
    a genuine PROJECTION-centering problem, not merely a consensus-de-vig
    artifact. This is the root cause of the inflated hitter edges + the 75%-over
    lean splits + the Torres-type fake plays.
  * NUANCE: strikeouts is unbiased in-the-large but its reliability curve is
    nearly FLAT (act ~0.57-0.62 across all predicted buckets) -> "Brier ~= base
    rate" verdict fires: unbiased but not yet DISCRIMINATIVE. Honest.
- NEXT (step 2, not yet built): center/regress the hitter projections (the
  mean->median lesson generalized + thin-history regression-to-mean) to drive
  the hitter gap toward 0; re-read the scorecard's Brier/gap to confirm. The
  pitcher props are already ~calibrated. Verified: py_compile OK; scorecard runs
  read-only end-to-end; FEATURE_COLS still 11; no projection/edge math touched.

Calibration step 2 INVESTIGATED -> NOT BUILT (the centering fix would HARM)
(this session):
- Asked to build the hitter projection-centering fix. DIAGNOSED the mechanism
  first (the right discipline) and it KILLED the fix — three findings:
  1. Projection is NOT high. mean(model_proj) vs mean(actual): hitter_total_bases
     1.46 vs 1.97 (projBias -0.51), hitter_hits 0.83 vs 0.94 (-0.11), rbis/runs
     also negative. Projections are if anything slightly LOW, so "center down"
     would have made calibration WORSE, not better.
  2. The scorecard's over-bias was 100% PRE-POISSON. The Poisson fix (de86179)
     landed 2026-06-03 03:39 UTC; every graded pair in the 180-day window is
     pre-fix (post-fix games aren't graded yet), so it stored the OLD
     normal-approximation prob. Split by era: pre-Poisson ALL gap +0.34; post:
     no graded data yet.
  3. The current Poisson code is sane: stored model_over_prob on the latest slate
     EXACTLY matches a fresh poisson.sf(floor(line), proj) recompute, and
     proj~=line -> ~0.5 (proj 1.6/line 1.5 -> 0.48; 1.7 -> 0.51).
- ROOT-CAUSE: the scorecard was reading the STALE stored edges.model_over_prob,
  so it reported an already-fixed bug that would persist for months until old
  rows aged out of the window.
- FIX (calibration_scorecard.py only): recompute P(over) FRESH from the stored
  projection + line via the live edge._model_over_prob, so the scorecard measures
  the CURRENT model on the whole graded history at once. Re-run on the same 1535
  pairs: POOLED gap +0.29 -> -0.02, Brier 0.357 -> 0.228 (now BELOW base 0.242 =
  informative). hitter_hits 0.47/0.50, hitter_total_bases 0.46/0.46,
  hitter_runs/HR all well-calibrated; reliability curves track the diagonal. The
  Poisson fix ALREADY solved the hitter over-bias.
- RESIDUALS to WATCH (not fix — thin n, and they're UNDER not over, so NOT a
  centering-down candidate): strikeouts -0.12 (n=63), earned_runs -0.18 (n=50);
  flat/noisy reliability, likely small-sample + selection. Let them accumulate.
- NET: no projection/baseline/edge code changed; the only change was making the
  scorecard honest (measure the live model). The hitter centering fix was
  correctly NOT built — it would have harmed a model that's already calibrated.
  Next calibration step is now "wait for post-Poisson graded data + watch the
  two under-biased pitcher props," NOT a projection change. FEATURE_COLS 11.

Pre-game hitter coverage — project every hitter with a line (this session):
- USER report (screenshots): (1) only ONE team's hitters showed per game (e.g.
  KC@CIN showed 9 Royals, no Reds); (2) later/not-yet-started games showed no
  hitters at all — "there are lines for these hitters, so why can't we show the
  projections." DIAGNOSED (live DB): both are the SAME root cause. Hitter
  projections were built ONLY for confirmed-lineup players (fetch_lineups), which
  post ~60-90 min before first pitch and team-by-team. On the 6/3 slate: 269
  hitters had a hitter-prop LINE but only 90 were projected (178 lined-but-
  unprojected); fetch_lineups returned both KC+CIN now but only KC had been built
  when the cron ran.
- FIX (engine, ADDITIVE + DEFENSIVE — never touches the skip/stale/delete logic):
  new main._fill_in_lined_hitters, called EVERY cron after _run_hitter_pipeline.
  * db.get_hitter_line_players_for_date(date) -> {player_id: name} for distinct
    hitters with ANY hitter-prop line today (paginated).
  * fetch.build_expected_hitters(line_players, games, exclude_ids): resolves each
    missing hitter's TEAM via the MLB /people bulk call (_fetch_handedness_by_id,
    which already returns currentTeam name matching games.home_team) and maps it
    to today's game (home_team->home / away_team->away) -> the game_id + home_away
    the rolling baseline builders need. batting_order=0 (not a confirmed slot; the
    builders don't use it). Players whose team isn't on the slate are dropped.
  * Builds ONLY lined hitters MISSING a hitter_hits projection (purely additive —
    no delete), upserts them, adds them to name_to_id so the lines fetch resolves
    their lines and edges compute. If it builds any, main() sets all_projections
    = [] so _run_lines_and_edges re-fetches the COMPLETE set (bulk + fill-in) from
    the DB. Any failure logs + returns 0; the pipeline is unaffected.
- WHY it covers both issues: it's anchored on LINES (which the books post hours
  ahead for both teams of every game), not on confirmed lineups — so the second
  team AND later games both get projected pre-game. Speculative downside (a line
  for a player who ends up benched) is harmless: an extra projection that simply
  doesn't grade.
- VERIFIED end-to-end (ran the pipeline on the live 6/3 slate): read-only test
  resolved 178/179 missing -> 89/89 home/away (both teams); the live run built
  157 lined hitters across 15 games, recomputed 647 edges on 2072 projections;
  post-run coverage = 15/15 games have hitter projections (14-22 each, 270 total
  hitter_hits rows) — every previously-empty later game now covered, KC@CIN 9 ->
  19 (Reds filled in). py_compile OK; FEATURE_COLS untouched (11); no frontend
  change (the board already renders hitters whenever they exist). Self-maintains
  every cron as lines post for later games.

Hit-rate trends panel (props.cash-style) — focused card only (this session):
- Research (deep-research workflow) into props.cash/pickfinder/Outlier: their
  centerpiece is a HIT-RATE TRENDS table (L5/L10/L15/H2H/SZN/Streak/Diff) that is
  mostly DISPLAY computed from game logs, not a model. (The workflow burned ~1.6M
  tokens and its verifier misfired — 0-0 votes marked all claims "refuted", a
  harness bug, not genuine refutation; the surfaced facts were correct. Do NOT
  re-run it casually — expensive.)
- BUILT the safest highest-value item: a hit-rate trends row. PURE DISPLAY — no
  projection/edge/model/FEATURE_COLS involvement (still 11). Frontend-only.
- CONGESTION DISCIPLINE (user: strict about UI congestion): renders ONLY in the
  FOCUSED single-prop card (the deep-dive view you get tapping a chip), REPLACING
  the L5 spark-dot row — so the dense all-props chip grid gains nothing and the
  focused card gains zero net lines. One quiet tabular line.
- web/app/page.tsx: TREND_ACTUAL_COL (5 pitcher + 6 hitter main props; fantasy
  omitted — computed total, not one graded column). The existing recent-form
  fetch now reads ALL slate players (was pitcher-only) + all trend columns
  (resolveExistingColumns-guarded against a pending migration) so ONE read serves
  both the spark dots (unchanged) and trends. trendsFor(player, prop, line)
  computes per-window over-rate vs the line + Diff (avg-L10 − line) + signed
  streak. Attached as row.trends next to recentForm.
- web/lib/types.ts: Trends/TrendWindow + Pitcher.trends.
- web/app/PropBoard.tsx: TrendRow (Hit% L5/L10/L15/SZN, each toned emerald >=60%
  / red <=40% / slate; + "±X vs line"; + a ▲/▼N streak chip only when |streak|>=2
  so 1-game noise is hidden). Swapped in for <RecentFormDots/> in
  FocusedPlayerCard. The dots code (sparkFor/recentForm/RecentFormDots) is left in
  place but unrendered — superseded; harmless, prune in a later cleanup.
- VERIFIED: trend math exact vs raw logs (Tommy Troy TB [5,0,0] vs line 1.5 ->
  1/3 = 33% all windows, Diff +0.2, streak +1); tsc clean; npm run build passes
  (/ 13.2 kB). Thin early-season history shows as a small honest sample (like the
  confidence bar) and fills out as games accumulate. Committed 954c76b.
- ROADMAP (researched, not yet built; all gated on the same measure->validate
  discipline): de-vig fair% + book IP display (you already compute fair_over_prob
  — just surface it), multi-book line-shopping row (per-book lines already in the
  lines table), DVP-style opp-pitcher matchup tag for hitters (opp_sp_* exist),
  Statcast quality-of-contact display (barrel%/hard-hit%>=95mph/xwOBA — sweet-spot
  + EV already pulled), Shin de-vig as an OPTIONAL edge.py tweak (changes edges ->
  must pass the calibration scorecard before/after). Pitcher props are already
  ~calibrated; hitter over-bias was the old pre-Poisson math, already fixed.

De-vig display (roadmap #1) — Fair% vs Book% on the focused card (this session):
- Surfaces the de-vigged fair over-probability the engine ALREADY computes
  (edges.fair_over_prob) next to the book's raw implied % (with vig), as a quiet
  text-[10px] sub-line under the existing edge line in the FOCUSED single-prop
  card ONLY (congestion: the all-props scan grid is untouched; no new card lines
  beyond the one sub-line). Fair↔Book gap = the vig; the edge arrow above = model
  vs Fair. Pure display — no engine/model/FEATURE_COLS (11) change.
- web/app/PropBoard.tsx only: new americanToImplied(price) helper; EdgeDetail's
  two-sided-edge branch returns a fragment with the edge div + the Fair/Book line.
  Fair shown whenever fair_over_prob exists (real OR consensus edges); Book only
  when over_price exists (consensus edges carry no price).
- VERIFIED vs live pinnacle edges: Fair sits ~4 pts below Book (the juice), e.g.
  over −143 -> Book 59% / Fair 55%; Fair→Model reproduces the stored edge exactly
  (74−55 = +0.19). tsc clean; npm run build passes (/ 13.4 kB). Committed f96f26d.
- Roadmap remaining (researched): multi-book line-shopping row, DVP opp-pitcher
  tag, Statcast quality display (barrel/hard-hit/xwOBA), Shin de-vig (gated on
  the calibration scorecard).

Inline detail-on-demand — the All-props UX fix (this session):
- USER felt the detail (Fair/Book, edge, trends, confidence) being only on the
  per-prop FOCUSED tab (not All-props) was suboptimal; wanted "the cleanest UI +
  most useful extensive data." Root friction: tapping an All-props chip SWITCHED
  the whole board to that prop's focused view (lost the overview).
- FIX (PropBoard.tsx only, pure display): tapping a chip now opens that play's
  full detail INLINE directly under the player's chip row (props.cash-style
  detail-on-demand) — you keep the All-props overview AND get depth. New
  InlinePropDetail composes the SAME leaf components the focused card uses
  (EdgeDetail w/ Fair/Book, ConfidenceBar, TrendRow, OppContextLine/WindCardLine,
  SharpBadge, ProjectionBadge) — no logic duplication — plus an "all <prop> ->"
  link to the cross-game focused view.
- CONGESTION CONTROL (user's hard constraint): board-wide single openDetail state
  (`${playerId}|${prop}`) -> only ONE panel open anywhere at a time; tapping the
  open chip or another closes/replaces it; open chip gets an emerald ring.
  Switching prop TABS clears the open panel (selectFocus). The prop tabs still
  drive cross-game single-prop focus; chip tap is now "peek detail in place".
- PropChip: onFocus(prop) -> onTap() + active ring; title "tap for detail/close".
  PlayerChipsRow + GameCard thread openDetail/onToggleDetail/onViewAll + homeTeam
  /wind. No engine/model/FEATURE_COLS (11) change. tsc clean; npm run build passes
  (/ 13.9 kB). Committed 0b6cafb.

Next: ongoing — let the cron run, accumulate data, monitor Actions logs for
WARNING lines (incl. the daily matchup-K + CLV + calibration scorecards +
self-heal count + lined-hitter coverage count).

## Keeping this file current
At the end of each session, update the "Current status" section and record any
new decisions or conventions, so the next session stays in sync.