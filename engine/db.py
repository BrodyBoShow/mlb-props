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
    return create_client(url, key)


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


def get_projections_for_date(date_str: str) -> list[dict]:
    """Return strikeout projection rows for a given date (for grading)."""
    try:
        resp = (
            _client()
            .table("projections")
            .select("game_id, player_id, projection")
            .eq("prop_type", "strikeouts")
            .eq("projection_date", date_str)
            .execute()
        )
        return resp.data or []
    except Exception as exc:
        print(f"  could not fetch projections for {date_str}: {exc}")
        return []


def upsert_game_logs(rows: list[dict]) -> int:
    """Upsert graded game log rows on (player_id, game_id). Re-runs are safe."""
    if not rows:
        return 0
    _client().table("player_game_logs").upsert(
        rows, on_conflict="player_id,game_id"
    ).execute()
    return len(rows)


def get_game_logs() -> list[dict] | None:
    """Read all rows from player_game_logs. Returns None if the table is missing."""
    try:
        resp = _client().table("player_game_logs").select("*").execute()
        return resp.data or []
    except Exception as exc:
        print(f"  player_game_logs not accessible ({exc}) — skipping training")
        return None


def upsert_projections(rows: list[dict]) -> int:
    """Upsert projection rows on the composite primary key.

    (game_id, player_id, prop_type, projection_date) — re-runs update in place.
    """
    if not rows:
        return 0
    _client().table("projections").upsert(
        rows, on_conflict="game_id,player_id,prop_type,projection_date"
    ).execute()
    return len(rows)


def update_confidences(rows: list[dict]) -> int:
    """Update the confidence column for existing projection rows.

    Each row must contain: game_id, player_id, prop_type, projection_date,
    confidence. PostgREST only sets the columns present in the payload, so
    the projection value and updated_at are left untouched.

    Re-runs are safe — the upsert resolves on the composite PK and only
    writes the confidence value.
    """
    if not rows:
        return 0
    _client().table("projections").upsert(
        rows, on_conflict="game_id,player_id,prop_type,projection_date"
    ).execute()
    return len(rows)
