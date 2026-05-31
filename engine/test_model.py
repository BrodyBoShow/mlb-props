"""Diagnose XGBoost train() row-drop behavior against real Supabase data.

Run locally: python engine/test_model.py
Reads .env for SUPABASE_URL/SUPABASE_KEY (same as the pipeline).
"""

import pandas as pd

import db
from constants import LEAGUE_AVG_K_PCT
from model import FEATURE_COLS, MIN_TRAINING_ROWS


def main() -> None:
    print("=== test_model.py — XGBoost feature-engineering diagnostic ===\n")

    rows = db.get_game_logs()
    if rows is None:
        print("player_game_logs unreachable — aborting")
        return
    print(f"Step 0  total rows in player_game_logs: {len(rows)}")
    if not rows:
        return

    df = pd.DataFrame(rows)
    print(f"Step 0  columns: {sorted(df.columns)}")
    print(f"Step 0  null counts per column:")
    for c in sorted(df.columns):
        print(f"          {c:24s} nulls={int(df[c].isna().sum())}  dtype={df[c].dtype}")

    if "player_type" in df.columns:
        vc = df["player_type"].fillna("<NULL>").value_counts().to_dict()
        print(f"Step 0  player_type breakdown: {vc}")

    df = df.sort_values(["player_id", "game_date"]).reset_index(drop=True)

    # Step 1: type filter
    if "player_type" in df.columns:
        df = df[df["player_type"].fillna("pitcher") == "pitcher"].reset_index(drop=True)
    else:
        df = df[df["actual_strikeouts"].notna()].reset_index(drop=True)
    print(f"\nStep 1  pitcher rows after type filter: {len(df)}")
    if df.empty:
        print("  → empty after filter, stopping")
        return

    starts_per_pitcher = df.groupby("player_id").size()
    print(f"Step 1  unique pitchers: {len(starts_per_pitcher)}")
    print(f"Step 1  starts-per-pitcher: min={starts_per_pitcher.min()} "
          f"median={int(starts_per_pitcher.median())} max={starts_per_pitcher.max()}")
    print(f"Step 1  pitchers with exactly 1 start: {(starts_per_pitcher == 1).sum()}")

    # Step 2: rolling features
    df["is_home"] = (df["home_away"] == "home").astype(int)
    df["last5_k_rate"] = (
        df.groupby("player_id")["actual_strikeouts"]
        .transform(lambda x: x.shift(1).rolling(5, min_periods=1).mean())
    )
    df["last30_k_rate"] = (
        df.groupby("player_id")["actual_strikeouts"]
        .transform(lambda x: x.shift(1).rolling(30, min_periods=1).mean())
    )
    print(f"\nStep 2  after shift+rolling, NaN counts:")
    for c in ["last5_k_rate", "last30_k_rate", "is_home"]:
        print(f"          {c:18s} nulls={int(df[c].isna().sum())}")

    # Step 3: impute optional cols
    league_pitcher_k = float(df["actual_strikeouts"].mean()) if len(df) else 5.0
    print(f"\nStep 3  league_pitcher_k (in-pool mean of actual_strikeouts): {league_pitcher_k:.3f}")
    df["last5_k_rate"] = df["last5_k_rate"].fillna(league_pitcher_k)
    df["last30_k_rate"] = df["last30_k_rate"].fillna(league_pitcher_k)
    if "opp_k_rate" not in df.columns:
        df["opp_k_rate"] = LEAGUE_AVG_K_PCT
    df["opp_k_rate"] = pd.to_numeric(df["opp_k_rate"], errors="coerce").fillna(LEAGUE_AVG_K_PCT)
    if "days_rest" not in df.columns:
        df["days_rest"] = 5
    df["days_rest"] = pd.to_numeric(df["days_rest"], errors="coerce").fillna(5)

    print(f"Step 3  NaN counts AFTER imputation:")
    for c in FEATURE_COLS + ["actual_strikeouts"]:
        print(f"          {c:18s} nulls={int(df[c].isna().sum())}")

    before = len(df)
    df = df.dropna(subset=FEATURE_COLS + ["actual_strikeouts"])
    print(f"\nStep 4  dropna({FEATURE_COLS + ['actual_strikeouts']}): {before} -> {len(df)}")
    print(f"Step 4  MIN_TRAINING_ROWS={MIN_TRAINING_ROWS}  trains? {len(df) >= MIN_TRAINING_ROWS}")

    print("\nSample of final training frame (head 5):")
    print(df[FEATURE_COLS + ["actual_strikeouts"]].head().to_string(index=False))


if __name__ == "__main__":
    main()
