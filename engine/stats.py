"""MLB Stats API pitching game-log fetcher.

Pure fetch layer — no Statcast, no DB code, no math beyond unit conversion.
All functions return plain Python dicts shaped for downstream consumers.
"""

from datetime import date, timedelta
from functools import lru_cache

import statsapi


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


@lru_cache(maxsize=64)
def get_pitcher_starts(
    player_id: int,
    lookback_days: int,
    end_date: date,
) -> list[dict]:
    """Return per-start pitching stats for one pitcher over a lookback window.

    Uses the MLB Stats API game-log endpoint — fast, no Statcast download.
    Returns newest start first. Returns [] gracefully on any API error.

    Each dict has keys:
        game_date       str  'YYYY-MM-DD'
        strikeouts      int
        hits_allowed    int
        walks           int
        earned_runs     int
        outs_recorded   int   (inningsPitched converted to outs)
    """
    start_date = end_date - timedelta(days=lookback_days)
    season = end_date.year

    try:
        raw = statsapi.get(
            "person",
            {
                "personId": player_id,
                "hydrate": f"stats(group=pitching,type=gameLog,season={season})",
            },
        )
    except Exception as exc:
        print(f"  statsapi error for player {player_id}: {exc}")
        return []

    splits: list[dict] = []
    for stat_group in raw.get("people", [{}])[0].get("stats", []):
        if stat_group.get("type", {}).get("displayName") == "gameLog":
            splits = stat_group.get("splits", [])
            break

    results: list[dict] = []
    for sp in splits:
        try:
            game_date = date.fromisoformat(sp["date"])
        except Exception:
            continue

        if not (start_date <= game_date <= end_date):
            continue

        st = sp.get("stat", {})
        results.append(
            {
                "game_date": sp["date"],
                "strikeouts": int(st.get("strikeOuts", 0)),
                "hits_allowed": int(st.get("hits", 0)),
                "walks": int(st.get("baseOnBalls", 0)),
                "earned_runs": int(st.get("earnedRuns", 0)),
                "outs_recorded": _parse_innings(st.get("inningsPitched", "0.0")),
            }
        )

    # Newest first so callers can slice [:5] for "last 5 starts"
    results.sort(key=lambda r: r["game_date"], reverse=True)
    return results


@lru_cache(maxsize=512)
def get_hitter_games(
    player_id: int,
    lookback_days: int,
    end_date: date,
) -> list[dict]:
    """Return per-game hitting stats for one batter over a lookback window.

    Uses the same MLB Stats API game-log endpoint as the pitcher fetcher
    (statsapi.get with a hydrate string), which is the approach proven to
    return splits reliably for this project. Newest game first. Returns []
    gracefully on any API error. lru_cached so all 5 hitter prop builders
    share one API call per batter per run.

    Each dict has keys:
        game_date    str  'YYYY-MM-DD'
        hits         int
        total_bases  int
        rbis         int
        runs         int
        home_runs    int
    """
    start_date = end_date - timedelta(days=lookback_days)
    season = end_date.year

    try:
        raw = statsapi.get(
            "person",
            {
                "personId": player_id,
                "hydrate": f"stats(group=hitting,type=gameLog,season={season})",
            },
        )
    except Exception as exc:
        print(f"  statsapi error for hitter {player_id}: {exc}")
        return []

    splits: list[dict] = []
    for stat_group in raw.get("people", [{}])[0].get("stats", []):
        if stat_group.get("type", {}).get("displayName") == "gameLog":
            splits = stat_group.get("splits", [])
            break

    results: list[dict] = []
    for sp in splits:
        try:
            game_date = date.fromisoformat(sp["date"])
        except Exception:
            continue

        if not (start_date <= game_date <= end_date):
            continue

        st = sp.get("stat", {})
        results.append(
            {
                "game_date": sp["date"],
                "hits": int(st.get("hits", 0)),
                "total_bases": int(st.get("totalBases", 0)),
                "rbis": int(st.get("rbi", 0)),
                "runs": int(st.get("runs", 0)),
                "home_runs": int(st.get("homeRuns", 0)),
            }
        )

    results.sort(key=lambda r: r["game_date"], reverse=True)
    return results
