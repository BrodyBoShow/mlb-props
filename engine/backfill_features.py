"""Stage 2b — populate REAL context features on backfilled PITCHER rows.

The Stage-2 flip trains the strikeout model on the backfilled season, but those
rows carried IMPUTED league-default context features (whiff/CSW = 0.22/0.27,
opp_k_rate = 0.22, etc.). This replay computes the REAL features as-of each
historical start (STRICT-PRIOR: the 30 days BEFORE the start, never the start
itself) and UPDATEs the backfilled rows — so the model learns from real
swing-and-miss signal, the highest-K-predictive features.

Efficient: ONE statcast_pitcher() full-season call per distinct backfill pitcher
(~30-40 calls), then each start's 30-day-prior window is computed in memory.
opp_k_rate / park_factor_k / days_rest come from cheap lookups (no extra
Statcast). lineup_lhh_pct stays imputed (per-game boxscore fetch is the expensive
part and it's a weak feature).

SAFE: only UPDATEs backfilled=true rows (graded rows untouched). The whiff/CSW/
k_vs_lhh math is copied verbatim from grade._pitcher_platoon_30d. Re-validate
with engine/validate_backfill.py after. Run: python engine/backfill_features.py
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import pandas as pd
import pybaseball
from dotenv import load_dotenv

load_dotenv()

import db
import stats
from constants import et_today, get_park_factor_k

_FASTBALL = {"FF", "SI", "FC"}


def _window_features(sc: pd.DataFrame, start: date) -> dict:
    """grade._pitcher_platoon_30d math over the 30-day-prior (strict) window."""
    lo = pd.Timestamp(start - timedelta(days=30))
    hi = pd.Timestamp(start - timedelta(days=1))
    w = sc[(sc["_gd"] >= lo) & (sc["_gd"] <= hi)]
    if w.empty:
        return {}

    def k_rate(side: pd.DataFrame):
        if len(side) < 20:
            return None
        ks = side["events"].isin(["strikeout", "strikeout_double_play"]).sum()
        pas = side["events"].notna().sum()
        return round(float(ks / pas), 3) if pas > 0 else None

    desc = w["description"]
    whiffs = desc.isin(["swinging_strike", "swinging_strike_blocked"]).sum()
    swings = desc.isin(
        ["swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play"]
    ).sum()
    called = desc.isin(["called_strike"]).sum()
    fb = w[w["pitch_type"].isin(_FASTBALL)]

    out: dict = {}
    if swings > 0:
        out["pitcher_whiff_pct_30d"] = round(float(whiffs / swings), 3)
    if len(w) > 0:
        out["pitcher_csw_pct_30d"] = round(float((called + whiffs) / len(w)), 3)
    kl, kr = k_rate(w[w["stand"] == "L"]), k_rate(w[w["stand"] == "R"])
    if kl is not None:
        out["pitcher_k_vs_lhh"] = kl
    if kr is not None:
        out["pitcher_k_vs_rhh"] = kr
    if len(fb) > 0 and fb["release_speed"].notna().any():
        out["pitcher_avg_velo"] = round(float(fb["release_speed"].mean()), 1)
    return out


def main() -> None:
    ref = et_today()
    season_start, today = f"{ref.year}-03-01", ref.isoformat()
    c = db._client()

    # backfill PITCHER rows + the game's teams (for opp_k_rate / park_factor)
    rows: list[dict] = []
    frm = 0
    while True:
        b = (
            c.table("player_game_logs")
            .select("id,player_id,game_id,game_date,home_away")
            .eq("backfilled", True).eq("player_type", "pitcher")
            .range(frm, frm + 999).execute().data or []
        )
        rows += b
        if len(b) < 1000:
            break
        frm += 1000

    gids = list({r["game_id"] for r in rows if r.get("game_id")})
    games: dict = {}
    for i in range(0, len(gids), 300):
        gb = c.table("games").select("game_id,home_team,away_team").in_("game_id", gids[i:i + 300]).execute().data or []
        for g in gb:
            games[g["game_id"]] = (g["home_team"], g["away_team"])

    byp: dict = defaultdict(list)
    for r in rows:
        byp[r["player_id"]].append(r)
    print(f"backfill pitcher rows: {len(rows)} across {len(byp)} pitchers")

    updated = 0
    for pi, (pid, prows) in enumerate(byp.items(), 1):
        try:
            sc = pybaseball.statcast_pitcher(season_start, today, pid)
        except Exception as exc:
            print(f"  statcast failed pid {pid}: {exc}")
            continue
        if sc is None or sc.empty:
            continue
        sc = sc.copy()
        sc["_gd"] = pd.to_datetime(sc["game_date"], errors="coerce")

        # days_rest from this pitcher's own start sequence (strict-prior gap)
        dates = sorted(set(r["game_date"] for r in prows))
        rest = {d: ((date.fromisoformat(d) - date.fromisoformat(dates[j - 1])).days if j else None)
                for j, d in enumerate(dates)}

        for r in prows:
            start = date.fromisoformat(r["game_date"])
            upd = _window_features(sc, start)
            g = games.get(r["game_id"])
            if g:
                home_team, away_team = g
                opp = away_team if r["home_away"] == "home" else home_team
                try:
                    upd["opp_k_rate"] = stats._opp_k_rate(opp, start.year)
                except Exception:
                    pass
                try:
                    upd["park_factor_k"] = get_park_factor_k(home_team)
                except Exception:
                    pass
            dr = rest.get(r["game_date"])
            if dr is not None:
                upd["days_rest"] = min(dr, 10)
            upd = {k: v for k, v in upd.items() if v is not None}
            if not upd:
                continue
            try:
                c.table("player_game_logs").update(upd).eq("id", r["id"]).execute()
                updated += 1
            except Exception:
                pass
        if pi % 10 == 0:
            print(f"  {pi}/{len(byp)} pitchers ...")

    print(f"Done. updated {updated} backfill pitcher rows with real context features.")


if __name__ == "__main__":
    main()
