"""Stage 2, Step A — VALIDATION HARNESS (read-only; NO live-model change).

Measures whether training the strikeout model on the backfilled season improves
held-out K prediction, BEFORE any decision to fold the backfill into train().
Pure read-only: builds two models in memory and compares them on a time-based
holdout of genuinely-graded games. Never touches model.train() or the DB.

Method (no leakage):
  * TEST = the most recent ~25% of GRADED pitcher starts (by date).
  * Model A (status quo): features from GRADED-only history; trained on graded
    rows before the cutoff.
  * Model B (with backfill): features from GRADED+BACKFILL history; trained on
    ALL rows before the cutoff. The backfill is entirely historical (< cutoff),
    so it can never enter the held-out test set.
  * Both predict the SAME held-out graded games. Lower RMSE wins.

Replicates train()'s EXACT feature engineering (FEATURE_COLS, _CONTEXT_DEFAULTS,
rolling last30_k_rate via shift(1), same XGBoost params + seed) so the answer
reflects the real model. Run: python engine/validate_backfill.py
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

import db
from constants import LEAGUE_AVG_K_PCT
from model import _CONTEXT_DEFAULTS, FEATURE_COLS
from xgboost import XGBRegressor


def _engineer(rows: list[dict]) -> pd.DataFrame:
    """train()'s feature engineering on an arbitrary row set. The rolling
    last30_k_rate sees only the rows passed in, so graded-only vs graded+backfill
    changes the available history (exactly the production difference)."""
    df = pd.DataFrame(rows).sort_values(["player_id", "game_date"]).reset_index(drop=True)
    if "player_type" in df.columns:
        df = df[df["player_type"].fillna("pitcher") == "pitcher"].reset_index(drop=True)
    df = df[df["actual_strikeouts"].notna()].reset_index(drop=True)
    if df.empty:
        return df

    df["is_home"] = (df["home_away"] == "home").astype(int)
    df["last30_k_rate"] = (
        df.groupby("player_id")["actual_strikeouts"]
        .transform(lambda x: x.shift(1).rolling(30, min_periods=1).mean())
    )
    league_k = float(df["actual_strikeouts"].mean()) if len(df) else 5.0
    df["last30_k_rate"] = df["last30_k_rate"].fillna(league_k)
    if "opp_k_rate" not in df.columns:
        df["opp_k_rate"] = LEAGUE_AVG_K_PCT
    df["opp_k_rate"] = pd.to_numeric(df["opp_k_rate"], errors="coerce").fillna(LEAGUE_AVG_K_PCT)
    if "days_rest" not in df.columns:
        df["days_rest"] = 5
    df["days_rest"] = pd.to_numeric(df["days_rest"], errors="coerce").fillna(5)
    for col, default in _CONTEXT_DEFAULTS:
        if col not in df.columns:
            df[col] = default
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(default)

    df = df.dropna(subset=FEATURE_COLS + ["actual_strikeouts"]).reset_index(drop=True)
    df["key"] = list(zip(df["player_id"].astype(int), df["game_id"].astype(int)))
    return df


def _fit(X, y) -> XGBRegressor:
    m = XGBRegressor(
        n_estimators=100, max_depth=4, learning_rate=0.1,
        subsample=0.8, colsample_bytree=0.8, random_state=42,
    )
    m.fit(X, y)
    return m


def _rmse(y, p) -> float:
    return float(np.sqrt(np.mean((np.asarray(y, float) - np.asarray(p, float)) ** 2)))


def _mae(y, p) -> float:
    return float(np.mean(np.abs(np.asarray(y, float) - np.asarray(p, float))))


def main() -> None:
    rows = db.get_game_logs()
    if not rows:
        print("no game logs available")
        return
    graded = [r for r in rows if not r.get("backfilled")]
    n_back = len(rows) - len(graded)
    print(f"loaded {len(rows)} rows ({len(graded)} graded, {n_back} backfilled)")

    gdf = _engineer(graded)
    if len(gdf) < 40:
        print(f"only {len(gdf)} usable graded pitcher rows — too few to validate")
        return

    # cutoff = the date at the 75th percentile of graded pitcher game_dates
    dates = sorted(str(d) for d in gdf["game_date"])
    cutoff = dates[int(0.75 * len(dates))]
    test_keys = set(gdf[gdf["game_date"].astype(str) >= cutoff]["key"])
    print(f"graded pitcher rows: {len(gdf)} | cutoff {cutoff} | held-out games: {len(test_keys)}")

    # Model A — graded-only features + training
    aTr = gdf[~gdf["key"].isin(test_keys)]
    aTe = gdf[gdf["key"].isin(test_keys)]

    # Model B — graded+backfill features; train on all rows before cutoff
    bdf = _engineer(rows)
    bTr = bdf[bdf["game_date"].astype(str) < cutoff]
    bTe = bdf[bdf["key"].isin(test_keys)]

    # Evaluate on the SAME games present in both test frames, identical order.
    common = sorted(set(aTe["key"]) & set(bTe["key"]))
    aTe = aTe.set_index("key").loc[common]
    bTe = bTe.set_index("key").loc[common]
    print(f"  train A (graded<cutoff): {len(aTr)} | train B (all<cutoff): {len(bTr)} | common test: {len(common)}")
    if len(common) < 20 or len(aTr) < 25 or len(bTr) < 25:
        print("  too few rows for a reliable read — let more graded data accumulate")
        return

    mA = _fit(aTr[FEATURE_COLS].values, aTr["actual_strikeouts"].values)
    mB = _fit(bTr[FEATURE_COLS].values, bTr["actual_strikeouts"].values)
    y = aTe["actual_strikeouts"].values.astype(float)   # same games -> same actuals
    pA = mA.predict(aTe[FEATURE_COLS].values)
    pB = mB.predict(bTe[FEATURE_COLS].values)
    base = float(aTr["actual_strikeouts"].mean())

    rA, rB = _rmse(y, pA), _rmse(y, pB)
    print(f"\n  RMSE baseline (always {base:.2f}): {_rmse(y, [base] * len(y)):.3f}")
    print(f"  RMSE model A (graded only):      {rA:.3f}  MAE {_mae(y, pA):.3f}")
    print(f"  RMSE model B (+ backfill):       {rB:.3f}  MAE {_mae(y, pB):.3f}")

    margin = 0.03
    if rB < rA - margin:
        print(
            f"\n  VERDICT: backfill HELPS (RMSE {rA:.3f} -> {rB:.3f}). Proceed to STEP B: "
            f"add home_away to the backfill, re-validate, then flip train()."
        )
    elif rB > rA + margin:
        print(
            f"\n  VERDICT: backfill HURTS (RMSE {rA:.3f} -> {rB:.3f}). Do NOT flip. "
            f"The cheap backfill dilutes (imputed Statcast features); pursue 2b "
            f"(real features via grader-replay) or leave train() as-is."
        )
    else:
        print(
            f"\n  VERDICT: ~no change (RMSE {rA:.3f} vs {rB:.3f}). Backfill doesn't help "
            f"the cheap way -> keep the foundation guard; revisit with 2b or more data."
        )


if __name__ == "__main__":
    main()
