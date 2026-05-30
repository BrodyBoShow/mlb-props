"""The ONLY place that writes to Supabase.

Idempotent upserts keyed on each table's primary key, so re-running the
pipeline updates rows in place and never creates duplicates.
"""

import os
from functools import lru_cache

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


@lru_cache(maxsize=1)
def _client() -> Client:
    url = os.environ["SUPABASE_URL"]

    # Prefer a service_role key (can bypass RLS for the writer job); fall back
    # to the anon key, which only works if RLS is off on the tables.
key = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")
if not key:
    raise RuntimeError("Set SUPABASE_KEY (service_role) in .env")


def upsert_players(rows: list[dict]) -> int:
    """Upsert player rows on player_id. Returns the number of rows sent."""
    if not rows:
        return 0
    _client().table("players").upsert(rows, on_conflict="player_id").execute()
    return len(rows)


def upsert_games(rows: list[dict]) -> int:
    """Upsert game rows on game_id. Returns the number of rows sent."""
    if not rows:
        return 0
    _client().table("games").upsert(rows, on_conflict="game_id").execute()
    return len(rows)
