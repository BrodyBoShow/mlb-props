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


_STARTER_COLS = ("home_starter_id", "away_starter_id")


def upsert_games(rows: list[dict]) -> int:
    """Upsert game rows on game_id. Returns the number of rows sent.

    Rows are grouped by their key signature before upserting so a payload
    where some games carry home_starter_id / away_starter_id and others
    don't never accidentally NULLs the missing column via PostgREST's
    union-of-keys behavior — a transient lookup_player miss on one game
    must not clobber a previously-known starter on another.

    Defensive: if the games table is on a pre-migration schema (the
    home_starter_id / away_starter_id columns haven't been added yet)
    PostgREST returns PGRST204 with the offending column name. We strip
    the starter columns and retry once so the pipeline keeps working
    until the user applies db/migrations/add_starter_ids.sql.
    """
    if not rows:
        return 0
    groups: dict[frozenset, list[dict]] = {}
    for r in rows:
        groups.setdefault(frozenset(r.keys()), []).append(r)
    client = _client()
    for batch in groups.values():
        try:
            client.table("games").upsert(batch, on_conflict="game_id").execute()
        except Exception as exc:
            msg = str(exc)
            if any(col in msg for col in _STARTER_COLS):
                stripped = [
                    {k: v for k, v in r.items() if k not in _STARTER_COLS}
                    for r in batch
                ]
                if stripped[0]:
                    client.table("games").upsert(
                        stripped, on_conflict="game_id"
                    ).execute()
                print(
                    "  WARNING: games table missing starter_id columns -- "
                    "upserted without them. Run "
                    "db/migrations/add_starter_ids.sql to enable future-slate "
                    "starter rendering."
                )
            else:
                raise
    return len(rows)


def get_projections_for_date(date_str: str) -> list[dict]:
    """Return projection rows for a given date (for grading), all prop types.

    Joins games (home_team, away_team) and players (team) so the grader can
    work out which team batted against each pitcher. home_away is derived from
    the pitcher's team vs the game's home team; it may be None when the
    player's team is unknown (lookup_player sometimes omits it).

    Each row: game_id, player_id, projection, prop_type, home_team,
    away_team, home_away ('home' | 'away' | None).
    """
    # Paginate to walk past Supabase's 1000-row server cap. A full slate
    # produces 200+ players x 10-12 prop types ≈ 2-3k projection rows;
    # without pagination refresh-mode edge coverage silently drops by half.
    page_size = 1000
    raw_rows: list[dict] = []
    try:
        client = _client()
        for page in range(20):
            start = page * page_size
            end = start + page_size - 1
            resp = (
                client
                .table("projections")
                .select(
                    "game_id, player_id, projection, prop_type, "
                    "games(home_team, away_team), players(team)"
                )
                .eq("projection_date", date_str)
                .range(start, end)
                .execute()
            )
            batch = resp.data or []
            raw_rows.extend(batch)
            if len(batch) < page_size:
                break
    except Exception as exc:
        print(f"  could not fetch projections for {date_str}: {exc}")
        return []

    rows: list[dict] = []
    for r in raw_rows:
        game = r.get("games") or {}
        player = r.get("players") or {}
        home_team = game.get("home_team")
        away_team = game.get("away_team")
        team = player.get("team")

        if team and team == home_team:
            home_away = "home"
        elif team and team == away_team:
            home_away = "away"
        else:
            home_away = None

        rows.append(
            {
                "game_id": r["game_id"],
                "player_id": r["player_id"],
                "projection": r["projection"],
                "prop_type": r.get("prop_type"),
                "home_team": home_team,
                "away_team": away_team,
                "home_away": home_away,
            }
        )
    return rows


def get_last_game_date(player_id: int, before_date: str) -> str | None:
    """Most recent player_game_logs game_date for this pitcher strictly before
    `before_date` ('YYYY-MM-DD'). Returns None if there's no prior entry."""
    try:
        resp = (
            _client()
            .table("player_game_logs")
            .select("game_date")
            .eq("player_id", player_id)
            .lt("game_date", before_date)
            .order("game_date", desc=True)
            .limit(1)
            .execute()
        )
        data = resp.data or []
        return data[0]["game_date"] if data else None
    except Exception as exc:
        print(f"  could not fetch last game date for player {player_id}: {exc}")
        return None


_CONTEXT_COLS = (
    "lineup_lhh_pct", "lineup_rhh_pct",
    "pitcher_k_vs_lhh", "pitcher_k_vs_rhh",
    "pitcher_fastball_pct", "pitcher_breaking_pct", "pitcher_offspeed_pct",
    "pitcher_avg_velo", "pitcher_velo_trend",
    "park_factor_hits", "park_factor_k",
    "pitcher_pitches_last_start",
    "opp_sp_k_rate_last5", "opp_sp_era_last5", "opp_sp_whip_last5",
    "opp_sp_hand", "opp_sp_projected_ip",
    "opp_bullpen_era_7day", "opp_bullpen_k_rate_7day",
    "hitter_avg_vs_hand", "park_factor_hits_h",
    "temperature", "wind_speed",
)


def upsert_game_logs(rows: list[dict]) -> int:
    """Upsert graded game log rows on (player_id, game_id). Re-runs are safe.

    Defensive: if the player_game_logs table is on a pre-migration schema
    (the new context-feature columns haven't been added yet) PostgREST
    returns PGRST204 with the offending column name. We strip every
    context column and retry once so the grading run still persists the
    actuals; the user can apply db/migrations/add_context_features.sql
    whenever convenient and subsequent runs will land the context data.
    """
    if not rows:
        return 0
    client = _client()
    try:
        client.table("player_game_logs").upsert(
            rows, on_conflict="player_id,game_id"
        ).execute()
        return len(rows)
    except Exception as exc:
        msg = str(exc)
        if any(col in msg for col in _CONTEXT_COLS):
            stripped = [
                {k: v for k, v in r.items() if k not in _CONTEXT_COLS}
                for r in rows
            ]
            client.table("player_game_logs").upsert(
                stripped, on_conflict="player_id,game_id"
            ).execute()
            print(
                "  WARNING: player_game_logs missing context-feature columns "
                "-- upserted without them. Run "
                "db/migrations/add_context_features.sql to enable advanced "
                "matchup features."
            )
            return len(rows)
        raise


def get_projection_count_for_date(
    date_str: str, prop_type: str | None = None
) -> int:
    """Count projection rows for `date_str` (optionally a single prop_type).

    Used by main.py to detect whether today's projections already exist so
    later runs in the same day can skip the expensive baseline + XGBoost
    work and just refresh lines + edges. prop_type=None counts every prop.
    """
    try:
        query = (
            _client()
            .table("projections")
            .select("player_id", count="exact")
            .eq("projection_date", date_str)
        )
        if prop_type is not None:
            query = query.eq("prop_type", prop_type)
        resp = query.limit(1).execute()
        return resp.count or 0
    except Exception:
        return 0


def get_game_log_count_for_date(date_str: str) -> int:
    """Count player_game_logs rows for `date_str`.

    Used by main.py to skip re-grading a slate that's already been graded
    by an earlier run today (each cron tick after the first grading run
    finds the rows here and bails out instead of repeating the work).
    """
    try:
        resp = (
            _client()
            .table("player_game_logs")
            .select("player_id", count="exact")
            .eq("game_date", date_str)
            .limit(1)
            .execute()
        )
        return resp.count or 0
    except Exception:
        return 0


def get_player_bats(player_ids: list[int]) -> dict[int, str]:
    """Map of player_id -> bats handedness from the players table.

    Used by grade.py to resolve LHH/RHH for the opposing lineup — the MLB
    boxscore_data response strips batSide out, so we read it from our own
    cache. The players table is populated by fetch_lineups() (batters) and
    fetch_probable_pitchers() (pitchers), so any batter who's been in a
    confirmed lineup this season is here.

    Returns {} on any failure so the caller can fall back to a league-
    average lineup split without crashing.
    """
    if not player_ids:
        return {}
    try:
        resp = (
            _client()
            .table("players")
            .select("player_id, bats")
            .in_("player_id", list(player_ids))
            .execute()
        )
        return {
            r["player_id"]: r.get("bats") or "R"
            for r in resp.data or []
        }
    except Exception as exc:
        print(f"  could not fetch player bats: {exc}")
        return {}


def get_game_logs(since_date: str | None = None) -> list[dict] | None:
    """Read rows from player_game_logs. Returns None if the table is missing.

    since_date: optional 'YYYY-MM-DD' floor — only rows on/after this date.
    Calibration only needs a rolling window, not the full season's history,
    so callers should pass a recent floor to keep the round-trip small.
    """
    try:
        query = _client().table("player_game_logs").select("*")
        if since_date:
            query = query.gte("game_date", since_date)
        resp = query.execute()
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


def upsert_lines(rows: list[dict]) -> int:
    """Upsert betting line rows on (player_id, prop_type, bookmaker, game_date).

    Idempotent — re-running the job refreshes each book's line in place.
    """
    if not rows:
        return 0
    _client().table("lines").upsert(
        rows, on_conflict="player_id,prop_type,bookmaker,game_date"
    ).execute()
    return len(rows)


def get_lines_for_date(date_str: str) -> list[dict]:
    """Return all betting line rows for a given game_date. [] on error/missing."""
    try:
        resp = (
            _client()
            .table("lines")
            .select("*")
            .eq("game_date", date_str)
            .execute()
        )
        return resp.data or []
    except Exception as exc:
        print(f"  could not fetch lines for {date_str}: {exc}")
        return []


def upsert_edges(rows: list[dict]) -> int:
    """Upsert edge rows on (player_id, prop_type, game_date, bookmaker).

    Idempotent — re-running the job refreshes each edge in place.
    """
    if not rows:
        return 0
    _client().table("edges").upsert(
        rows, on_conflict="player_id,prop_type,game_date,bookmaker"
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
