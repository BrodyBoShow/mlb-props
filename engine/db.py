"""The ONLY place that writes to Supabase.

Idempotent upserts keyed on each table's primary key, so re-running the
pipeline updates rows in place and never creates duplicates.
"""

import os
from functools import lru_cache
from typing import TYPE_CHECKING

from dotenv import load_dotenv
from supabase import Client, create_client

if TYPE_CHECKING:
    from schemas import (
        EdgeRow,
        HitterGameLogRow,
        LineRow,
        PitcherGameLogRow,
        ProjectionContextRow,
        ProjectionRow,
    )

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
            # ONLY treat this as "column missing" when PostgREST explicitly
            # says so (PGRST204). Plain string matching on _STARTER_COLS was
            # too broad — a foreign-key violation message also mentions the
            # column name and used to trigger this fallback, hiding the real
            # cause (e.g. players upserted after games in future-preview).
            mentions_starter = any(col in msg for col in _STARTER_COLS)
            is_pgrst204 = "PGRST204" in msg or "Could not find" in msg
            if mentions_starter and is_pgrst204:
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


def get_projections_for_date(date_str: str) -> "list[ProjectionContextRow]":
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
                    "games(home_team, away_team, start_time), players(team)"
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
                # start_time is the first-pitch UTC ISO string; consumed by
                # grade.py for the is_day_game flag + weather lookup.
                "start_time": game.get("start_time"),
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
    # Original context columns (add_context_features.sql).
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
    # Data-foundation columns (add_data_foundation.sql). Listed here so the
    # PGRST204 retry strips them when the new migration hasn't been applied;
    # once applied, the names appear in the table and the retry is a no-op.
    "pitcher_days_rest", "pitcher_starts_last_21d",
    "pitcher_pitches_last_3starts", "pitcher_innings_last_21d",
    "team_games_last_3d", "team_games_last_7d", "hitter_games_last_7d",
    "is_day_game", "is_getaway_day",
    "hitter_avg_last7", "hitter_avg_last15", "hitter_k_rate_last7",
    "hitter_ops_last15", "hitter_hr_last15",
    "pitcher_k_rate_last3", "pitcher_era_last3", "pitcher_whip_last3",
    "opp_bullpen_era_14d", "opp_bullpen_k_rate_14d",
    "opp_bullpen_whip_14d", "opp_bullpen_innings_last3d",
    "pitcher_k_vs_lhh_30d", "pitcher_k_vs_rhh_30d",
    "pitcher_whiff_pct_30d", "pitcher_csw_pct_30d",
    "series_game_number", "is_home_team",
    "temperature_f", "wind_speed_mph", "wind_dir",
    "is_dome", "precipitation_pct",
)


def upsert_game_logs(
    rows: "list[PitcherGameLogRow] | list[HitterGameLogRow] | list[dict]",
) -> int:
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
                "db/migrations/add_context_features.sql and "
                "db/migrations/add_data_foundation.sql to enable advanced "
                "matchup + data-foundation features."
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


def get_projection_player_ids_for_date(
    date_str: str, prop_type: str
) -> set[int]:
    """Set of player_ids with a projection for (date, prop_type).

    Used by main.py's stale-detection in the refresh-mode skip path:
    when today's probable starter ids don't overlap with the existing
    strikeouts-projection ids, the projections were written by a prior
    cron run that fetched the WRONG slate (the 9 PM ET / 1 AM UTC
    timezone-disagreement bug). The pipeline then rebuilds rather than
    skip. Returns an empty set on any error so the caller falls back to
    the safer rebuild path.
    """
    try:
        # Paginate so a 200-player hitter prop doesn't get truncated to 1000.
        page_size = 1000
        all_ids: set[int] = set()
        for page in range(20):
            start = page * page_size
            end = start + page_size - 1
            resp = (
                _client()
                .table("projections")
                .select("player_id")
                .eq("projection_date", date_str)
                .eq("prop_type", prop_type)
                .range(start, end)
                .execute()
            )
            batch = resp.data or []
            for r in batch:
                all_ids.add(int(r["player_id"]))
            if len(batch) < page_size:
                break
        return all_ids
    except Exception:
        return set()


def get_players_with_sweet_spot(date_str: str) -> set[int]:
    """player_ids whose hitter_home_runs row on `date_str` already has a non-null
    sweet_spot_pct.

    Gates the independent Statcast fetch in main._build_and_upsert_hitters
    (efficiency guard c): if the hitters being built already have sweet-spot, the
    expensive _fetch_bulk_statcast call is skipped entirely. Returns an empty set
    on any error (or pre-migration, where the column is absent) — the caller then
    treats every hitter as "missing" and will attempt the fetch, the safe default.
    """
    try:
        out: set[int] = set()
        page_size = 1000
        for page in range(20):
            start = page * page_size
            end = start + page_size - 1
            resp = (
                _client()
                .table("projections")
                .select("player_id, sweet_spot_pct")
                .eq("projection_date", date_str)
                .eq("prop_type", "hitter_home_runs")
                .range(start, end)
                .execute()
            )
            batch = resp.data or []
            for r in batch:
                if r.get("sweet_spot_pct") is not None:
                    out.add(int(r["player_id"]))
            if len(batch) < page_size:
                break
        return out
    except Exception as exc:
        print(f"  could not check existing sweet-spot ({exc}) — assuming none")
        return set()


_PITCHER_PROP_TYPES = (
    "strikeouts", "hits_allowed", "walks", "earned_runs",
    "outs_recorded", "pitcher_fantasy_score",
)
_HITTER_PROP_TYPES = (
    "hitter_hits", "hitter_total_bases", "hitter_rbis", "hitter_runs",
    "hitter_home_runs", "hitter_fantasy_score",
)


def delete_projections_for_date_props(
    date_str: str, prop_types: tuple[str, ...] | list[str],
) -> int:
    """Delete projection rows matching (projection_date, prop_type IN ...).

    The projections PK is (game_id, player_id, prop_type, projection_date).
    A stale-rebuild that targets the same date+player+prop but a DIFFERENT
    game_id (because the prior cron stored the wrong slate's game_ids)
    doesn't conflict on the composite key — the UPSERT inserts new rows
    alongside the stale ones rather than replacing them. The rebuild path
    in main.py calls this immediately before re-upserting so the fresh
    rows fully replace the stale set instead of co-existing with it.
    """
    if not prop_types:
        return 0
    try:
        resp = (
            _client()
            .table("projections")
            .delete()
            .eq("projection_date", date_str)
            .in_("prop_type", list(prop_types))
            .execute()
        )
        n = len(resp.data or [])
        if n:
            print(
                f"  deleted {n} stale projection rows for {date_str} "
                f"(prop_types={list(prop_types)})"
            )
        return n
    except Exception as exc:
        print(f"  could not delete stale projections for {date_str}: {exc}")
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


# Projection columns that may not exist on a pre-migration schema. Stripped
# and retried on PGRST204 so the pipeline runs cleanly before the migration
# is applied (mirrors the upsert_game_logs / upsert_games pattern).
#   - opp_k_rate          : add_opp_k_rate.sql (strikeouts rows)
#   - sweet_spot_pct      : add_sweet_spot.sql (hitter_home_runs rows, display)
#   - avg_exit_velo       : add_sweet_spot.sql (hitter_home_runs rows, display)
#   - opp_sp_hr9          : add_opp_sp_hr9.sql (hitter_home_runs rows, composite term)
_PROJECTION_OPTIONAL_COLS = ("opp_k_rate", "sweet_spot_pct", "avg_exit_velo", "opp_sp_hr9")


def upsert_projections(rows: "list[ProjectionRow] | list[dict]") -> int:
    """Upsert projection rows on the composite primary key.

    (game_id, player_id, prop_type, projection_date) — re-runs update in place.

    Defensive: the optional columns (opp_k_rate, sweet_spot_pct, avg_exit_velo,
    opp_sp_hr9) only exist after their migrations are applied. On PGRST204 we
    strip ONLY the specific column PostgREST names and retry — GRANULAR, not
    all-or-nothing — so a missing column (e.g. opp_sp_hr9 pre-migration) never
    drops a sibling that DOES exist (e.g. sweet_spot_pct on the same row). Loops
    until the upsert succeeds or a non-optional error surfaces.
    """
    if not rows:
        return 0
    client = _client()
    payload: list[dict] = [dict(r) for r in rows]
    dropped: list[str] = []
    for _attempt in range(len(_PROJECTION_OPTIONAL_COLS) + 1):
        try:
            client.table("projections").upsert(
                payload, on_conflict="game_id,player_id,prop_type,projection_date"
            ).execute()
            if dropped:
                print(
                    f"  WARNING: projections missing column(s) {dropped} -- upserted "
                    f"without them. Run the matching db/migrations/*.sql."
                )
            return len(rows)
        except Exception as exc:
            msg = str(exc)
            is_pgrst204 = "PGRST204" in msg or "Could not find" in msg
            missing = next(
                (c for c in _PROJECTION_OPTIONAL_COLS if c in msg and c not in dropped),
                None,
            )
            if is_pgrst204 and missing:
                dropped.append(missing)
                payload = [{k: v for k, v in r.items() if k != missing} for r in payload]
                continue
            raise
    raise RuntimeError("upsert_projections: exhausted optional-column strips")


def update_matchup_expected_k(updates: list[dict]) -> int:
    """SHADOW: set projections.matchup_expected_k on existing strikeouts rows.

    Each update: {game_id, player_id, projection_date, matchup_expected_k}.
    A targeted UPDATE (not an upsert) so it ONLY touches the shadow column and
    never disturbs the live projection/opp_k_rate. Returns the count written.

    Defensive: the column only exists after db/migrations/add_matchup_expected_k
    .sql is applied; if it's missing PostgREST returns PGRST204 — we warn once
    and skip (the pipeline keeps running pre-migration). Per-row round-trips,
    but a slate is only ~15-18 starters.
    """
    if not updates:
        return 0
    client = _client()
    written = 0
    for u in updates:
        try:
            (
                client.table("projections")
                .update({"matchup_expected_k": u["matchup_expected_k"]})
                .eq("game_id", u["game_id"])
                .eq("player_id", u["player_id"])
                .eq("prop_type", "strikeouts")
                .eq("projection_date", u["projection_date"])
                .execute()
            )
            written += 1
        except Exception as exc:
            msg = str(exc)
            if "matchup_expected_k" in msg and ("PGRST204" in msg or "Could not find" in msg):
                print(
                    "  WARNING: projections missing matchup_expected_k column -- "
                    "skipping shadow write. Run "
                    "db/migrations/add_matchup_expected_k.sql to enable it."
                )
                return 0
            raise
    return written


_GAME_WEATHER_COLS = ("wind_speed_mph", "wind_dir_deg", "is_dome")


def update_game_weather(rows: list[dict]) -> int:
    """Set today's wind on existing games rows (display-only HR wind tag).

    Each row: {game_id, wind_speed_mph, wind_dir_deg, is_dome}. A targeted
    UPDATE (not an upsert) so it only touches the weather columns and never
    disturbs the rest of the games row (home/away/start_time/starters).
    Returns the count written.

    Defensive: the columns only exist after db/migrations/add_game_weather.sql
    is applied; if missing PostgREST returns PGRST204 — we warn once and skip
    (the pipeline keeps running pre-migration). Per-row round-trips, but a
    slate is only ~15 games.
    """
    if not rows:
        return 0
    client = _client()
    written = 0
    for r in rows:
        payload = {k: r.get(k) for k in _GAME_WEATHER_COLS}
        try:
            (
                client.table("games")
                .update(payload)
                .eq("game_id", r["game_id"])
                .execute()
            )
            written += 1
        except Exception as exc:
            msg = str(exc)
            mentions = any(c in msg for c in _GAME_WEATHER_COLS)
            if mentions and ("PGRST204" in msg or "Could not find" in msg):
                print(
                    "  WARNING: games table missing weather columns -- skipping "
                    "wind write. Run db/migrations/add_game_weather.sql to "
                    "enable the HR-card wind tag."
                )
                return 0
            raise
    return written


def get_latest_pitcher_csw(player_ids: list[int]) -> dict[int, float]:
    """Most-recent non-null pitcher_csw_pct_30d per pitcher from player_game_logs.

    Used by the matchup-K shadow step as the pitcher's recent CSW% stuff input
    without an extra Statcast fetch (grade.py already logs it per start). Returns
    {} on any error or if the column isn't present yet.
    """
    if not player_ids:
        return {}
    try:
        resp = (
            _client()
            .table("player_game_logs")
            .select("player_id, pitcher_csw_pct_30d, game_date")
            .in_("player_id", list(player_ids))
            .not_.is_("pitcher_csw_pct_30d", "null")
            .order("game_date", desc=True)
            .execute()
        )
    except Exception as exc:
        print(f"  could not fetch pitcher_csw_pct_30d: {exc}")
        return {}
    out: dict[int, float] = {}
    for r in resp.data or []:
        pid = int(r["player_id"])
        if pid not in out and r.get("pitcher_csw_pct_30d") is not None:
            out[pid] = float(r["pitcher_csw_pct_30d"])  # rows are newest-first
    return out


# PrizePicks-only fantasy props whose lines arrive as a goblin/standard/demon
# alt-line ladder. ParlayAPI returns a RANDOM rung per call, so a single fetch
# can't tell which value is the real (standard) line. We accumulate the distinct
# rungs seen across the day's cron runs and store the MEDIAN — the standard line,
# which is model-independent (no projection coupling). Kept in sync with
# lines.PRIZEPICKS_ONLY_PROPS; defined locally so db.py needs no lines import.
_FANTASY_LADDER_PROPS = {"pitcher_fantasy_score", "hitter_fantasy_score"}


def _resolve_fantasy_ladder(rows: list[dict]) -> bool:
    """Collapse PrizePicks fantasy alt-line rungs to the standard (median) line.

    For each fantasy row (prizepicks book only), merge its just-observed line
    into the day's accumulated distinct rungs (read from observed_lines on the
    existing row, seeded with the existing `line` for pre-column legacy rows),
    then set `line` = median rung rounded to the 0.5 grid and write the updated
    rung set back into observed_lines. Mutates `rows` in place.

    Median is model-INDEPENDENT and converges to the true standard as the day's
    runs enumerate all three rungs (goblin < standard < demon). Mid-day, with a
    partial ladder, it's an estimate — still far better than a random rung.

    Returns True if observed_lines was populated (so the caller knows to expect
    the column). Returns False and leaves rows untouched if the column doesn't
    exist yet (pre-migration) or the read fails — graceful degrade to the old
    single-sample behavior.
    """
    import statistics

    # Rows that ALREADY carry observed_lines are authoritative (the producer set
    # the standard line directly — PrizePicks-direct). They bypass the median
    # merge entirely: their single observed_lines value resets the day's
    # accumulation to the true standard. Only rows WITHOUT observed_lines (the
    # ParlayAPI ladder fallback) get accumulated/median-resolved here.
    fantasy = [
        r for r in rows
        if r.get("prop_type") in _FANTASY_LADDER_PROPS
        and r.get("bookmaker") == "prizepicks"
        and r.get("line") is not None
        and not r.get("observed_lines")
    ]
    if not fantasy:
        return False

    # Read existing rows for the affected dates in one query per date.
    client = _client()
    existing: dict[tuple, dict] = {}
    for game_date in {r["game_date"] for r in fantasy}:
        try:
            resp = (
                client.table("lines")
                .select("player_id, prop_type, line, observed_lines")
                .eq("game_date", game_date)
                .eq("bookmaker", "prizepicks")
                .in_("prop_type", list(_FANTASY_LADDER_PROPS))
                .range(0, 4999)
                .execute()
            )
        except Exception as exc:
            # Most likely the observed_lines column doesn't exist yet — degrade
            # to single-sample behavior so the pipeline keeps working before the
            # add_observed_lines.sql migration is applied.
            print(
                f"  fantasy-ladder read skipped ({exc}) — apply "
                f"db/migrations/add_observed_lines.sql to enable standard-line "
                f"recovery"
            )
            return False
        for row in resp.data or []:
            existing[(row["player_id"], row["prop_type"], game_date)] = row

    for r in fantasy:
        key = (r["player_id"], r["prop_type"], r["game_date"])
        rungs: set[float] = set()
        prev = existing.get(key)
        if prev:
            obs = prev.get("observed_lines")
            if obs:
                for tok in str(obs).split(","):
                    tok = tok.strip()
                    if tok:
                        try:
                            rungs.add(float(tok))
                        except ValueError:
                            pass
            elif prev.get("line") is not None:
                # Legacy row written before this column existed — seed the set
                # with whatever (possibly-alt) rung it currently holds so we
                # self-heal from the polluted state instead of discarding it.
                try:
                    rungs.add(float(prev["line"]))
                except (TypeError, ValueError):
                    pass
        rungs.add(float(r["line"]))

        ordered = sorted(rungs)
        standard = round(statistics.median(ordered) * 2) / 2
        r["line"] = standard
        r["observed_lines"] = ",".join(str(x) for x in ordered)

    return True


def upsert_lines(rows: "list[LineRow] | list[dict]") -> int:
    """Upsert betting line rows on (player_id, prop_type, bookmaker, game_date).

    Idempotent — re-running the job refreshes each book's line in place.

    PrizePicks fantasy-score props get special handling: their alt-line ladder
    is collapsed to the median (standard) rung via _resolve_fantasy_ladder,
    accumulating distinct rungs across the day in observed_lines. If that column
    isn't present yet (pre-migration), the upsert strips observed_lines and
    retries, so the pipeline keeps working either way.
    """
    if not rows:
        return 0

    _resolve_fantasy_ladder(list(rows))

    client = _client()
    try:
        client.table("lines").upsert(
            rows, on_conflict="player_id,prop_type,bookmaker,game_date"
        ).execute()
    except Exception as exc:
        msg = str(exc)
        if "observed_lines" in msg and ("PGRST204" in msg or "Could not find" in msg):
            print(
                "  WARNING: lines table missing observed_lines column -- "
                "upserted without it. Run db/migrations/add_observed_lines.sql"
            )
            stripped = [
                {k: v for k, v in r.items() if k != "observed_lines"}
                for r in rows
            ]
            client.table("lines").upsert(
                stripped, on_conflict="player_id,prop_type,bookmaker,game_date"
            ).execute()
        else:
            raise
    return len(rows)


def record_line_opens(rows: "list[LineRow] | list[dict]") -> int:
    """Capture the OPENING line per (player_id, prop_type, bookmaker, game_date)
    into the line_opens table — keep-FIRST, so only the earliest observation of
    the day is stored. Closing-line value (CLV) is then measured as how the live
    `lines.line` (closing-ish) moved relative to this opening line vs the model's
    lean.

    Uses upsert with ignore_duplicates=True (INSERT ... ON CONFLICT DO NOTHING),
    so every later cron's line is ignored and the opening value is preserved.
    FULLY DEFENSIVE: if the table doesn't exist yet (pre-migration) the call is
    caught and skipped — it NEVER affects the lines pipeline. Returns the number
    of opening-line candidates sent (existing keys are no-ops DB-side).
    """
    if not rows:
        return 0
    opens = [
        {
            "player_id":           r["player_id"],
            "prop_type":           r["prop_type"],
            "bookmaker":           r["bookmaker"],
            "game_date":           r["game_date"],
            "opening_line":        r["line"],
            "opening_over_price":  r.get("over_price"),
            "opening_under_price": r.get("under_price"),
        }
        for r in rows
        if r.get("line") is not None
    ]
    if not opens:
        return 0
    try:
        _client().table("line_opens").upsert(
            opens,
            on_conflict="player_id,prop_type,bookmaker,game_date",
            ignore_duplicates=True,
        ).execute()
        return len(opens)
    except Exception as exc:
        print(
            f"  line-opens capture skipped ({exc}) -- apply "
            f"db/migrations/add_line_opens.sql to enable CLV tracking"
        )
        return 0


def get_lines_for_date(date_str: str) -> list[dict]:
    """Return all betting line rows for a given game_date. [] on error/missing.

    Paginated via .range() to walk past Supabase's 1000-row server cap. A
    full slate produces 200+ players x 12 prop types x 9 bookmakers = ~3k
    rows; without pagination the first 1000 (which sort as all-hitter due
    to insertion order) come back and every pitcher prop silently produces
    zero edges. This is the same trap get_projections_for_date paginates
    around.
    """
    page_size = 1000
    raw_rows: list[dict] = []
    try:
        client = _client()
        for page in range(20):
            start = page * page_size
            end = start + page_size - 1
            resp = (
                client.table("lines")
                .select("*")
                .eq("game_date", date_str)
                .range(start, end)
                .execute()
            )
            batch = resp.data or []
            raw_rows.extend(batch)
            if len(batch) < page_size:
                break
        return raw_rows
    except Exception as exc:
        print(f"  could not fetch lines for {date_str}: {exc}")
        return []


def upsert_edges(rows: "list[EdgeRow] | list[dict]") -> int:
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
