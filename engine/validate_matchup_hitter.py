"""Decisive OFFLINE backtest of the hitter matchup model (engine/matchup_hitter.py).

Does the batter-vs-opposing-starter log5 projection beat the production
stabilized talent baseline (baseline._stabilized_projection) at predicting a
hitter's actual game total_bases / hits / home_runs? Train batter + pitcher
per-PA profiles on earlier games, test on later ones (NO leakage), comparing by
RMSE/MAE and divergence win-rate (when the two methods disagree, who lands
closer to the actual).

Mirrors engine/validate_matchup_backtest.py (the pitcher-K version). Read-only,
no DB, no projections touched. Run: python validate_matchup_hitter.py

NOTE: uses the 30-day bulk Statcast frame (model._fetch_bulk_statcast), so
per-batter samples are thin (~100 PA) and stabilization shrinks hard toward
league — this is a CONSERVATIVE read. A wider-window rerun is the obvious
follow-up if the signal is borderline. Park factor is held at 1.0 here (a small
second-order term; not the point of the comparison).
"""
import statistics as st
from collections import defaultdict

import model as m
import matchup_hitter as mh
import baseline as bl
from constants import HITTER_LEAGUE_PRIOR, et_today

_K = {"strikeout", "strikeout_double_play"}


def _bucket(ev: str) -> str:
    if ev in _K:
        return "K"
    if ev in ("walk", "intent_walk"):
        return "BB"
    if ev == "hit_by_pitch":
        return "HBP"
    if ev == "home_run":
        return "HR"
    if ev == "triple":
        return "3B"
    if ev == "double":
        return "2B"
    if ev == "single":
        return "1B"
    return "OUT"


df = m._fetch_bulk_statcast(et_today())
df = df[df["events"].notna()].copy()
df["events"] = df["events"].astype(str)
df = df[(df["events"] != "") & (df["events"] != "nan")].copy()
df["bk"] = df["events"].map(_bucket)
df["gd"] = df["game_date"].astype(str)
print(f"PA-ending rows: {len(df)}  games: {df['game_pk'].nunique()}")

dates = sorted(df["gd"].unique())
split = dates[int(len(dates) * 0.65)]
train = df[df["gd"] < split].copy()
test = df[df["gd"] >= split].copy()
print(f"train PAs={len(train)}  test PAs={len(test)}  split {split}")

# ── train: batter per-PA outcome counts + PA + per-game TB/H/HR series + hand
bat_counts: dict = defaultdict(lambda: defaultdict(float))
bat_pa: dict = defaultdict(float)
bat_hand: dict = {}
bat_game: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # bid->gd->bucket->n
for bid, sub in train.groupby("batter"):
    bat_pa[bid] = len(sub)
    for bk in sub["bk"]:
        bat_counts[bid][bk] += 1
    hands = sub["stand"].dropna()
    if len(hands):
        bat_hand[bid] = hands.mode().iloc[0]
    for gd, g2 in sub.groupby("gd"):
        for bk in g2["bk"]:
            bat_game[bid][gd][bk] += 1


def _game_val(buckets: dict, prop: str) -> float:
    if prop == "total_bases":
        return 1 * buckets.get("1B", 0) + 2 * buckets.get("2B", 0) + 3 * buckets.get("3B", 0) + 4 * buckets.get("HR", 0)
    if prop == "hits":
        return buckets.get("1B", 0) + buckets.get("2B", 0) + buckets.get("3B", 0) + buckets.get("HR", 0)
    return buckets.get("HR", 0)  # home_runs


def _series(bid: int, prop: str) -> list[float]:
    """Per-game prop values for a batter, newest game first (the stabilized
    baseline's input)."""
    games = bat_game.get(bid, {})
    return [_game_val(games[gd], prop) for gd in sorted(games, reverse=True)]


# ── train: pitcher (starter) allowed counts + PA + games + bf/start + hand
pit_counts: dict = defaultdict(lambda: defaultdict(float))
pit_pa: dict = defaultdict(float)
pit_meta: dict = {}
for pid, sub in train.groupby("pitcher"):
    if len(sub) < 40:
        continue
    for bk in sub["bk"]:
        pit_counts[pid][bk] += 1
    pit_pa[pid] = len(sub)
    hands = sub["p_throws"].dropna()
    pit_meta[pid] = {
        "bf_per_start": len(sub) / max(sub["gd"].nunique(), 1),
        "hand": hands.mode().iloc[0] if len(hands) else None,
    }

# ── test: opposing starter per (game, half) + lineup slot order per (game, half)
starter_by_half: dict = {}
slot_by_half: dict = {}
for (gpk, half), g in test.groupby(["game_pk", "inning_topbot"]):
    gg = g.sort_values("at_bat_number")
    starter_by_half[(gpk, half)] = gg["pitcher"].iloc[0]
    seen: list = []
    for bid in gg["batter"]:
        if bid not in seen:
            seen.append(bid)
    slot_by_half[(gpk, half)] = seen

# ── test loop: matchup vs stabilized baseline, per prop
PROPS = ["total_bases", "hits", "home_runs"]
THR = {"total_bases": 0.25, "hits": 0.15, "home_runs": 0.05}
acc = {p: {"mk_sq": [], "bl_sq": [], "mk_ae": [], "bl_ae": [], "ndiv": 0, "mkwin": 0} for p in PROPS}
n_games = 0

for (bid, gpk), g in test.groupby(["batter", "game_pk"]):
    if bid not in bat_pa or bat_pa[bid] < 30:
        continue
    half = g["inning_topbot"].mode().iloc[0]
    starter = starter_by_half.get((gpk, half))
    if starter is None or starter not in pit_meta:
        continue
    order = slot_by_half.get((gpk, half), [])
    if bid not in order:
        continue
    slot = min(order.index(bid) + 1, 9)

    actual = {p: _game_val({bk: int((g["bk"] == bk).sum()) for bk in ("1B", "2B", "3B", "HR")}, p) for p in PROPS}

    proj = mh.compute_matchup_hitter(
        batter_counts=dict(bat_counts[bid]),
        batter_pa=bat_pa[bid],
        starter_counts=dict(pit_counts[starter]),
        starter_pa=pit_pa[starter],
        batter_hand=bat_hand.get(bid),
        pitcher_hand=pit_meta[starter]["hand"],
        slot=slot,
        starter_bf=pit_meta[starter]["bf_per_start"],
        park_factor=1.0,
    )

    n_games += 1
    for p in PROPS:
        a = actual[p]
        mk = proj[p]
        bl_proj = bl._stabilized_projection(_series(bid, p), HITTER_LEAGUE_PRIOR.get(
            "hitter_" + p if p != "home_runs" else "hitter_home_runs", 0.0))
        acc[p]["mk_sq"].append((a - mk) ** 2)
        acc[p]["bl_sq"].append((a - bl_proj) ** 2)
        acc[p]["mk_ae"].append(abs(a - mk))
        acc[p]["bl_ae"].append(abs(a - bl_proj))
        if abs(mk - bl_proj) >= THR[p]:
            acc[p]["ndiv"] += 1
            if abs(a - mk) < abs(a - bl_proj):
                acc[p]["mkwin"] += 1

print(f"\ntest batter-games: {n_games}\n")
print(f"{'prop':<14}{'baseline RMSE':>15}{'matchup RMSE':>15}{'  winner':>10}"
      f"{'  diverge':>10}{'  mk-win%':>10}")
for p in PROPS:
    a = acc[p]
    if not a["mk_sq"]:
        print(f"{p:<14}  (no test games)")
        continue
    bl_rmse = st.mean(a["bl_sq"]) ** 0.5
    mk_rmse = st.mean(a["mk_sq"]) ** 0.5
    winner = "matchup" if mk_rmse < bl_rmse else "baseline"
    wr = round(100 * a["mkwin"] / max(a["ndiv"], 1))
    print(f"{p:<14}{bl_rmse:>15.4f}{mk_rmse:>15.4f}{winner:>10}"
          f"{a['ndiv']:>10}{wr:>9}%")
    print(f"{'':<14}{'baseline MAE '+format(st.mean(a['bl_ae']),'.4f'):>30}"
          f"{'  matchup MAE '+format(st.mean(a['mk_ae']),'.4f'):>28}")

print("\nNOTE: RMSE near-tied is EXPECTED (single-game variance ceiling). The "
      "decisive signals are the divergence win-rate (>=55% to promote) and, "
      "next, Brier-of-the-over on real lines via the daily shadow scorecard.")
