"""MLB Stats API data fetchers and team-rate helpers.

Pure fetch layer — no Statcast, no DB code, no math beyond unit conversion.
All functions return plain Python dicts shaped for downstream consumers.

Also owns team K-rate helpers (_opp_k_rate and friends) because they are
data-fetching utilities, not model logic. grade.py and model.py import from
here so the logic lives in exactly one place.
"""

from datetime import date, timedelta
from functools import lru_cache

import pybaseball
import statsapi

from constants import LEAGUE_AVG_K_PCT


# ─── team K-rate helpers ─────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _mlb_name_to_abbr() -> dict:
    """Full team name (MLB Stats API) -> abbreviation, e.g. 'New York Yankees' -> 'NYY'."""
    try:
        resp = statsapi.get("teams", {"sportId": 1, "activeStatus": "Yes"})
        return {t["name"]: t["abbreviation"] for t in resp.get("teams", [])}
    except Exception:
        return {}


@lru_cache(maxsize=4)
def _team_k_pcts(year: int) -> dict:
    """FanGraphs season team batting K%, keyed by FanGraphs abbreviation. Cached per year."""
    try:
        df = pybaseball.team_batting(year, qual=0)
        if df is None or df.empty or "K%" not in df.columns:
            return {}
        # FanGraphs sometimes returns fraction (0.22) or percent (22.0) — normalise.
        k_col = df["K%"]
        scale = 1.0 if float(k_col.max()) <= 1.0 else 100.0
        return {str(row["Team"]): float(row["K%"]) / scale for _, row in df.iterrows()}
    except Exception:
        return {}


# MLB Stats API full team name -> FanGraphs team abbreviation (the key
# _team_k_pcts uses). The statsapi abbreviation often differs from FanGraphs'
# (e.g. statsapi 'AZ' vs FanGraphs 'ARI'), so mapping the full name straight to
# the FanGraphs key avoids silent fallbacks. Covers all 30 teams.
TEAM_NAME_MAP = {
    "Arizona Diamondbacks":  "ARI",
    "Atlanta Braves":        "ATL",
    "Baltimore Orioles":     "BAL",
    "Boston Red Sox":        "BOS",
    "Chicago Cubs":          "CHC",
    "Chicago White Sox":     "CWS",
    "Cincinnati Reds":       "CIN",
    "Cleveland Guardians":   "CLE",
    "Colorado Rockies":      "COL",
    "Detroit Tigers":        "DET",
    "Houston Astros":        "HOU",
    "Kansas City Royals":    "KC",
    "Los Angeles Angels":    "LAA",
    "Los Angeles Dodgers":   "LAD",
    "Miami Marlins":         "MIA",
    "Milwaukee Brewers":     "MIL",
    "Minnesota Twins":       "MIN",
    "New York Mets":         "NYM",
    "New York Yankees":      "NYY",
    "Oakland Athletics":     "OAK",   # pre-2025 (FanGraphs historical key)
    "Athletics":             "ATH",   # 2025+ rebrand; statsapi current full name
    "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates":    "PIT",
    "San Diego Padres":      "SD",
    "San Francisco Giants":  "SF",
    "Seattle Mariners":      "SEA",
    "St. Louis Cardinals":   "STL",
    "Tampa Bay Rays":        "TB",
    "Texas Rangers":         "TEX",
    "Toronto Blue Jays":     "TOR",
    "Washington Nationals":  "WSH",
}


@lru_cache(maxsize=128)
def _opp_k_rate(opp_team_full_name: str, year: int) -> float:
    """K% of the opposing team as batters (0-1). Falls back to league average.

    Resolution order: TEAM_NAME_MAP (full name -> FanGraphs abbr), then the
    statsapi abbreviation, then a WARNING + league-average fallback so any
    unmatched team surfaces in the Actions log instead of silently degrading.
    """
    k_pcts = _team_k_pcts(year)

    # 1. Mapped FanGraphs abbreviation (preferred -- covers all 30 teams).
    mapped = TEAM_NAME_MAP.get(opp_team_full_name)
    if mapped and mapped in k_pcts:
        return k_pcts[mapped]

    # 2. Original name -> statsapi abbreviation.
    abbr = _mlb_name_to_abbr().get(opp_team_full_name)
    if abbr and abbr in k_pcts:
        return k_pcts[abbr]

    # 3. No match -- surface it so the mismatch is visible, then fall back.
    print(
        f"  WARNING: no FanGraphs K% match for team '{opp_team_full_name}' "
        f"(mapped={mapped}, abbr={abbr}) -- using league average"
    )
    return LEAGUE_AVG_K_PCT


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
