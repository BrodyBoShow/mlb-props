"""Baseline projections from recent pitcher data.

All builders use the same weighted rolling-average pattern:
  - last RECENT_STARTS starts weighted RECENT_WEIGHT×
  - older starts weighted OLDER_WEIGHT×
  - skips pitchers with no data in the lookback window

No DB writes here — every function returns list[dict] shaped for the
projections table: game_id, player_id, prop_type, projection, projection_date.
"""

from datetime import date, timedelta

import pybaseball

import stats
from constants import (
    LEAGUE_AVG_K_PCT,
    LOOKBACK_DAYS,
    OLDER_WEIGHT,
    RECENT_STARTS,
    RECENT_WEIGHT,
    STRIKEOUT_EVENTS,
)


# ─── shared weighting logic ──────────────────────────────────────────────────

def _weighted_projection(values_newest_first: list[float]) -> float:
    """Weighted mean: last RECENT_STARTS values get RECENT_WEIGHT, rest OLDER_WEIGHT."""
    if not values_newest_first:
        return 0.0
    weights = [
        RECENT_WEIGHT if i < RECENT_STARTS else OLDER_WEIGHT
        for i in range(len(values_newest_first))
    ]
    total_w = sum(weights)
    if total_w == 0:
        return 0.0
    return round(
        sum(w * v for w, v in zip(weights, values_newest_first)) / total_w, 1
    )


# ─── strikeout projections (Statcast via pybaseball) ─────────────────────────

def _strikeouts_per_start(player_id: int, start_dt: str, end_dt: str) -> list[int]:
    """K count per start in the window, newest first (includes zero-K starts)."""
    df = pybaseball.statcast_pitcher(start_dt, end_dt, player_id)
    if df is None or df.empty:
        return []
    df = df.copy()
    df["is_k"] = df["events"].isin(STRIKEOUT_EVENTS)
    per_game = df.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    return [int(k) for k in per_game.tolist()]


def build_strikeout_projections(
    starters: list[dict], projection_date: date | None = None
) -> list[dict]:
    """One strikeout projection per probable starter with recent Statcast data."""
    proj_date = projection_date or date.today()
    start_dt = (proj_date - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    end_dt = proj_date.strftime("%Y-%m-%d")
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        ks = _strikeouts_per_start(player_id, start_dt, end_dt)
        if not ks:
            print(f"  no recent Statcast data for player {player_id}, skipping")
            continue
        projection = _weighted_projection(ks)
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": "strikeouts",
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {s.get('full_name', player_id)}: {ks} -> {projection} K")
    return rows


# ─── MLB Stats API builders (hits, walks, earned runs, outs) ─────────────────

def _build_from_starts(
    starters: list[dict],
    field: str,
    prop_type: str,
    label: str,
    projection_date: date | None = None,
) -> list[dict]:
    """Generic weighted-average builder using stats.get_pitcher_starts().

    field:     key in the dicts returned by stats.get_pitcher_starts()
    prop_type: value to store in the projections table
    label:     short unit string for stdout (e.g. 'H', 'BB')
    """
    proj_date = projection_date or date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        starts = stats.get_pitcher_starts(player_id, LOOKBACK_DAYS, proj_date)
        if not starts:
            print(f"  no recent game-log data for player {player_id}, skipping")
            continue
        values = [float(sp[field]) for sp in starts]
        projection = _weighted_projection(values)
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": prop_type,
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {s.get('full_name', player_id)}: {values[:5]} -> {projection} {label}")
    return rows


def build_hits_allowed_projections(
    starters: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for hits allowed per start."""
    return _build_from_starts(starters, "hits_allowed", "hits_allowed", "H", projection_date)


def build_walks_projections(
    starters: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for walks (BB) per start."""
    return _build_from_starts(starters, "walks", "walks", "BB", projection_date)


def build_earned_runs_projections(
    starters: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for earned runs per start."""
    return _build_from_starts(starters, "earned_runs", "earned_runs", "ER", projection_date)


def build_outs_recorded_projections(
    starters: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for outs recorded per start."""
    return _build_from_starts(starters, "outs_recorded", "outs_recorded", "outs", projection_date)


# ─── hitter builders (MLB Stats API game logs) ───────────────────────────────

def _build_hitter_from_games(
    players: list[dict],
    field: str,
    prop_type: str,
    label: str,
    projection_date: date | None = None,
) -> list[dict]:
    """Generic weighted-average builder for hitters using stats.get_hitter_games().

    Mirrors _build_from_starts but for lineup hitters. Each player dict must
    carry player_id, game_id, and full_name (from fetch.fetch_lineups()).

    field:     key in the dicts returned by stats.get_hitter_games()
    prop_type: value to store in the projections table
    label:     short unit string for stdout (e.g. 'H', 'TB')
    """
    proj_date = projection_date or date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for p in players:
        player_id = p["player_id"]
        games = stats.get_hitter_games(player_id, LOOKBACK_DAYS, proj_date)
        if not games:
            print(f"  no recent game-log data for hitter {player_id}, skipping")
            continue
        values = [float(g[field]) for g in games]
        projection = _weighted_projection(values)
        rows.append(
            {
                "game_id": p["game_id"],
                "player_id": player_id,
                "prop_type": prop_type,
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {p.get('full_name', player_id)}: {values[:5]} -> {projection} {label}")
    return rows


def build_hitter_hits_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for a hitter's hits per game."""
    return _build_hitter_from_games(lineup_players, "hits", "hitter_hits", "H", projection_date)


def build_hitter_total_bases_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for a hitter's total bases per game."""
    return _build_hitter_from_games(lineup_players, "total_bases", "hitter_total_bases", "TB", projection_date)


def build_hitter_rbis_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for a hitter's RBIs per game."""
    return _build_hitter_from_games(lineup_players, "rbis", "hitter_rbis", "RBI", projection_date)


def build_hitter_runs_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for a hitter's runs per game."""
    return _build_hitter_from_games(lineup_players, "runs", "hitter_runs", "R", projection_date)


def build_hitter_home_runs_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> list[dict]:
    """Weighted rolling projection for a hitter's home runs per game."""
    return _build_hitter_from_games(lineup_players, "home_runs", "hitter_home_runs", "HR", projection_date)


if __name__ == "__main__":
    import fetch
    starters = fetch.fetch_starters()
    print(f"Building strikeout projections for {len(starters)} starters...")
    rows = build_strikeout_projections(starters)
    print(f"\nProduced {len(rows)} projections")
