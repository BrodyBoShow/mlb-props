"""Backtest — does regression-to-mean beat the raw weighted rolling mean for
hitter projections? READ-ONLY (no model/DB change). Measures RMSE/MAE on every
graded hitter game using STRICT-PRIOR history, replicating the production
baseline (30-day window + RECENT_WEIGHT weighting), and compares:

  raw       = the current weighted rolling mean (no regression)
  reg(k)    = blend the weighted mean with the LEAGUE prior, weight k
  regp(k)   = blend with the PLAYER's longer-term mean (all prior games),
              falling back to the league prior when there's no prior history

A Marcel-style regression adds `k` pseudo-games at the prior:
    projection = (weighted_mean * sum_weights + k * prior) / (sum_weights + k)
Thin samples (small sum_weights) get pulled hard toward the prior; deep samples
barely move. Lower RMSE/MAE => the regression predicts better. Reported overall
AND split by prior-sample size, since the whole point is fixing thin samples.

Run: python engine/validate_regression.py
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import numpy as np
from dotenv import load_dotenv

load_dotenv()

import db
from constants import LOOKBACK_DAYS, OLDER_WEIGHT, RECENT_STARTS, RECENT_WEIGHT

PROPS = [
    "actual_total_bases", "actual_hits", "actual_hits_runs_rbis",
    "actual_runs", "actual_rbis", "actual_home_runs",
]
KS = [2, 3, 5]


def _weighted(vals_newest_first: list[float]) -> tuple[float, float]:
    """(weighted_mean, sum_weights) — the production weighting."""
    w = [RECENT_WEIGHT if i < RECENT_STARTS else OLDER_WEIGHT for i in range(len(vals_newest_first))]
    sw = sum(w)
    return sum(a * b for a, b in zip(w, vals_newest_first)) / sw, sw


def _rmse(e):
    return float(np.sqrt(np.mean(np.square(e)))) if e else float("nan")


def _mae(e):
    return float(np.mean(np.abs(e))) if e else float("nan")


def run(prop_col: str, rows: list[dict]) -> None:
    hit = [
        r for r in rows
        if r.get("player_type") == "hitter"
        and r.get(prop_col) is not None
        and r.get("game_date")
    ]
    if len(hit) < 500:
        print(f"\n{prop_col}: only {len(hit)} graded games — skipping")
        return
    league = float(np.mean([r[prop_col] for r in hit]))

    byp: dict = defaultdict(list)
    for r in hit:
        byp[r["player_id"]].append(r)
    for pid in byp:
        byp[pid].sort(key=lambda r: r["game_date"])

    # error accumulators
    err = {"raw": []} | {f"reg{k}": [] for k in KS} | {f"regp{k}": [] for k in KS}
    bucket_err: dict = defaultdict(lambda: defaultdict(list))

    for games in byp.values():
        prior_dates = [date.fromisoformat(g["game_date"]) for g in games]
        for i, g in enumerate(games):
            gd = prior_dates[i]
            lo = gd - timedelta(days=LOOKBACK_DAYS)
            # strict-prior 30-day window, newest first
            window = [games[j][prop_col] for j in range(i) if lo <= prior_dates[j] < gd]
            window = window[::-1]
            if not window:
                continue
            wm, sw = _weighted(window)
            actual = g[prop_col]
            n = len(window)
            bk = "1-3" if n <= 3 else ("4-10" if n <= 10 else "11+")

            err["raw"].append(wm - actual)
            bucket_err[bk]["raw"].append(wm - actual)

            all_prior = [games[j][prop_col] for j in range(i)]
            pprior = float(np.mean(all_prior)) if all_prior else league
            for k in KS:
                reg = (wm * sw + k * league) / (sw + k)
                regp = (wm * sw + k * pprior) / (sw + k)
                err[f"reg{k}"].append(reg - actual)
                err[f"regp{k}"].append(regp - actual)
                bucket_err[bk][f"reg{k}"].append(reg - actual)
                bucket_err[bk][f"regp{k}"].append(regp - actual)

    print(f"\n=== {prop_col}  (league prior {league:.3f}, {len(err['raw'])} evaluable games) ===")
    print(f"  {'method':<10} {'RMSE':>7} {'MAE':>7}")
    print(f"  {'raw':<10} {_rmse(err['raw']):>7.3f} {_mae(err['raw']):>7.3f}")
    best = ("raw", _rmse(err["raw"]))
    for k in KS:
        for pre in ("reg", "regp"):
            key = f"{pre}{k}"
            r = _rmse(err[key])
            if r < best[1]:
                best = (key, r)
            print(f"  {key:<10} {r:>7.3f} {_mae(err[key]):>7.3f}")
    print(f"  -> best: {best[0]} (RMSE {best[1]:.3f} vs raw {_rmse(err['raw']):.3f})")

    # thin-sample focus
    print("  by prior-sample size (RMSE):")
    for bk in ("1-3", "4-10", "11+"):
        be = bucket_err[bk]
        if not be.get("raw"):
            continue
        line = f"    n={bk:<5} raw {_rmse(be['raw']):.3f}"
        for k in KS:
            line += f" | reg{k} {_rmse(be[f'reg{k}']):.3f} regp{k} {_rmse(be[f'regp{k}']):.3f}"
        print(f"    n={bk:<5} games {len(be['raw']):<5} raw {_rmse(be['raw']):.3f}"
              f"  reg2 {_rmse(be['reg2']):.3f} reg3 {_rmse(be['reg3']):.3f}"
              f"  regp2 {_rmse(be['regp2']):.3f} regp3 {_rmse(be['regp3']):.3f}")


def main() -> None:
    rows = db.get_game_logs()
    if not rows:
        print("no game logs")
        return
    print(f"loaded {len(rows)} game logs")
    for prop in PROPS:
        run(prop, rows)


if __name__ == "__main__":
    main()
