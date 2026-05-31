"""Grade yesterday's pitcher projections against actual MLB box scores.

Fetches final game results from the MLB Stats API, matches each projected
pitcher to their actual stats, and returns rows ready to upsert into
player_game_logs. No DB writes here — returns list[dict] only.
"""

from datetime import date, timedelta

import statsapi

import db
from constants import LEAGUE_AVG_K_PCT


def _parse_innings(ip_str: str) -> int:
    """Convert an inningsPitched string to total outs recorded.

    Baseball notation: "6.2" means 6 full innings + 2 outs = 20 outs.
    The fractional part is *outs*, not tenths of an inning.
    """
    try:
        whole, partial = str(ip_str).split(".")
        return int(whole) * 3 + int(partial)
    except Exception:
        return 0


def _boxscore(game_id: int) -> dict:
    """Fetch boxscore_data for one game. Returns {} on any error."""
    try:
        return statsapi.boxscore_data(game_id)
    except Exception as exc:
        print(f"  boxscore fetch failed for game {game_id}: {exc}")
        return {}


def _pitcher_result(box: dict, player_id: int) -> dict | None:
    """Return a dict of actual pitching stats for one pitcher from a boxscore.

    Returns None if the pitcher didn't appear in this game (scratched,
    postponed, or a data gap).

    Keys returned:
        home_away            str   'home' | 'away'
        actual_strikeouts    int
        actual_hits_allowed  int
        actual_walks         int
        actual_earned_runs   int
        actual_outs_recorded int   (inningsPitched converted to total outs)
    """
    for side in ("home", "away"):
        players = box.get(side, {}).get("players", {})
        entry = players.get(f"ID{player_id}", {})
        pitching = entry.get("stats", {}).get("pitching", {})

        # strikeOuts is always present if this pitcher appeared; use it as the
        # presence check (same guard as before).
        ks = pitching.get("strikeOuts")
        if ks is None:
            continue

        return {
            "home_away":            side,
            "actual_strikeouts":    int(ks),
            "actual_hits_allowed":  int(pitching.get("hits", 0)),
            "actual_walks":         int(pitching.get("baseOnBalls", 0)),
            "actual_earned_runs":   int(pitching.get("earnedRuns", 0)),
            "actual_outs_recorded": _parse_innings(pitching.get("inningsPitched", "0.0")),
        }

    return None


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
        print(f"  no projections found for {yesterday_str} -- nothing to grade")
        return []

    # Only grade games the API confirms are Final
    schedule = statsapi.schedule(date=yesterday_str)
    final_ids = {g["game_id"] for g in schedule if "Final" in (g.get("status") or "")}
    if not final_ids:
        print(f"  no Final games for {yesterday_str} -- skipping")
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

        result = _pitcher_result(box_cache[game_id], player_id)

        if result is None:
            # Pitcher was scratched or data is missing -- don't log a 0
            print(f"  player {player_id} not found in box score for game {game_id} -- skipped")
            continue

        rows.append({
            "player_id":             player_id,
            "game_id":               game_id,
            "game_date":             yesterday_str,
            "actual_strikeouts":     result["actual_strikeouts"],
            "actual_hits_allowed":   result["actual_hits_allowed"],
            "actual_walks":          result["actual_walks"],
            "actual_earned_runs":    result["actual_earned_runs"],
            "actual_outs_recorded":  result["actual_outs_recorded"],
            "home_away":             result["home_away"],
            "opp_k_rate":            LEAGUE_AVG_K_PCT,   # enriched later
            "days_rest":             5,                   # default; computed from logs later
            "projection":            float(proj["projection"]),
        })
        print(
            f"  player {player_id}: projected {proj['projection']} K"
            f" -> actual {result['actual_strikeouts']} K"
            f" / {result['actual_hits_allowed']} H"
            f" / {result['actual_walks']} BB"
            f" / {result['actual_earned_runs']} ER"
            f" / {result['actual_outs_recorded']} outs"
        )

    print(f"  graded {len(rows)} / {len(projections)} projected pitchers")
    return rows
