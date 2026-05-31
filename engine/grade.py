"""Grade yesterday's pitcher projections against actual MLB box scores.

Fetches final game results from the MLB Stats API, matches each projected
pitcher to their actual stats, and returns rows ready to upsert into
player_game_logs. No DB writes here — returns list[dict] only.
"""

from datetime import date, timedelta

import statsapi

import db
import model


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

    # Collapse to one entry per (player_id, game_id). The query now returns all
    # five prop types, but a game log row is per pitcher per game — prefer the
    # strikeouts row so the stored `projection` keeps tracking K projections.
    by_pitcher: dict[tuple[int, int], dict] = {}
    for proj in projections:
        key = (proj["player_id"], proj["game_id"])
        if key not in by_pitcher or proj.get("prop_type") == "strikeouts":
            by_pitcher[key] = proj

    year = yesterday.year

    # Fetch each game's box score once, keyed by game_id
    box_cache: dict[int, dict] = {}

    rows: list[dict] = []
    for proj in by_pitcher.values():
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

        # Opposing (batting) team is the side the pitcher was NOT on. Use the
        # box score's authoritative home_away to pick it.
        side = result["home_away"]
        opp_team = proj["away_team"] if side == "home" else proj["home_team"]
        opp_k_rate = model._opp_k_rate(opp_team or "", year)

        # Days rest: difference to this pitcher's most recent prior start in
        # the logs, capped at 10. Defaults to 5 when there's no prior entry.
        last_date = db.get_last_game_date(player_id, yesterday_str)
        days_rest = 5
        if last_date:
            try:
                prev = date.fromisoformat(last_date)
                days_rest = min((yesterday - prev).days, 10)
            except Exception:
                days_rest = 5

        rows.append({
            "player_id":             player_id,
            "game_id":               game_id,
            "game_date":             yesterday_str,
            "actual_strikeouts":     result["actual_strikeouts"],
            "actual_hits_allowed":   result["actual_hits_allowed"],
            "actual_walks":          result["actual_walks"],
            "actual_earned_runs":    result["actual_earned_runs"],
            "actual_outs_recorded":  result["actual_outs_recorded"],
            "home_away":             side,
            "opp_k_rate":            opp_k_rate,
            "days_rest":             days_rest,
            "projection":            float(proj["projection"]),
        })
        print(
            f"  player {player_id}: projected {proj['projection']} K"
            f" -> actual {result['actual_strikeouts']} K"
            f" / {result['actual_hits_allowed']} H"
            f" / {result['actual_walks']} BB"
            f" / {result['actual_earned_runs']} ER"
            f" / {result['actual_outs_recorded']} outs"
            f"  (rest {days_rest}d, opp K% {opp_k_rate:.3f})"
        )

    print(f"  graded {len(rows)} / {len(by_pitcher)} projected pitchers")
    return rows
