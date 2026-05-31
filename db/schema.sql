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
    game_id    integer primary key,   -- official MLB game id
    game_date  date not null,
    home_team  text not null,
    away_team  text not null,
    status     text,                  -- scheduled, live, final
    start_time timestamptz,           -- first pitch in UTC; used to sort cards chronologically
    created_at timestamptz default now()
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
    -- pitcher actuals
    actual_strikeouts    integer,
    actual_hits_allowed  integer,
    actual_walks         integer,
    actual_earned_runs   integer,
    actual_outs_recorded integer,
    -- hitter actuals
    actual_hits        integer,
    actual_total_bases integer,
    actual_rbis        integer,
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
    projection        numeric,     -- what the model projected that day
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
