"""Decisive OFFLINE backtest of the matchup-K model (engine/matchup_k.py).

Does the lineup-matchup K projection beat the recency baseline at predicting a
pitcher's actual game strikeouts? Train batter/pitcher skill profiles on earlier
games, test on later ones (no leakage), comparing by RMSE/MAE against actual K.

Read-only. Run: python validate_matchup_backtest.py
"""
import model as m
import matchup_k as mk
from constants import et_today
import statistics as st
from collections import defaultdict

df = m._fetch_bulk_statcast(et_today())
df = df[df["pitch_type"].notna() & df["description"].notna()].copy()
df["gd"] = df["game_date"].astype(str)
# PA-ending rows (events not null) carry the outcome; K when events == strikeout*
df["is_pa_end"] = df["events"].notna() & (df["events"].astype(str) != "")
df["is_k"] = df["events"].astype(str).isin(["strikeout", "strikeout_double_play"])
CSW = {"called_strike", "swinging_strike", "swinging_strike_blocked"}
df["is_csw"] = df["description"].isin(CSW)

dates = sorted(df["gd"].unique())
split = dates[int(len(dates) * 0.65)]
train = df[df["gd"] < split]
test = df[df["gd"] >= split]
print(f"pitches train={len(train)} test={len(test)}  split {split}")

# ── train: batter K%/PA (raw; matchup_k regresses it), pitcher K%/PA + CSW + IP/start
bat_k, bat_pa, bat_hand = defaultdict(float), defaultdict(float), {}
for bid, sub in train.groupby("batter"):
    pae = sub[sub["is_pa_end"]]
    bat_pa[bid] = len(pae)
    bat_k[bid] = int(pae["is_k"].sum())
    hands = sub["stand"].dropna()
    if len(hands):
        bat_hand[bid] = hands.mode().iloc[0]

pit = {}
for pid, sub in train.groupby("pitcher"):
    pae = sub[sub["is_pa_end"]]
    if len(pae) < 40:
        continue
    games = sub["gd"].nunique()
    k_total = int(pae["is_k"].sum())
    pit[pid] = {
        "k_per_pa": k_total / max(len(pae), 1),
        "csw": sub["is_csw"].mean(),
        "k_per_start": k_total / max(games, 1),        # recency baseline
        "ip_per_start": (len(pae) / max(games, 1)) / 4.3,
        "hand": (sub["p_throws"].dropna().mode().iloc[0]
                 if len(sub["p_throws"].dropna()) else None),
    }

# ── test: per pitcher-game, recency vs matchup_k vs actual K
rec_sq, mk_sq, rec_ae, mk_ae = [], [], [], []
n_div, mk_wins = 0, 0
for (pid, gd), g in test.groupby(["pitcher", "gd"]):
    if pid not in pit:
        continue
    pae = g[g["is_pa_end"]]
    actual_k = int(pae["is_k"].sum())
    if len(pae) < 12:
        continue
    p = pit[pid]
    # build the lineup actually faced, in first-appearance (batting) order
    seen, lineup = [], []
    gg = g.sort_values("at_bat_number") if "at_bat_number" in g.columns else g
    for bid in gg["batter"]:
        if bid not in seen:
            seen.append(bid)
    for i, bid in enumerate(seen[:9]):
        lineup.append({
            "slot": i + 1,
            "strikeouts": bat_k.get(bid, 0.0),
            "plate_appearances": bat_pa.get(bid, 0.0),
            "bats": bat_hand.get(bid),
        })
    if len(lineup) < 9:
        continue
    mk_proj = mk.compute_matchup_expected_k(
        pitcher_csw_pct=p["csw"], recent_k_per_pa=p["k_per_pa"],
        pitcher_hand=p["hand"], expected_ip=p["ip_per_start"], lineup=lineup,
    )
    if mk_proj is None:
        continue
    rec_proj = p["k_per_start"]                          # flat recency talent
    rec_sq.append((actual_k - rec_proj) ** 2); rec_ae.append(abs(actual_k - rec_proj))
    mk_sq.append((actual_k - mk_proj) ** 2);  mk_ae.append(abs(actual_k - mk_proj))
    if abs(mk_proj - rec_proj) >= 0.75:                  # they meaningfully diverge
        n_div += 1
        if abs(actual_k - mk_proj) < abs(actual_k - rec_proj):
            mk_wins += 1

n = len(rec_sq)
print(f"\ntest pitcher-games: {n}")
print(f"  recency baseline : RMSE {st.mean(rec_sq)**.5:.3f}  MAE {st.mean(rec_ae):.3f}")
print(f"  matchup-K model  : RMSE {st.mean(mk_sq)**.5:.3f}  MAE {st.mean(mk_ae):.3f}")
better = st.mean(rec_sq)**.5 - st.mean(mk_sq)**.5
print(f"  -> matchup-K is {'BETTER' if better>0 else 'WORSE'} by {abs(better):.3f} RMSE")
print(f"  on {n_div} divergences (>=0.75 K apart): matchup-K won {mk_wins}/{n_div} "
      f"({round(100*mk_wins/max(n_div,1))}%)")
