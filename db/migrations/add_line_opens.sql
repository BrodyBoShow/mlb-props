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

alter table line_opens enable row level security;
create policy "public read line_opens" on line_opens for select to anon using (true);
