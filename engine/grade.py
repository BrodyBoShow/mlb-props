"""Grade yesterday's pitcher projections against actual MLB box scores.

Fetches final game results from the MLB Stats API, matches each projected
pitcher to their actual strikeout total, and returns rows ready to upsert
into player_game_logs. No DB writes here — returns list[dict] only.
"""

from datetime import date, timedelta

import statsapi

import db

LEAGUE_AVG_K_PCT = 0.22   # default until enriched in step 10


def _boxscore(game_id: int) -> dict:
    """Fetch boxscore_data for one game. Returns {} on any error."""
    try:
        return statsapi.boxscore_data(game_id)
    except Exception as exc:
        print(f"  boxscore fetch failed for game {game_id}: {exc}")
        return {}


def _pitcher_result(box: dict, player_id: int) -> tuple[int | None, str | None]:
    """Return (actual_strikeouts, home_away) for a pitcher from a boxscore dict.

    Returns (None, None) if the pitcher didn't appear in this game
    (scratched, postponed, or a data gap).
    """
    for side in ("home", "away"):
        players = box.get(side, {}).get("players", {})
        entry = players.get(f"ID{player_id}", {})
        ks = entry.get("stats", {}).get("pitching", {}).get("strikeOuts")
        if ks is not None:
            return int(ks), side
    return None, None


def grade_yesterday(grade_date: date | None = None) -> list[dict]:
    """Grade the previous day's slate against actual results.

    Returns rows shaped for player_game_logs. No DB writes here.
    Skips games not yet Final and pitchers not found in the box score.
    """
    yesterday = grade_date or (date.today() - timedelta(days=1))
    yesterday_str = yesterday.strftime("%Y-%m-%d")
    print(f"  grading projections for {yesterday_str}...")

    projections = db.get_projections_for_date(yesterday_str)
    if not projections:
        print(f"  no projections found for {yesterday_str} — nothing to grade")
        return []

    # Only grade games the API confirms are Final
    schedule = statsapi.schedule(date=yesterday_str)
    final_ids = {g["game_id"] for g in schedule if "Final" in (g.get("status") or "")}
    if not final_ids:
        print(f"  no Final games for {yesterday_str} — skipping")
        return []

    # Fetch each game's box score once, keyed by game_id
    box_cache: dict[int, dict] = {}

    rows: list[dict] = []
    for proj in projections:
        game_id = proj["game_id"]
        player_id = proj["player_id"]

        if game_id not in final_ids:
            continue   # game still in progress or postponed

        if game_id not in box_cache:
            box_cache[game_id] = _boxscore(game_id)

        actual_ks, home_away = _pitcher_result(box_cache[game_id], player_id)

        if actual_ks is None:
            # Pitcher was scratched or data is missing — don't log a 0
            print(f"  player {player_id} not found in box score for game {game_id} — skipped")
            continue

        rows.append({
            "player_id": player_id,
            "game_id": game_id,
            "game_date": yesterday_str,
            "actual_strikeouts": actual_ks,
            "home_away": home_away,
            "opp_k_rate": LEAGUE_AVG_K_PCT,   # enriched in step 10
            "days_rest": 5,                    # default; computed from logs later
            "projection": float(proj["projection"]),
        })
        print(f"  player {player_id}: projected {proj['projection']} K → actual {actual_ks} K")

    print(f"  graded {len(rows)} / {len(projections)} projected pitchers")
    return rows
