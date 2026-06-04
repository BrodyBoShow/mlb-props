-- players: one row per MLB player, refreshed each run
create table if not exists players (
    player_id   integer primary key,   -- official MLBAM id
    full_name   text not null,
    team        text,
    position    text,
    bats        text,                  -- L, R, or S (switch)
    throws      text,                  -- L or R
    player_type text default 'pitcher' -- 'pitcher' | 'hitter'
);

-- games: one row per scheduled game
create table if not exists games (
    game_id          integer primary key,   -- official MLB game id
    game_date        date not null,
    home_team        text not null,
    away_team        text not null,
    status           text,                  -- scheduled, live, final
    start_time       timestamptz,           -- first pitch in UTC; used to sort cards chronologically
    -- Probable starters resolved from statsapi.schedule via fetch._resolved_schedule.
    -- Populated by engine/main._run_future_previews for next-3-day previews and
    -- by every refresh run for today/yesterday so the frontend's FutureSlate
    -- component can render matchup + probable-pitcher cards before projections.
    home_starter_id  integer references players(player_id),
    away_starter_id  integer references players(player_id),
    -- Game-time wind (db/migrations/add_game_weather.sql). DISPLAY-ONLY — powers
    -- the HR-card wind tag; persisted each cron run by engine/main._run_game_weather.
    -- NOT a model input. wind_dir_deg is OWM's meteorological FROM direction.
    wind_speed_mph   numeric,   -- mph; 0 for dome venues, NULL if no weather key
    wind_dir_deg     numeric,   -- degrees the wind blows FROM (0=N); NULL dome/no-data
    is_dome          boolean,   -- true → frontend shows "Dome · neutral"
    created_at       timestamptz default now()
);

-- player_game_logs: one row per pitcher per game, graded after the game is final.
-- Accumulates over the season and feeds XGBoost retraining.
-- Upsert key: (player_id, game_id) — re-running the grading job never duplicates.
create table if not exists player_game_logs (
    id                serial primary key,
    player_id         integer references players(player_id),
    game_id           integer references games(game_id),
    game_date         date,
    player_type       text default 'pitcher',  -- 'pitcher' | 'hitter'
    -- true = season backfill (actuals only, no features). model.train() EXCLUDES
    -- these so the model is untouched; trends + confidence use all rows.
    backfilled        boolean default false,
    -- pitcher actuals
    actual_strikeouts    integer,
    actual_hits_allowed  integer,
    actual_walks         integer,
    actual_earned_runs   integer,
    actual_outs_recorded integer,
    actual_first_inning_pitches integer,  -- starter's 1st-inning pitch count (live feed)
    actual_first_inning_strikeouts integer,  -- starter's 1st-inning strikeout count (live feed)
    -- game-level NRFI/YRFI actual: total 1st-inning runs by both teams, stored on
    -- the carrier (home starting pitcher) row for the first_inning_runs prop.
    actual_first_inning_runs    integer,
    -- hitter actuals
    actual_hits          integer,
    actual_total_bases   integer,
    actual_hits_runs_rbis integer,   -- hits + runs + rbis combo (main line ~1.5)
    actual_rbis          integer,
    actual_runs        integer,
    actual_home_runs   integer,
    -- hitter component columns (needed to recompute fantasy score from history
    -- and to project hitter_fantasy_score from a hitter's recent games).
    doubles            integer,
    triples            integer,
    hit_by_pitch       integer,
    stolen_bases       integer,
    -- pitcher decision needed for the W bonus in pitcher fantasy score.
    actual_win                    boolean,
    -- fantasy-score actuals — PrizePicks scoring, computed from components.
    actual_hitter_fantasy_score   numeric,
    actual_pitcher_fantasy_score  numeric,
    home_away         text,        -- 'home' | 'away'
    opp_k_rate        numeric,     -- opposing team K% as batters (0–1)
    days_rest         integer,
    -- ── advanced matchup context features (additive, all nullable) ───────
    -- Populated by engine/grade.py once db/migrations/add_context_features.sql
    -- has been applied. The XGBoost model imputes NULLs with league averages
    -- so adding columns never blocks training. As graded data with real
    -- values accumulates, the model picks up signal automatically.
    -- Pitcher-row context:
    lineup_lhh_pct        numeric,
    lineup_rhh_pct        numeric,
    pitcher_k_vs_lhh      numeric,
    pitcher_k_vs_rhh      numeric,
    pitcher_fastball_pct  numeric,
    pitcher_breaking_pct  numeric,
    pitcher_offspeed_pct  numeric,
    pitcher_avg_velo      numeric,
    pitcher_velo_trend    numeric,
    park_factor_hits      numeric,
    park_factor_k         numeric,
    pitcher_pitches_last_start integer,
    -- Hitter-row context:
    opp_sp_k_rate_last5   numeric,
    opp_sp_era_last5      numeric,
    opp_sp_whip_last5     numeric,
    opp_sp_hand           text,        -- 'L' | 'R' (handedness of opposing SP)
    opp_sp_projected_ip   numeric,
    opp_bullpen_era_7day  numeric,
    opp_bullpen_k_rate_7day numeric,
    hitter_avg_vs_hand    numeric,
    park_factor_hits_h    numeric,
    temperature           numeric,
    wind_speed            numeric,
    -- ── data-foundation columns (db/migrations/add_data_foundation.sql) ──
    -- Pure data-collection: every column is nullable. FEATURE_COLS in
    -- engine/model.py stays at 11 — these feed the model later (mid-season)
    -- once enough graded rows accumulate to measure feature importance.
    -- Rest & fatigue (pitcher)
    pitcher_days_rest          integer,
    pitcher_starts_last_21d    integer,
    pitcher_pitches_last_3starts integer,
    pitcher_innings_last_21d   numeric,
    -- Rest & fatigue (team / hitter)
    team_games_last_3d         integer,
    team_games_last_7d         integer,
    hitter_games_last_7d       integer,
    is_day_game                boolean,
    is_getaway_day             boolean,
    -- Recent form (hitter)
    hitter_avg_last7           numeric,
    hitter_avg_last15          numeric,
    hitter_k_rate_last7        numeric,
    hitter_ops_last15          numeric,
    hitter_hr_last15           integer,
    -- Recent form (pitcher)
    pitcher_k_rate_last3       numeric,
    pitcher_era_last3          numeric,
    pitcher_whip_last3         numeric,
    -- Bullpen exposure (hitter; currently all-NULL scaffold)
    opp_bullpen_era_14d        numeric,
    opp_bullpen_k_rate_14d     numeric,
    opp_bullpen_whip_14d       numeric,
    opp_bullpen_innings_last3d numeric,
    -- 30-day pitcher platoon + plate-discipline from Statcast
    pitcher_k_vs_lhh_30d       numeric,
    pitcher_k_vs_rhh_30d       numeric,
    pitcher_whiff_pct_30d      numeric,
    pitcher_csw_pct_30d        numeric,
    -- Series / travel context
    series_game_number         integer,
    is_home_team               boolean,
    -- Weather (game time)
    temperature_f              numeric,
    wind_speed_mph             numeric,
    wind_dir                   text,
    is_dome                    boolean,
    precipitation_pct          numeric,
    created_at        timestamptz default now(),
    unique (player_id, game_id)
);

-- projections: one row per player + prop + game per day
-- UPSERT key: (game_id, player_id, prop_type, projection_date)
-- Re-running the job updates in place — never duplicates rows.
create table if not exists projections (
    game_id          integer not null references games(game_id),
    player_id        integer not null references players(player_id),
    prop_type        text    not null,   -- hits, total_bases, strikeouts, walks, rbis
    projection       numeric not null,   -- model's projected number
    confidence       numeric,            -- optional: calibrated probability (0–1)
    projection_date  date    not null,   -- which slate date this belongs to
    -- Opposing-lineup season K rate (0–1), set ONLY on strikeouts rows (the
    -- only prop the XGBoost model runs). Feature 4 / Option A — see
    -- db/migrations/add_opp_k_rate.sql. Frontend reads it for the
    -- "Facing a X% K lineup" context line. NULL on baseline-only props.
    opp_k_rate       numeric,
    -- SHADOW: deterministic matchup-expected-K (lineup x per-batter K% x
    -- platoon x expected PAs), set ONLY on strikeouts rows when the opposing
    -- lineup is posted. Logged for calibration validation — NOT the displayed
    -- projection. See engine/matchup_k.py + db/migrations/add_matchup_expected_k.sql.
    matchup_expected_k numeric,
    -- Rolling 7-day Statcast batted-ball quality, set ONLY on hitter_home_runs
    -- rows (db/migrations/add_sweet_spot.sql). DISPLAY-ONLY HR-card footer; NOT
    -- a model input. NULL on every other prop and on thin samples (< 5 BBE).
    sweet_spot_pct   numeric,            -- fraction (0..1) of BBE with launch angle 8–32°
    avg_exit_velo    numeric,            -- mean exit velocity (mph) over the 7-day BBE
    -- Opposing starter's HR/9 (last 5 starts), set ONLY on hitter_home_runs rows
    -- (db/migrations/add_opp_sp_hr9.sql). HR-composite 4th term; NOT a model input.
    opp_sp_hr9       numeric,
    updated_at       timestamptz default now(),
    primary key (game_id, player_id, prop_type, projection_date)
);

-- lines: sportsbook betting lines per pitcher + prop + book per day.
-- The most fragile data source (CLAUDE.md step 10/11): fetched defensively,
-- isolated from projections. UPSERT key: (player_id, prop_type, bookmaker, game_date).
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
    -- observed_lines: comma-joined distinct PrizePicks rungs seen for this
    -- (player, prop, day) across the day's cron runs. PrizePicks fantasy-score
    -- props ship a goblin/standard/demon alt-line ladder and ParlayAPI returns
    -- a RANDOM rung per call, so we accumulate the distinct rungs here and store
    -- the MEDIAN (the standard line) in `line`. NULL for every non-fantasy prop.
    observed_lines text,
    unique (player_id, prop_type, bookmaker, game_date)
);

-- line_opens: the OPENING line per (player, prop, book, day), keep-FIRST. The
-- `lines` table upserts and so only holds the latest (closing-ish) line; this
-- table preserves the earliest one so closing-line value (CLV) can be measured.
-- engine/db.record_line_opens inserts with ON CONFLICT DO NOTHING. See
-- db/migrations/add_line_opens.sql.
create table if not exists line_opens (
    id                   serial primary key,
    player_id            integer not null,
    prop_type            text not null,
    bookmaker            text not null,
    game_date            date not null,
    opening_line         numeric not null,
    opening_over_price   integer,
    opening_under_price  integer,
    opening_fetched_at   timestamptz default now(),
    unique (player_id, prop_type, bookmaker, game_date)
);

-- edges: model-vs-market comparison per pitcher + prop + day (step 12).
-- The baseline line is de-vigged (Pinnacle preferred, else a consensus of
-- traditional books) into a fair over probability; `edge` is the model's over
-- probability minus that fair probability. UPSERT key:
-- (player_id, prop_type, game_date, bookmaker).
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
