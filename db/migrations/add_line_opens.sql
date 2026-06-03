-- Closing-line-value (CLV) capture. The `lines` table upserts on
-- (player_id, prop_type, bookmaker, game_date) and so only ever holds the LATEST
-- (closing-ish) line — no history. This table captures the OPENING line per
-- (player, prop, book, day), keep-FIRST: engine/db.record_line_opens inserts
-- with ON CONFLICT DO NOTHING, so only the earliest observation of the day is
-- stored. CLV = how `lines.line` (close) moved vs this opening line, relative to
-- the model's lean. Run once in the Supabase SQL editor.
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

-- NO row-level security: line_opens is an ENGINE-INTERNAL table (the frontend
-- never reads it) and the engine writes with the anon key, the same as the
-- other write tables in this project. Enabling RLS with only a read policy
-- silently BLOCKS the engine's inserts ("new row violates row-level security
-- policy"). If you ever switch the engine to the service_role key, you can
-- enable RLS here safely (service_role bypasses it).
-- If the table was already created WITH rls enabled, run this once to fix it:
alter table line_opens disable row level security;
