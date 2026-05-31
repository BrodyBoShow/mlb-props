"""XGBoost strikeout projection layer — step 8.

Feature engineering + optional training + inference. No DB writes here.
model.pkl is committed to the repo so it persists between runs.

Graceful degradation: if player_game_logs has fewer than MIN_TRAINING_ROWS
rows (or the table doesn't exist yet), training is skipped and predict()
returns [], signalling main.py to fall back to the baseline alone.
"""

from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import joblib
import pandas as pd
import pybaseball
import statsapi
from xgboost import XGBRegressor

MODEL_PATH = Path(__file__).parent / "model.pkl"
MIN_TRAINING_ROWS = 50
PROP_TYPE = "strikeouts"
STRIKEOUT_EVENTS = {"strikeout", "strikeout_double_play"}
LEAGUE_AVG_K_PCT = 0.22   # ~22% of PAs end in a K in modern MLB

FEATURE_COLS = ["last5_k_rate", "last30_k_rate", "is_home", "days_rest", "opp_k_rate"]


# ─── team K-rate helpers (fast, cached for the run) ─────────────────────────

@lru_cache(maxsize=1)
def _mlb_name_to_abbr() -> dict:
    """Full team name (MLB Stats API) → abbreviation, e.g. 'New York Yankees' → 'NYY'."""
    try:
        resp = statsapi.get("teams", {"sportId": 1, "activeStatus": "Yes"})
        return {t["name"]: t["abbreviation"] for t in resp.get("teams", [])}
    except Exception:
        return {}


@lru_cache(maxsize=4)
def _team_k_pcts(year: int) -> dict:
    """FanGraphs season team batting K%, keyed by abbreviation. Cached per year."""
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


def _opp_k_rate(opp_team_full_name: str, year: int) -> float:
    """K% of the opposing team as batters (0–1). Falls back to league average."""
    abbr = _mlb_name_to_abbr().get(opp_team_full_name)
    if not abbr:
        return LEAGUE_AVG_K_PCT
    kp = _team_k_pcts(year).get(abbr)
    return kp if kp is not None else LEAGUE_AVG_K_PCT


# ─── pitcher feature builder ─────────────────────────────────────────────────

def _build_pitcher_features(
    player_id: int,
    home_away: str,        # "home" | "away"
    opp_team_name: str,    # full team name from games table
    projection_date: date,
) -> dict | None:
    """Compute the 5 model features for one pitcher.

    Returns None if there isn't enough recent Statcast data to compute features —
    the caller skips this pitcher in that case.
    """
    end_dt = projection_date.strftime("%Y-%m-%d")
    start_30 = (projection_date - timedelta(days=30)).strftime("%Y-%m-%d")

    df = pybaseball.statcast_pitcher(start_30, end_dt, player_id)
    if df is None or df.empty:
        return None

    df = df.copy()
    df["is_k"] = df["events"].isin(STRIKEOUT_EVENTS)

    # K count per start, newest first
    per_game = df.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    if len(per_game) == 0:
        return None

    ks = per_game.tolist()

    # Feature 1 & 2: K rate over last 5 starts and full 30-day window
    last5_k_rate = sum(ks[:5]) / len(ks[:5])
    last30_k_rate = sum(ks) / len(ks)

    # Feature 3: days rest (capped at 10 — handles IL stints etc.)
    try:
        last_date = pd.to_datetime(df["game_date"].max()).date()
        days_rest = min((projection_date - last_date).days, 10)
    except Exception:
        days_rest = 5

    # Feature 4: home/away (1 = pitching at home)
    is_home = 1 if home_away == "home" else 0

    # Feature 5: opposing lineup's K rate as batters this season
    opp_k = _opp_k_rate(opp_team_name, projection_date.year)

    return {
        "last5_k_rate": last5_k_rate,
        "last30_k_rate": last30_k_rate,
        "is_home": is_home,
        "days_rest": days_rest,
        "opp_k_rate": opp_k,
    }


# ─── training ────────────────────────────────────────────────────────────────

def train(db_client) -> bool:
    """Try to train on player_game_logs; save model.pkl. Returns True if trained.

    Skips gracefully if the table doesn't exist or has fewer than MIN_TRAINING_ROWS rows.
    Expected columns in player_game_logs:
        player_id, game_date, actual_strikeouts, home_away, opp_k_rate (optional), days_rest (optional)
    """
    print("  checking player_game_logs for training data...")
    try:
        resp = db_client.table("player_game_logs").select("*").execute()
        rows = resp.data or []
    except Exception as exc:
        print(f"  player_game_logs not accessible ({exc}) — skipping training")
        return False

    if len(rows) < MIN_TRAINING_ROWS:
        print(f"  {len(rows)} rows in player_game_logs (need ≥ {MIN_TRAINING_ROWS}) — skipping training")
        return False

    print(f"  {len(rows)} training rows found")
    df = pd.DataFrame(rows).sort_values(["player_id", "game_date"]).reset_index(drop=True)

    # Build rolling features from the log table (no API calls needed for training)
    df["is_home"] = (df["home_away"] == "home").astype(int)
    df["last5_k_rate"] = (
        df.groupby("player_id")["actual_strikeouts"]
        .transform(lambda x: x.shift(1).rolling(5, min_periods=1).mean())
    )
    df["last30_k_rate"] = (
        df.groupby("player_id")["actual_strikeouts"]
        .transform(lambda x: x.shift(1).rolling(30, min_periods=1).mean())
    )
    if "opp_k_rate" not in df.columns:
        df["opp_k_rate"] = LEAGUE_AVG_K_PCT
    if "days_rest" not in df.columns:
        df["days_rest"] = 5

    df = df.dropna(subset=FEATURE_COLS + ["actual_strikeouts"])
    if len(df) < MIN_TRAINING_ROWS:
        print(f"  only {len(df)} usable rows after feature engineering — skipping training")
        return False

    X = df[FEATURE_COLS].values
    y = df["actual_strikeouts"].values

    model = XGBRegressor(
        n_estimators=100,
        max_depth=4,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
    )
    model.fit(X, y)
    joblib.dump(model, MODEL_PATH)
    print(f"  XGBoost trained on {len(df)} rows → saved {MODEL_PATH.name}")
    return True


# ─── inference ───────────────────────────────────────────────────────────────

def predict(
    starters: list[dict],
    games: list[dict],
    projection_date: date | None = None,
) -> list[dict]:
    """Load model.pkl and return projection rows shaped for the projections table.

    Returns [] when:
      - model.pkl doesn't exist yet (caller falls back to baseline)
      - a starter has insufficient recent data to compute features

    starters: list of dicts with player_id, game_id, full_name, home_away
    games:    list of dicts with game_id, home_team, away_team
    """
    if not MODEL_PATH.exists():
        print("  model.pkl not found — skipping XGBoost layer")
        return []

    model = joblib.load(MODEL_PATH)
    proj_date = projection_date or date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    game_map = {g["game_id"]: g for g in games}
    rows: list[dict] = []

    for s in starters:
        game = game_map.get(s["game_id"], {})
        home_away = s.get("home_away", "home")
        opp_team = game.get("away_team") if home_away == "home" else game.get("home_team")

        feats = _build_pitcher_features(
            s["player_id"], home_away, opp_team or "", proj_date
        )
        if feats is None:
            print(f"  no features for {s.get('full_name', s['player_id'])} — skipping model")
            continue

        vec = [[feats[c] for c in FEATURE_COLS]]
        pred = max(0.0, round(float(model.predict(vec)[0]), 1))
        rows.append({
            "game_id": s["game_id"],
            "player_id": s["player_id"],
            "prop_type": PROP_TYPE,
            "projection": pred,
            "projection_date": proj_date_str,
        })
        print(f"  {s.get('full_name', s['player_id'])}: {pred} K (model)")

    return rows
