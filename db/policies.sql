-- Public read-only access for the frontend (anon key).
--
-- The frontend ONLY ever SELECTs. Every write goes through the service_role
-- key used by the scheduled job, which bypasses RLS entirely — so these
-- policies never widen what the writer can do.
--
-- projections is the table the page displays. players + games are needed too
-- because the page joins them in to show each pitcher's name and the game
-- matchup; without a SELECT policy on those, the embedded join returns null.
--
-- Idempotent: safe to re-run (drops the policy first).

alter table projections enable row level security;
alter table players     enable row level security;
alter table games       enable row level security;

drop policy if exists "public read projections" on projections;
create policy "public read projections"
  on projections for select to anon using (true);

drop policy if exists "public read players" on players;
create policy "public read players"
  on players for select to anon using (true);

drop policy if exists "public read games" on games;
create policy "public read games"
  on games for select to anon using (true);
