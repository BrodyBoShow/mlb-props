"""Rolling batted-ball quality per hitter, from the bulk Statcast frame.

Display-only context for the HR-matchups card (avg exit velocity + sweet-spot%).
NOT a model input — these values never enter FEATURE_COLS, the projection, or the
edge math. They're computed from the SAME bulk Statcast DataFrame the pitcher
predict already fetches (filtered to the last `window_days`), so there's no extra
API call.

Sweet-spot uses Statcast's actual definition: a batted ball with a launch angle
between 8 and 32 degrees (NOT 25–35, which is the barrel window). A "batted ball
event" (BBE) is a row with both launch_angle and launch_speed measured.

Graceful degrade: a hitter with fewer than `min_bbe` batted balls in the window
(or no Statcast frame at all) is omitted from the result, so the frontend keeps
the existing "N games tracked" footer rather than showing a stat on a thin sample.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd

# Statcast sweet-spot launch-angle window (inclusive), in degrees.
SWEET_SPOT_MIN_ANGLE = 8.0
SWEET_SPOT_MAX_ANGLE = 32.0


def compute_sweet_spot(
    bulk_df: "pd.DataFrame | None",
    player_ids: list[int] | set[int],
    proj_date: date,
    window_days: int = 7,
    min_bbe: int = 5,
) -> dict[int, dict]:
    """{batter_id -> {sweet_spot_pct, avg_exit_velo, batted_balls}} for the window.

    bulk_df: the whole-window Statcast frame from model._fetch_bulk_statcast
             (covers ~30 days; we filter to the last `window_days`). Empty/None
             returns {}.
    player_ids: hitters to compute for (tonight's lineup). Others are ignored.

    Only hitters with >= min_bbe batted balls in the window appear in the result.
    sweet_spot_pct is a fraction (0..1); avg_exit_velo is mph, both rounded.
    """
    if bulk_df is None or len(bulk_df) == 0:
        return {}
    cols = bulk_df.columns
    if not {"batter", "launch_angle", "launch_speed", "game_date"}.issubset(cols):
        return {}

    wanted = {int(p) for p in player_ids}
    if not wanted:
        return {}

    import pandas as pd

    df = bulk_df[["batter", "launch_angle", "launch_speed", "game_date"]].copy()

    # Restrict to the trailing window. game_date is a 'YYYY-MM-DD' string in the
    # pybaseball output; coerce defensively.
    start = proj_date - timedelta(days=window_days)
    gd = pd.to_datetime(df["game_date"], errors="coerce").dt.date
    df = df[(gd > start) & (gd <= proj_date)]

    # Batted balls = rows with both launch metrics measured (fouls/whiffs are NaN).
    df = df[df["launch_angle"].notna() & df["launch_speed"].notna()]
    if df.empty:
        return {}

    # Only the hitters we care about.
    df = df[df["batter"].isin(wanted)]
    if df.empty:
        return {}

    out: dict[int, dict] = {}
    for batter_id, grp in df.groupby("batter"):
        n = len(grp)
        if n < min_bbe:
            continue
        in_window = grp["launch_angle"].between(
            SWEET_SPOT_MIN_ANGLE, SWEET_SPOT_MAX_ANGLE, inclusive="both"
        )
        out[int(batter_id)] = {
            "sweet_spot_pct": round(float(in_window.mean()), 3),
            "avg_exit_velo": round(float(grp["launch_speed"].mean()), 1),
            "batted_balls": int(n),
        }
    return out
