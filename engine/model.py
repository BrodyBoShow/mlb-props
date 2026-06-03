"""XGBoost strikeout projection layer — step 8.

Feature engineering + optional training + inference. No DB writes here.

Graceful degradation: if player_game_logs has fewer than MIN_TRAINING_ROWS
rows (or the table doesn't exist yet), train() returns None and predict()
is never called — main.py falls back to the baseline alone.

Statcast efficiency: predict() does ONE bulk pybaseball.statcast() call
for the whole lookback window, then filters the resulting DataFrame
per-pitcher in memory. Before this change every starter triggered its own
statcast_pitcher() request (~30 round-trips per cron run, slow and
rate-limit-risky). _build_pitcher_features() is kept as a defensive
fallback for the rare case the bulk fetch returns empty.

The model object lives in memory for the duration of one pipeline run only.
No pkl file is written or read; the model retrains on every Actions run.
"""

from datetime import date, timedelta
from functools import lru_cache

from typing import TYPE_CHECKING

import db
import pandas as pd
import pybaseball
import statsapi
from xgboost import XGBRegressor

if TYPE_CHECKING:
    from schemas import PitcherFeatureRow, ProjectionRow

from constants import (
    LEAGUE_AVG_K_PCT,
    MIN_TRAINING_ROWS,
    STATCAST_LOOKBACK_DAYS,
    STRIKEOUT_EVENTS,
    et_today,
    get_park_factor_k,
)
from stats import _opp_k_rate

PROP_TYPE = "strikeouts"

# Pitch-type sets (Statcast pitch_type codes). Used by both predict-time
# feature building and grade.py's per-pitcher mix logging.
FASTBALL_TYPES = {"FF", "SI", "FC"}
BREAKING_TYPES = {"SL", "CU", "KC", "SV", "CS"}
OFFSPEED_TYPES = {"CH", "FS", "FO", "SC"}

# Feature column order. The first five are the legacy required features the
# model has always used; the rest are context features that may be NULL on
# rows graded before the schema migration. train() imputes the NULLs with
# the per-feature defaults below so adding columns never blocks training.
FEATURE_COLS = [
    "last30_k_rate",
    "is_home",
    "days_rest",
    "opp_k_rate",
    # Context features (additive — imputed when missing)
    "lineup_lhh_pct",
    "pitcher_k_vs_lhh",
    "pitcher_k_vs_rhh",
    "pitcher_avg_velo",
    "park_factor_k",
    # Swing-and-miss — the highest-signal K predictors (30-day window). Same
    # definitions as grade.py's _pitcher_platoon_30d: whiff% = whiffs/swings,
    # CSW% = (called + swinging strikes)/pitches. These REPLACED last5_k_rate
    # (high-variance on tiny samples, subsumed by last30 + whiff) and
    # pitcher_fastball_pct (fastball% only crudely proxies the swing-and-miss
    # these measure directly). Count held at exactly 11.
    "pitcher_whiff_pct_30d",
    "pitcher_csw_pct_30d",
]

# (column, default-when-missing). Used by train() to fill NULLs without
# dropping rows; also used at predict-time as the constant value for any
# context feature that can't be computed for a particular pitcher.
_CONTEXT_DEFAULTS: list[tuple[str, float]] = [
    ("lineup_lhh_pct",        0.42),
    ("pitcher_k_vs_lhh",      LEAGUE_AVG_K_PCT),
    ("pitcher_k_vs_rhh",      LEAGUE_AVG_K_PCT),
    ("pitcher_avg_velo",      93.5),
    ("park_factor_k",         1.0),
    # Swing-and-miss league means from the live pool. NOTE these match
    # grade.py's per-SWING / per-pitch definitions (whiffs/swings ~0.22,
    # CSW ~0.27) — NOT the ~0.11 per-pitch SwStr% metric.
    ("pitcher_whiff_pct_30d", 0.22),
    ("pitcher_csw_pct_30d",   0.27),
]


# ─── bulk Statcast fetch (predict-time only) ─────────────────────────────────

def _fetch_bulk_statcast(proj_date: date) -> pd.DataFrame:
    """Pull every pitch in the STATCAST_LOOKBACK_DAYS window in ONE API call.

    Returns an empty DataFrame on any failure so the caller can fall back to
    per-pitcher fetches without crashing. The whole-window DataFrame is a few
    hundred MB at the height of the season but pandas handles it fine.
    """
    end_dt = proj_date.strftime("%Y-%m-%d")
    start_dt = (proj_date - timedelta(days=STATCAST_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    try:
        df = pybaseball.statcast(start_dt=start_dt, end_dt=end_dt)
    except Exception as exc:
        print(f"  WARNING: bulk Statcast fetch failed: {exc}")
        return pd.DataFrame()
    if df is None or df.empty:
        return pd.DataFrame()
    return df


# ─── pitcher feature builder (bulk path) ─────────────────────────────────────

def _build_pitcher_features_from_df(
    player_id: int,
    bulk_df: pd.DataFrame,
    home_away: str,
    opp_team_name: str,
    projection_date: date,
    home_team: str = "",
) -> "PitcherFeatureRow | None":
    """Compute the model feature row for one pitcher from a pre-fetched DataFrame.

    Filters bulk_df to rows where pitcher == player_id. Returns None when the
    pitcher has no rows in the bulk window. Builds the legacy 5 features plus
    the additive context features (platoon, pitch mix, velo trend, park).
    Park factor takes the HOME team (the pitcher's park if home, else the
    opponent's park if away — but home_team is always the venue team).
    """
    pitcher_df = bulk_df[bulk_df["pitcher"] == player_id]
    if pitcher_df.empty:
        return None

    df = pitcher_df.copy()
    df["is_k"] = df["events"].isin(STRIKEOUT_EVENTS)

    # K count per start, newest first.
    per_game = df.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    if len(per_game) == 0:
        return None
    ks = per_game.tolist()

    # Features 1 & 2: K rate over last 5 starts and full 30-day window.
    last5_k_rate = sum(ks[:5]) / len(ks[:5])
    last30_k_rate = sum(ks) / len(ks)

    # Feature 3: days rest, capped at 10.
    try:
        last_date = pd.to_datetime(df["game_date"].max()).date()
        days_rest = min((projection_date - last_date).days, 10)
    except Exception:
        days_rest = 5

    # Feature 4: home/away.
    is_home = 1 if home_away == "home" else 0

    # Feature 5: opposing lineup K%.
    opp_k = _opp_k_rate(opp_team_name, projection_date.year)

    # ── platoon splits ─────────────────────────────────────────────────────
    # Strict K rate vs LHH / RHH over the bulk window. Fall back to league
    # K% only when the pitcher has < 20 PAs vs that side (rookies, recent
    # call-ups). The bulk_df row count is per-PITCH so 20 is a low bar.
    lhh_df = df[df["stand"] == "L"]
    rhh_df = df[df["stand"] == "R"]
    k_vs_lhh = (
        float(lhh_df["is_k"].mean()) if len(lhh_df) >= 20 else LEAGUE_AVG_K_PCT
    )
    k_vs_rhh = (
        float(rhh_df["is_k"].mean()) if len(rhh_df) >= 20 else LEAGUE_AVG_K_PCT
    )

    # ── pitch mix + velocity ──────────────────────────────────────────────
    total_pitches = len(df)
    if total_pitches > 0:
        fastball_pct = df["pitch_type"].isin(FASTBALL_TYPES).sum() / total_pitches
        breaking_pct = df["pitch_type"].isin(BREAKING_TYPES).sum() / total_pitches
        offspeed_pct = df["pitch_type"].isin(OFFSPEED_TYPES).sum() / total_pitches

        fb_df = df[df["pitch_type"].isin(FASTBALL_TYPES)]
        avg_velo = (
            float(fb_df["release_speed"].mean()) if len(fb_df) > 0 else 93.5
        )

        # Velocity trend: last 2 starts vs prior. Negative = losing velo.
        per_game_velo = (
            df[df["pitch_type"].isin(FASTBALL_TYPES)]
            .groupby("game_date")["release_speed"]
            .mean()
            .sort_index()
        )
        if len(per_game_velo) >= 4:
            recent = per_game_velo.iloc[-2:].mean()
            older = per_game_velo.iloc[:-2].mean()
            velo_trend = round(float(recent - older), 2)
        else:
            velo_trend = 0.0
    else:
        fastball_pct = 0.55
        breaking_pct = 0.25
        offspeed_pct = 0.10
        avg_velo = 93.5
        velo_trend = 0.0

    # ── swing-and-miss: whiff% / CSW% (30-day window) ──────────────────────
    # Computed from the SAME pitch-event definitions as grade.py's
    # _pitcher_platoon_30d so train (stored column) and predict agree. The bulk
    # window already excludes today's unplayed game, so this is strict-prior.
    # Fall back to the league default only when the pitcher has no pitches of
    # the relevant kind in the window.
    if "description" in df.columns and total_pitches > 0:
        desc = df["description"]
        whiffs = int(desc.isin(["swinging_strike", "swinging_strike_blocked"]).sum())
        swings = int(
            desc.isin(
                ["swinging_strike", "swinging_strike_blocked",
                 "foul", "foul_tip", "hit_into_play"]
            ).sum()
        )
        called = int(desc.isin(["called_strike"]).sum())
        whiff_pct_30d = round(whiffs / swings, 3) if swings > 0 else 0.22
        csw_pct_30d = round((called + whiffs) / total_pitches, 3)
    else:
        whiff_pct_30d = 0.22
        csw_pct_30d = 0.27

    # ── park factor (K) ───────────────────────────────────────────────────
    park_k = get_park_factor_k(home_team) if home_team else 1.0

    return {
        # legacy 5
        "last5_k_rate": last5_k_rate,
        "last30_k_rate": last30_k_rate,
        "is_home": is_home,
        "days_rest": days_rest,
        "opp_k_rate": opp_k,
        # context features
        "pitcher_k_vs_lhh":     round(float(k_vs_lhh), 4),
        "pitcher_k_vs_rhh":     round(float(k_vs_rhh), 4),
        "pitcher_fastball_pct": round(float(fastball_pct), 3),
        "pitcher_breaking_pct": round(float(breaking_pct), 3),
        "pitcher_offspeed_pct": round(float(offspeed_pct), 3),
        "pitcher_avg_velo":     round(float(avg_velo), 1),
        "pitcher_velo_trend":   velo_trend,
        "park_factor_k":        park_k,
        # swing-and-miss (the two new FEATURE_COLS entries)
        "pitcher_whiff_pct_30d": whiff_pct_30d,
        "pitcher_csw_pct_30d":   csw_pct_30d,
        # lineup_lhh_pct: placeholder. predict() OVERRIDES this with the real
        # opposing-lineup value (via lineup_lhh_by_pid) when lineups are posted;
        # it stays 0.42 only on pre-lineup (morning) runs. train() imputes the
        # same league average for rows graded before lineup handedness was logged.
        "lineup_lhh_pct":       0.42,
    }


# ─── pitcher feature builder (legacy per-pitcher fetch, fallback only) ──────

def _build_pitcher_features(
    player_id: int,
    home_away: str,
    opp_team_name: str,
    projection_date: date,
) -> "PitcherFeatureRow | None":
    """Fetch one pitcher's Statcast slice and compute features.

    KEPT for use as a defensive fallback when the bulk Statcast fetch
    returns empty (network/Savant flake). For the normal path the bulk
    fetch + filter pattern is ~30x faster and avoids 30 separate
    Baseball Savant requests per cron run.
    """
    end_dt = projection_date.strftime("%Y-%m-%d")
    start_dt = (projection_date - timedelta(days=STATCAST_LOOKBACK_DAYS)).strftime("%Y-%m-%d")

    df = pybaseball.statcast_pitcher(start_dt, end_dt, player_id)
    if df is None or df.empty:
        return None

    df = df.copy()
    df["is_k"] = df["events"].isin(STRIKEOUT_EVENTS)

    per_game = df.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    if len(per_game) == 0:
        return None

    ks = per_game.tolist()
    last5_k_rate = sum(ks[:5]) / len(ks[:5])
    last30_k_rate = sum(ks) / len(ks)

    try:
        last_date = pd.to_datetime(df["game_date"].max()).date()
        days_rest = min((projection_date - last_date).days, 10)
    except Exception:
        days_rest = 5

    is_home = 1 if home_away == "home" else 0
    opp_k = _opp_k_rate(opp_team_name, projection_date.year)

    return {
        "last5_k_rate": last5_k_rate,
        "last30_k_rate": last30_k_rate,
        "is_home": is_home,
        "days_rest": days_rest,
        "opp_k_rate": opp_k,
    }


# ─── training ────────────────────────────────────────────────────────────────

def train() -> XGBRegressor | None:
    """Try to train on player_game_logs; return the fitted model or None.

    Returns None (and prints why) when:
      - player_game_logs doesn't exist or isn't reachable
      - fewer than MIN_TRAINING_ROWS rows are available
      - insufficient rows remain after feature engineering

    Expected columns in player_game_logs:
        player_id, game_date, actual_strikeouts, home_away,
        opp_k_rate (optional), days_rest (optional)
    """
    print("  checking player_game_logs for training data...")
    rows = db.get_game_logs()

    if rows is None:
        # get_game_logs already printed the reason
        return None

    if len(rows) < MIN_TRAINING_ROWS:
        print(f"  {len(rows)} rows in player_game_logs (need >= {MIN_TRAINING_ROWS}) -- skipping training")
        return None

    print(f"  {len(rows)} training rows found")
    df = pd.DataFrame(rows).sort_values(["player_id", "game_date"]).reset_index(drop=True)

    # Step 1: keep only pitcher rows. player_game_logs mixes pitcher + hitter
    # rows (hitter rows have actual_strikeouts=NULL); training on hitter rows
    # produces all-NaN features and silently drops the entire pool.
    if "player_type" in df.columns:
        df = df[df["player_type"].fillna("pitcher") == "pitcher"].reset_index(drop=True)
    else:
        df = df[df["actual_strikeouts"].notna()].reset_index(drop=True)
    print(f"  {len(df)} pitcher rows after type filter")

    # Step 2: rolling features. shift(1) prevents leakage of the current game's
    # K count into its own feature, but it makes the FIRST row per player NaN.
    # Early-season many pitchers have only 1-2 starts, so we impute the NaN
    # first-row values with the league pitcher K average (~5.0 per start)
    # instead of dropping them — this preserves the training pool.
    df["is_home"] = (df["home_away"] == "home").astype(int)
    # last5_k_rate was dropped from FEATURE_COLS (high-variance on tiny samples);
    # only the 30-day rolling K rate remains as the recency baseline feature.
    df["last30_k_rate"] = (
        df.groupby("player_id")["actual_strikeouts"]
        .transform(lambda x: x.shift(1).rolling(30, min_periods=1).mean())
    )

    # Step 3: impute optional columns. opp_k_rate may be NULL on rows graded
    # while FanGraphs returned 403 on the Actions runner; days_rest may be
    # NULL on the first row of the season. Fill rather than drop.
    league_pitcher_k = float(df["actual_strikeouts"].mean()) if len(df) else 5.0
    df["last30_k_rate"] = df["last30_k_rate"].fillna(league_pitcher_k)
    if "opp_k_rate" not in df.columns:
        df["opp_k_rate"] = LEAGUE_AVG_K_PCT
    df["opp_k_rate"] = pd.to_numeric(df["opp_k_rate"], errors="coerce").fillna(LEAGUE_AVG_K_PCT)
    if "days_rest" not in df.columns:
        df["days_rest"] = 5
    df["days_rest"] = pd.to_numeric(df["days_rest"], errors="coerce").fillna(5)

    # Context features: NULL on rows graded before the feature-logging
    # migration. Impute with the per-feature defaults so training proceeds
    # without dropping pre-migration rows. As graded data accumulates with
    # real values, the imputed-default rows become a shrinking share and
    # the model picks up real signal automatically.
    for col, default in _CONTEXT_DEFAULTS:
        if col not in df.columns:
            df[col] = default
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(default)

    # Diagnostics: per-column NaN counts before the final drop
    nan_counts = {c: int(df[c].isna().sum()) for c in FEATURE_COLS + ["actual_strikeouts"]}
    print(f"  NaN counts after imputation: {nan_counts}")

    df = df.dropna(subset=FEATURE_COLS + ["actual_strikeouts"])
    if len(df) < MIN_TRAINING_ROWS:
        print(f"  only {len(df)} usable rows after feature engineering — skipping training")
        return None

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
    print(f"  XGBoost trained on {len(df)} rows")
    return model


# ─── inference ───────────────────────────────────────────────────────────────

def predict(
    model: XGBRegressor,
    starters: list[dict],
    games: list[dict],
    projection_date: date | None = None,
    lineup_lhh_by_pid: dict[int, float] | None = None,
) -> "tuple[list[ProjectionRow], pd.DataFrame]":
    """Run the trained model and return projection rows + the bulk Statcast frame.

    Returns (rows, bulk_df). The caller can hand bulk_df to baseline.build_
    strikeout_projections so both layers share a single Statcast fetch.
    bulk_df is an empty DataFrame when the fetch failed.

    model:    fitted XGBRegressor returned by train()
    starters: list of dicts with player_id, game_id, full_name, home_away
    games:    list of dicts with game_id, home_team, away_team

    Skips individual pitchers that don't have enough Statcast data for features.

    The bulk Statcast fetch happens ONCE before the per-pitcher loop. Each
    pitcher's features are computed by filtering the cached DataFrame, not by
    a fresh API call. If the bulk fetch comes back empty (Savant flake) we
    fall back to per-pitcher fetches so the run can still produce projections.
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    print(f"  bulk Statcast fetch for {STATCAST_LOOKBACK_DAYS}-day window...")
    bulk_df = _fetch_bulk_statcast(proj_date)
    bulk_ok = not bulk_df.empty
    if bulk_ok:
        n_pitchers = bulk_df["pitcher"].nunique() if "pitcher" in bulk_df.columns else 0
        print(
            f"  bulk Statcast fetch: {len(bulk_df)} pitches "
            f"covering {n_pitchers} pitchers"
        )
    else:
        print("  bulk fetch empty — falling back to per-pitcher Statcast requests")

    game_map = {g["game_id"]: g for g in games}
    rows: list[dict] = []

    for s in starters:
        game = game_map.get(s["game_id"], {})
        home_away = s.get("home_away", "home")
        opp_team = game.get("away_team") if home_away == "home" else game.get("home_team")
        home_team = game.get("home_team", "")

        if bulk_ok:
            feats = _build_pitcher_features_from_df(
                s["player_id"], bulk_df, home_away, opp_team or "", proj_date,
                home_team=home_team,
            )
        else:
            feats = _build_pitcher_features(
                s["player_id"], home_away, opp_team or "", proj_date
            )

        if feats is None:
            print(f"  no features for {s.get('full_name', s['player_id'])} — skipping model")
            continue

        # lineup_lhh_pct: when the OPPOSING posted lineup is available, override
        # the 0.42 placeholder from the feature builder with the real value
        # (same metric grade.py logs, so the trained weight applies). Stays 0.42
        # when no lineup is posted (morning runs) — the genuine "no lineup yet"
        # fallback, not a permanent hardcode.
        if lineup_lhh_by_pid:
            lh = lineup_lhh_by_pid.get(s["player_id"])
            if lh is not None:
                feats["lineup_lhh_pct"] = lh

        # Fill any missing context features with their training defaults so
        # the legacy fallback (_build_pitcher_features) — which only returns
        # the original 5 — still produces a vec with the right shape.
        for col, default in _CONTEXT_DEFAULTS:
            feats.setdefault(col, default)

        vec = [[feats[c] for c in FEATURE_COLS]]
        pred = max(0.0, round(float(model.predict(vec)[0]), 1))
        rows.append({
            "game_id": s["game_id"],
            "player_id": s["player_id"],
            "prop_type": PROP_TYPE,
            "projection": pred,
            "projection_date": proj_date_str,
            # Persist the opposing-lineup K rate that the feature builder
            # already computed (feature 4 / Option A). It's discarded
            # everywhere else — saving it onto the strikeouts row lets the
            # frontend show "Facing a X% K lineup" without recomputing.
            # Strikeouts is the only prop the model runs, so this is the
            # only prop that carries opp_k_rate — exactly where it's shown.
            "opp_k_rate": round(float(feats["opp_k_rate"]), 4),
        })
        print(f"  {s.get('full_name', s['player_id'])}: {pred} K (model)")

    return rows, bulk_df
