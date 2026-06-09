"""Step 1 of the matchup-aware rebuild: REDUCE RECENCY BIAS.

Offline backtest comparing the current recency-heavy baseline to a STABILIZED
multi-window talent blend, on the backfilled season, by RMSE + MAE. The current
builder weights the last RECENT_STARTS(5) games 2x; the user's concern is that
this over-reacts to hot/cold streaks. The stabilized blend demotes recent form
to one input among season-long talent + a medium window, with shrinkage to the
league prior for thin samples.

Read-only. Run: python validate_talent.py
"""
import db
import statistics as st
from collections import defaultdict
from constants import (
    RECENT_STARTS, RECENT_WEIGHT, OLDER_WEIGHT, HITTER_REGRESSION_K,
    HITTER_LEAGUE_PRIOR,
)

# Prop -> (actual column, league prior per game, player_type)
PROPS = {
    "hitter_total_bases":    ("actual_total_bases", HITTER_LEAGUE_PRIOR["hitter_total_bases"], "hitter"),
    "hitter_hits":           ("actual_hits", HITTER_LEAGUE_PRIOR["hitter_hits"], "hitter"),
    "hitter_hits_runs_rbis": ("actual_hits_runs_rbis", HITTER_LEAGUE_PRIOR["hitter_hits_runs_rbis"], "hitter"),
    "hitter_runs":           ("actual_runs", HITTER_LEAGUE_PRIOR["hitter_runs"], "hitter"),
    "hitter_rbis":           ("actual_rbis", HITTER_LEAGUE_PRIOR["hitter_rbis"], "hitter"),
    "hitter_home_runs":      ("actual_home_runs", HITTER_LEAGUE_PRIOR["hitter_home_runs"], "hitter"),
    "hits_allowed":          ("actual_hits_allowed", 5.0, "pitcher"),
    "earned_runs":           ("actual_earned_runs", 2.5, "pitcher"),
    "walks":                 ("actual_walks", 2.0, "pitcher"),
    "outs_recorded":         ("actual_outs_recorded", 16.0, "pitcher"),
    "strikeouts":            ("actual_strikeouts", 5.0, "pitcher"),
}


def load(col, ptype):
    rows, pg = [], 0
    while True:
        r = (db._client().table("player_game_logs")
             .select(f"player_id,game_date,{col}")
             .eq("player_type", ptype).not_.is_(col, "null")
             .range(pg * 1000, pg * 1000 + 999).execute().data)
        if not r:
            break
        rows += r
        if len(r) < 1000:
            break
        pg += 1
    return rows


# The live builder fetches LOOKBACK_DAYS=30 of games (~25 for a regular) and
# weights them with last-5 2x. We cap the prior window to ~30 games to mirror
# that, so the comparison is apples-to-apples (same data window, different
# weighting — which is exactly the recency-bias question).
LIVE_WINDOW = 30

def current_baseline(prior_newest_first, prior_val):
    """Replicates the live builder: last-5 2x over the 30-day window + k=3 regress."""
    v = prior_newest_first[:LIVE_WINDOW]
    w = [RECENT_WEIGHT if i < RECENT_STARTS else OLDER_WEIGHT for i in range(len(v))]
    wsum = sum(x * wi for x, wi in zip(v, w))
    sw = sum(w)
    return (wsum + HITTER_REGRESSION_K * prior_val) / (sw + HITTER_REGRESSION_K)


def stabilized(prior_newest_first, prior_val, w_season, w_mid, w_form, k, season_win):
    """Multi-window talent blend: season (up to season_win games) + medium (20) +
    small recent-form (5), regressed to the league prior by k pseudo-games."""
    n = len(prior_newest_first)
    season = st.mean(prior_newest_first[:season_win]) if n else prior_val
    mid = st.mean(prior_newest_first[:20]) if n else prior_val
    form = st.mean(prior_newest_first[:5]) if n else prior_val
    blend = w_season * season + w_mid * mid + w_form * form
    eff = min(n, 25)
    return (eff * blend + k * prior_val) / (eff + k)


# (w_season, w_mid, w_form, k, season_window). win=30 mirrors the live fetch (no
# change needed); win=60 tests whether a LONGER history fetch is worth it.
VARIANTS = {
    "60/25/15 k5 w30": (0.6, 0.25, 0.15, 5, 30),
    "60/25/15 k5 w60": (0.6, 0.25, 0.15, 5, 60),
    "70/20/10 k5 w60": (0.7, 0.20, 0.10, 5, 60),
    "55/30/15 k6 w30": (0.55, 0.30, 0.15, 6, 30),
}

print(f"{'prop':24s} {'n':>6s} {'current':>9s} | " +
      " | ".join(f"{name.split()[0]:>8s}" for name in VARIANTS))
for prop, (col, prior, ptype) in PROPS.items():
    rows = load(col, ptype)
    byp = defaultdict(list)
    for x in rows:
        byp[x["player_id"]].append(x)
    cur_sq, var_sq = [], {k: [] for k in VARIANTS}
    for pid, gs in byp.items():
        gs.sort(key=lambda r: r["game_date"])
        vals = [float(g[col]) for g in gs]
        for i in range(3, len(gs)):                       # need a few prior games
            prior_nf = vals[i - 1::-1]                     # all prior, newest first
            actual = vals[i]
            cur = current_baseline(prior_nf, prior)
            cur_sq.append((actual - cur) ** 2)
            for name, (ws, wm, wf, k, sw) in VARIANTS.items():
                s = stabilized(prior_nf, prior, ws, wm, wf, k, sw)
                var_sq[name].append((actual - s) ** 2)
    if not cur_sq:
        continue
    rmse_cur = st.mean(cur_sq) ** 0.5
    cells = []
    for name in VARIANTS:
        r = st.mean(var_sq[name]) ** 0.5
        delta = rmse_cur - r
        mark = "+" if delta > 0.0005 else ("-" if delta < -0.0005 else "=")
        cells.append(f"{r:.3f}{mark}")
    print(f"{prop:24s} {len(cur_sq):6d} {rmse_cur:9.3f} | " + " | ".join(f"{c:>8s}" for c in cells))
print("\n(+ = stabilized blend BEATS current recency-heavy baseline on RMSE; lower is better)")
