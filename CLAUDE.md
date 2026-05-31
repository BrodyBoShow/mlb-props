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

Next: ongoing — let the cron run, accumulate data, monitor Actions logs for
WARNING lines.

## Keeping this file current
At the end of each session, update the "Current status" section and record any
new decisions or conventions, so the next session stays in sync.