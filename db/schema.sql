-- players: one row per MLB player, refreshed each run
create table if not exists players (
    player_id  integer primary key,   -- official MLBAM id
    full_name  text not null,
    team       text,
    position   text,
    bats       text,                  -- L, R, or S (switch)
    throws     text                   -- L or R
);

-- games: one row per scheduled game
create table if not exists games (
    game_id    integer primary key,   -- official MLB game id
    game_date  date not null,
    home_team  text not null,
    away_team  text not null,
    status     text,                  -- scheduled, live, final
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
    actual_strikeouts integer,
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
