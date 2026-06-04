"""SHADOW validation for matchup-expected-K. Standalone diagnostic — NOT run in
the pipeline. Run manually: `python engine/_validate_matchup_k.py`.

Joins projections.matchup_expected_k to player_game_logs.actual_strikeouts on
(player_id, game_id) for graded starts, plus the strikeouts book line, and
reports for BOTH matchup-K and the CURRENT baseline projection:

  (a) CALIBRATION IN THE LINE REGION — bucket each prediction's implied P(over)
      (normal approx, same as edge.py) and compare to the empirical over rate.
      Near the book line is what matters for a prop bet, NOT raw MAE on the K
      count. A well-calibrated baseline's predicted P(over) ≈ actual over rate.

  (b) REALIZED EDGE — on starts where matchup-K's lean (over/under vs the line)
      DISAGREED with the baseline's lean, did matchup-K's side win? That's the
      only thing that matters: edges live in the divergences, not in matching
      the line.

⚠ ~60 graded starts is a SANITY CHECK, not enough to TUNE the priors (notably
matchup_k.K_PCT_REGRESSION_PA). Treat directionally until far more accumulate.
"""

from collections import defaultdict

from scipy.stats import norm

import db
from constants import MIN_STD, PROP_CV

_BOOK_PREF = ["draftkings", "fanduel", "pinnacle", "prizepicks", "underdog", "betr", "sleeper"]


def _p_over(pred: float, line: float) -> float:
    """P(actual > line) under the same normal approx edge.py uses."""
    std = max(pred * PROP_CV, MIN_STD)
    return float(1.0 - norm.cdf(line - 0.5, loc=pred, scale=std))


def _paginate(table: str, select: str, filters):
    c = db._client()
    out, frm = [], 0
    while True:
        q = c.table(table).select(select)
        for f in filters:
            q = f(q)
        resp = q.range(frm, frm + 999).execute()
        out += resp.data or []
        if len(resp.data or []) < 1000:
            break
        frm += 1000
    return out


def main() -> None:
    # 1) strikeouts projections carrying the shadow matchup_expected_k
    try:
        proj = _paginate(
            "projections",
            "game_id, player_id, projection, projection_date, matchup_expected_k",
            [lambda q: q.eq("prop_type", "strikeouts")],
        )
    except Exception as exc:
        print(f"matchup-K validation: projections read failed ({exc}).")
        print("  -> apply db/migrations/add_matchup_expected_k.sql, then let the")
        print("     shadow step populate + grade a few slates before re-running.")
        return

    graded = [p for p in proj if p.get("matchup_expected_k") is not None]
    if not graded:
        print("matchup-K validation: 0 starts have a shadow matchup_expected_k yet.")
        print("  Expected pre-data — the column populates only after the migration")
        print("  AND on runs where the opposing lineup is posted; results appear")
        print("  once those starts grade. Nothing to validate.")
        return

    # 2) actuals + lines
    logs = _paginate(
        "player_game_logs", "player_id, game_id, actual_strikeouts",
        [lambda q: q.not_.is_("actual_strikeouts", "null")],
    )
    actual = {(int(l["player_id"]), int(l["game_id"])): float(l["actual_strikeouts"]) for l in logs}
    line_rows = _paginate(
        "lines", "player_id, bookmaker, line, game_date",
        [lambda q: q.eq("prop_type", "strikeouts")],
    )
    line_by = {}
    rank = {b: i for i, b in enumerate(_BOOK_PREF)}
    for l in line_rows:
        k = (int(l["player_id"]), l["game_date"])
        cur = line_by.get(k)
        if cur is None or rank.get(l["bookmaker"], 99) < rank.get(cur["bookmaker"], 99):
            line_by[k] = l

    # 3) assemble graded rows: matchup-K, baseline, line, actual
    rows = []
    for p in graded:
        key = (int(p["player_id"]), int(p["game_id"]))
        a = actual.get(key)
        ln = line_by.get((int(p["player_id"]), p["projection_date"]))
        if a is None or ln is None or p.get("projection") is None:
            continue
        rows.append({
            "matchup": float(p["matchup_expected_k"]),
            "base": float(p["projection"]),
            "line": float(ln["line"]),
            "actual": a,
        })

    print(f"matchup-K validation: {len(rows)} graded starts with matchup-K + line + actual")
    if not rows:
        print("  not enough joined data yet.")
        return
    if len(rows) < 30:
        print("  ⚠ tiny sample — directional sanity check only, do NOT tune priors.")

    # (a) calibration in the line region
    def calibration(pred_key: str, label: str) -> None:
        buckets = defaultdict(lambda: [0, 0])  # bucket -> [n, overs]
        for r in rows:
            po = _p_over(r[pred_key], r["line"])
            b = min(4, int(po * 5))  # 5 buckets: 0-.2,.2-.4,...
            buckets[b][0] += 1
            buckets[b][1] += 1 if r["actual"] > r["line"] else 0
        print(f"  [{label}] reliability (predicted P(over) -> actual over rate):")
        for b in sorted(buckets):
            n, ov = buckets[b]
            lo, hi = b * 0.2, b * 0.2 + 0.2
            print(f"    P(over) {lo:.1f}-{hi:.1f}: n={n:3d}  actual over={ov/n:.2f}" if n else "")

    calibration("base", "baseline")
    calibration("matchup", "matchup-K")

    # (b) realized edge on divergences
    def lean(pred: float, line: float) -> str:
        if abs(pred - line) < 0.1:
            return "even"
        return "over" if pred > line else "under"

    disagree = won_m = won_b = 0
    for r in rows:
        lm, lb = lean(r["matchup"], r["line"]), lean(r["base"], r["line"])
        if lm == "even" or lb == "even" or lm == lb:
            continue
        disagree += 1
        actual_over = r["actual"] > r["line"]
        won_m += 1 if (lm == "over") == actual_over else 0
        won_b += 1 if (lb == "over") == actual_over else 0
    print(f"  realized edge on divergences: {disagree} starts where matchup-K and")
    print("    baseline leaned opposite the line.")
    if disagree:
        print(f"    matchup-K side won {won_m}/{disagree} ({won_m/disagree:.0%}); "
              f"baseline side won {won_b}/{disagree} ({won_b/disagree:.0%}).")
        print("    (>50% for matchup-K = it's adding signal where it diverges.)")


if __name__ == "__main__":
    main()
