"""Baseline strikeout projections from recent Statcast pitcher data.

Weighted rolling average: the last 5 starts count more than older ones.
No DB writes here — returns rows shaped for the `projections` table.
"""

from datetime import date, timedelta

import pybaseball

LOOKBACK_DAYS = 30
RECENT_STARTS = 5          # how many recent starts get the heavier weight
RECENT_WEIGHT = 2.0        # weight applied to the last RECENT_STARTS starts
OLDER_WEIGHT = 1.0         # weight applied to everything older
STRIKEOUT_EVENTS = {"strikeout", "strikeout_double_play"}

PROP_TYPE = "strikeouts"


def _strikeouts_per_start(player_id: int, start_dt: str, end_dt: str) -> list[int]:
    """K count for each start in the window, newest start first.

    Includes zero-K starts (a game the pitcher appeared in but fanned nobody),
    so the average isn't biased upward.
    """
    df = pybaseball.statcast_pitcher(start_dt, end_dt, player_id)
    if df is None or df.empty:
        return []

    df = df.copy()
    df["is_k"] = df["events"].isin(STRIKEOUT_EVENTS)
    per_game = df.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    return [int(k) for k in per_game.tolist()]


def _weighted_projection(ks_newest_first: list[int]) -> float:
    """Weighted mean of per-start K counts; recent starts weighted heavier."""
    weights = [
        RECENT_WEIGHT if i < RECENT_STARTS else OLDER_WEIGHT
        for i in range(len(ks_newest_first))
    ]
    total_w = sum(weights)
    if total_w == 0:
        return 0.0
    weighted_sum = sum(w * k for w, k in zip(weights, ks_newest_first))
    return round(weighted_sum / total_w, 1)


def build_strikeout_projections(
    starters: list[dict], projection_date: date | None = None
) -> list[dict]:
    """One strikeout projection per probable starter with recent data.

    starters: dicts with at least player_id and game_id (from fetch.fetch_starters).
    Skips pitchers with no starts in the lookback window.
    """
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
                "prop_type": PROP_TYPE,
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {s.get('full_name', player_id)}: {ks} -> {projection} K")

    return rows


if __name__ == "__main__":
    import fetch

    starters = fetch.fetch_starters()
    print(f"Building strikeout projections for {len(starters)} starters...")
    projections = build_strikeout_projections(starters)
    print(f"\nProduced {len(projections)} projections")
