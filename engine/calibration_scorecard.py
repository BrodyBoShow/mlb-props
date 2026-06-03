"""Daily LOG-ONLY calibration scorecard.

Calibration asks the one question that makes every EDGE trustworthy: when the
model says "62% over", does the over actually happen ~62% of the time? Right now
`edges.model_over_prob` is a PARAMETRIC estimate (Poisson around the projection
for count props, a normal approximation for fantasy) — it has never been checked
against realized outcomes. This scorecard checks it.

ZERO projection/edge impact, READ-ONLY. Run once/day on the full pipeline run,
next to the CLV + matchup-K scorecards. It is a MEASUREMENT, not a correction —
the prerequisite for any calibration map. "You can't calibrate what you can't
measure": this prints, per prop, the Brier score + a reliability table + the
calibration-in-the-large gap so you can see exactly which props are miscalibrated
and in which direction.

Method, per prop:
  * One (predicted P(over), realized over) pair per (player, prop, day) — we
    pick the SHARPEST book present (Pinnacle first; `consensus` last) so a single
    game with many books isn't counted many times.
  * predicted = edges.model_over_prob ; line = edges.line.
  * realized  = the graded actual (player_game_logs, via calibrate._ACTUAL_COL)
    joined on (player_id, game_date). over = actual > line. Pushes (actual ==
    line) are dropped (no over/under outcome).
  * Brier = mean((pred - over)^2). Reference = always predicting the prop's
    empirical over-rate p̄, whose Brier is p̄(1-p̄). Model Brier < reference =>
    the probabilities add information beyond the base rate.
  * Calibration-in-the-large = mean(pred) - mean(over). Positive => the model
    systematically predicts the over too often (over-biased), and vice versa.
  * Reliability table: predicted-probability buckets vs realized over-rate —
    where the curve sits above/below the diagonal shows the miscalibration shape.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

import db
from calibrate import _ACTUAL_COL
from constants import et_today

# Sharpest first (most informative line); `consensus` is the synthetic one-sided
# de-vig baseline, used only when no real book posted a two-sided line.
_BOOK_PREF = [
    "pinnacle", "draftkings", "fanduel", "bet365", "caesars", "betmgm",
    "espnbet", "pointsbet", "underdog", "betr", "sleeper", "prizepicks",
    "consensus",
]
# Only look back this far so the read stays bounded as the season grows. Early
# season this covers everything.
_LOOKBACK_DAYS = 180
# Reliability bucket edges over predicted P(over). Coarse on purpose — thin early
# data can't support deciles without every bucket being noise.
_BUCKETS = [(0.0, 0.35), (0.35, 0.5), (0.5, 0.65), (0.65, 1.01)]
# Below this many graded pairs a prop's numbers are too noisy to read.
_MIN_PAIRS = 12
# Calibration-in-the-large gap beyond which we call a prop systematically biased.
_BIAS_GAP = 0.05


def _paginate(table: str, select: str, filters) -> list[dict]:
    c = db._client()
    out: list[dict] = []
    frm = 0
    while True:
        q = c.table(table).select(select)
        for f in filters:
            q = f(q)
        batch = q.range(frm, frm + 999).execute().data or []
        out += batch
        if len(batch) < 1000:
            break
        frm += 1000
    return out


def gather() -> dict[str, list[tuple[float, int]]]:
    """Join model_over_prob (edges) to the realized over/under (player_game_logs),
    one sharpest-book pair per (player, prop, day). Returns {prop: [(pred, over)]}.
    Read-only; returns {} gracefully on any read problem."""
    cutoff = (et_today() - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d")

    edges = _paginate(
        "edges",
        "player_id, prop_type, game_date, line, model_over_prob, bookmaker",
        [lambda q: q.gte("game_date", cutoff)],
    )
    if not edges:
        return {}

    # Logs carry one row per (player, game_date) with all actual_* columns.
    actual_cols = sorted(set(_ACTUAL_COL.values()))
    logs = _paginate(
        "player_game_logs",
        "player_id, game_date, " + ", ".join(actual_cols),
        [lambda q: q.gte("game_date", cutoff)],
    )
    log_by: dict[tuple, dict] = {}
    for lg in logs:
        log_by[(lg["player_id"], lg["game_date"])] = lg

    # One edge per (player, prop, day): sharpest book wins.
    rank = {b: i for i, b in enumerate(_BOOK_PREF)}
    best: dict[tuple, tuple[int, dict]] = {}
    for e in edges:
        if e.get("model_over_prob") is None or e.get("line") is None:
            continue
        key = (e["player_id"], e["prop_type"], e["game_date"])
        r = rank.get(e.get("bookmaker"), 99)
        if key not in best or r < best[key][0]:
            best[key] = (r, e)

    pairs: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for (_pid, prop, _date), (_r, e) in best.items():
        col = _ACTUAL_COL.get(prop)
        if col is None:
            continue
        lg = log_by.get((e["player_id"], e["game_date"]))
        if not lg:
            continue
        actual = lg.get(col)
        if actual is None:
            continue
        line = float(e["line"])
        actual = float(actual)
        if actual == line:
            continue  # push — no over/under outcome
        over = 1 if actual > line else 0
        pairs[prop].append((float(e["model_over_prob"]), over))
    return pairs


def compute(pairs: list[tuple[float, int]]) -> dict:
    """Per-prop calibration stats from a list of (predicted_prob, over) pairs."""
    n = len(pairs)
    if n == 0:
        return {"n": 0}
    mean_pred = sum(p for p, _ in pairs) / n
    mean_act = sum(o for _, o in pairs) / n
    brier = sum((p - o) ** 2 for p, o in pairs) / n
    base_brier = mean_act * (1.0 - mean_act)  # Brier of always predicting p̄

    buckets = []
    for lo, hi in _BUCKETS:
        sel = [(p, o) for p, o in pairs if lo <= p < hi]
        if sel:
            bn = len(sel)
            buckets.append(
                {
                    "lo": lo,
                    "hi": hi,
                    "n": bn,
                    "pred": sum(p for p, _ in sel) / bn,
                    "act": sum(o for _, o in sel) / bn,
                }
            )
    return {
        "n": n,
        "mean_pred": mean_pred,
        "mean_act": mean_act,
        "brier": brier,
        "base_brier": base_brier,
        "gap": mean_pred - mean_act,
        "buckets": buckets,
    }


def _verdict(s: dict) -> str:
    if s["n"] < _MIN_PAIRS:
        return f"thin sample (n={s['n']}, need >= {_MIN_PAIRS}) — read as provisional"
    gap = s["gap"]
    informative = s["brier"] < s["base_brier"]
    if gap > _BIAS_GAP:
        return (
            f"OVER-biased: predicts the over {gap:+.2f} too often -- center the "
            f"projection down / regress (calibration can't fix a biased projection)"
        )
    if gap < -_BIAS_GAP:
        return f"UNDER-biased: predicts the over {gap:+.2f} too little -- center up"
    return (
        "well-calibrated"
        + ("" if informative else " (but Brier ~= base rate — little edge signal)")
    )


def log_scorecard() -> None:
    """Print the compact, log-only calibration readout. Never raises into the run."""
    try:
        pairs = gather()
    except Exception as exc:
        print(f"  calibration scorecard: failed ({exc}) -- skipping")
        return

    if not pairs:
        print(
            "  calibration scorecard: no graded (model_over_prob, outcome) pairs "
            "yet — needs edges + graded player_game_logs to accumulate."
        )
        return

    # Pooled, then per-prop (most graded first).
    everything = [pr for lst in pairs.values() for pr in lst]
    pooled = compute(everything)
    print(
        f"  calibration scorecard (log-only): {pooled['n']} graded prob/outcome "
        f"pairs across {len(pairs)} props"
    )
    print(
        f"    POOLED  Brier {pooled['brier']:.3f} (base {pooled['base_brier']:.3f}) | "
        f"pred {pooled['mean_pred']:.2f} / actual {pooled['mean_act']:.2f} "
        f"(gap {pooled['gap']:+.2f})"
    )

    for prop in sorted(pairs, key=lambda k: -len(pairs[k])):
        s = compute(pairs[prop])
        rel = " | ".join(
            f"[{b['lo']:.2f}-{b['hi']:.2f}] n={b['n']} pred {b['pred']:.2f} act {b['act']:.2f}"
            for b in s["buckets"]
        )
        print(
            f"    {prop:<22} n={s['n']:<4} Brier {s['brier']:.3f} "
            f"(base {s['base_brier']:.3f}) | pred {s['mean_pred']:.2f} / "
            f"act {s['mean_act']:.2f} -> {_verdict(s)}"
        )
        if s["buckets"]:
            print(f"        reliability: {rel}")


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    log_scorecard()
