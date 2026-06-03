"""Daily LOG-ONLY scorecard for the SHADOW matchup-expected-K signal.

ZERO projection impact. This module only READS — projections.matchup_expected_k
(the shadow column), player_game_logs.actual_strikeouts, and the strikeouts book
line — and prints to stdout whether matchup-K has earned a flip to primary. The
live strikeouts projection is NEVER touched here, and nothing here EVER flips the
model: a "FLIP-READY? YES" line is a prompt for a human to make the change, not
an automatic switch.

Called once/day from main() on the full (non-refresh) run, wrapped in try/except
so it can never affect the pipeline. The verbose manual deep-dive (per-bucket
reliability table) still lives in _validate_matchup_k.py.

Flip gate (pre-committed, see constants):
  - >= MATCHUP_K_FLIP_MIN_DIVERGENCES starts where matchup-K and the baseline
    leaned OPPOSITE the line, AND
  - matchup-K's side won >= MATCHUP_K_FLIP_MIN_WINRATE of those divergences, AND
  - matchup-K's line-region Brier score is <= the baseline's (calibration at
    least as good).
"""

from __future__ import annotations

from scipy.stats import norm

import db
from constants import (
    MATCHUP_K_FLIP_MIN_DIVERGENCES,
    MATCHUP_K_FLIP_MIN_WINRATE,
    MIN_STD,
    PROP_CV,
)

# Same single-book preference the rest of the betting layer uses, so the line we
# grade against is consistent with edge.py / results.
_BOOK_PREF = ["draftkings", "fanduel", "pinnacle", "prizepicks", "underdog", "betr", "sleeper"]


def _p_over(pred: float, line: float) -> float:
    """P(actual > line) under the same normal approximation edge.py uses."""
    std = max(pred * PROP_CV, MIN_STD)
    return float(1.0 - norm.cdf(line - 0.5, loc=pred, scale=std))


def _paginate(table: str, select: str, filters) -> list[dict]:
    """Range-paginated read so we walk past Supabase's 1000-row cap."""
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


def _lean(pred: float, line: float) -> str:
    if abs(pred - line) < 0.1:
        return "even"
    return "over" if pred > line else "under"


def gather_rows() -> list[dict]:
    """Join shadow matchup-K + baseline projection + book line + actual K for
    every graded start that carries a matchup_expected_k. Read-only."""
    proj = _paginate(
        "projections",
        "game_id, player_id, projection, projection_date, matchup_expected_k",
        [lambda q: q.eq("prop_type", "strikeouts")],
    )
    graded = [p for p in proj if p.get("matchup_expected_k") is not None]
    if not graded:
        return []

    logs = _paginate(
        "player_game_logs",
        "player_id, game_id, actual_strikeouts",
        [lambda q: q.not_.is_("actual_strikeouts", "null")],
    )
    actual = {
        (int(r["player_id"]), int(r["game_id"])): float(r["actual_strikeouts"])
        for r in logs
    }

    line_rows = _paginate(
        "lines",
        "player_id, bookmaker, line, game_date",
        [lambda q: q.eq("prop_type", "strikeouts")],
    )
    rank = {b: i for i, b in enumerate(_BOOK_PREF)}
    line_by: dict = {}
    for r in line_rows:
        k = (int(r["player_id"]), r["game_date"])
        cur = line_by.get(k)
        if cur is None or rank.get(r["bookmaker"], 99) < rank.get(cur["bookmaker"], 99):
            line_by[k] = r

    rows: list[dict] = []
    for p in graded:
        a = actual.get((int(p["player_id"]), int(p["game_id"])))
        ln = line_by.get((int(p["player_id"]), p["projection_date"]))
        if a is None or ln is None or p.get("projection") is None:
            continue
        rows.append(
            {
                "matchup": float(p["matchup_expected_k"]),
                "base": float(p["projection"]),
                "line": float(ln["line"]),
                "actual": a,
            }
        )
    return rows


def compute(rows: list[dict]) -> dict:
    """Line-region Brier score per predictor + realized edge on the starts where
    matchup-K and the baseline leaned OPPOSITE the line."""
    n = len(rows)
    brier_m = brier_b = 0.0
    divergences = won_m = won_b = 0
    for r in rows:
        over = 1.0 if r["actual"] > r["line"] else 0.0
        brier_m += (_p_over(r["matchup"], r["line"]) - over) ** 2
        brier_b += (_p_over(r["base"], r["line"]) - over) ** 2
        lm, lb = _lean(r["matchup"], r["line"]), _lean(r["base"], r["line"])
        if lm == "even" or lb == "even" or lm == lb:
            continue
        divergences += 1
        actual_over = r["actual"] > r["line"]
        won_m += 1 if (lm == "over") == actual_over else 0
        won_b += 1 if (lb == "over") == actual_over else 0
    return {
        "n": n,
        "brier_matchup": (brier_m / n) if n else None,
        "brier_base": (brier_b / n) if n else None,
        "divergences": divergences,
        "won_matchup": won_m,
        "won_base": won_b,
        "winrate_matchup": (won_m / divergences) if divergences else None,
    }


def flip_ready(sc: dict) -> tuple[bool, str]:
    """Evaluate the pre-committed flip gate. Returns (ready, human-readable why)."""
    d = sc["divergences"]
    wr = sc["winrate_matchup"]
    bm, bb = sc["brier_matchup"], sc["brier_base"]
    if d < MATCHUP_K_FLIP_MIN_DIVERGENCES:
        return False, f"only {d}/{MATCHUP_K_FLIP_MIN_DIVERGENCES} divergence-starts so far"
    if wr is None or wr < MATCHUP_K_FLIP_MIN_WINRATE:
        shown = "n/a" if wr is None else f"{wr:.0%}"
        return False, f"win-rate {shown} < {MATCHUP_K_FLIP_MIN_WINRATE:.0%}"
    if bm is None or bb is None or bm > bb:
        return False, f"calibration not yet >= baseline (Brier {bm:.3f} vs {bb:.3f})"
    return True, "all gates passed"


def log_scorecard() -> None:
    """Print the compact, log-only scorecard. Swallows its own errors so it can
    never break the pipeline (callers should still wrap defensively)."""
    try:
        rows = gather_rows()
    except Exception as exc:
        print(f"  matchup-K scorecard: read failed ({exc}) -- skipping")
        return

    if not rows:
        print(
            "  matchup-K scorecard: no graded shadow starts yet "
            "(needs add_matchup_expected_k.sql applied + posted-lineup runs to grade)."
        )
        return

    sc = compute(rows)
    ready, why = flip_ready(sc)
    wr = sc["winrate_matchup"]
    wr_s = f"{wr:.0%}" if wr is not None else "n/a"

    print(
        f"  matchup-K scorecard (shadow, log-only): {sc['n']} graded starts, "
        f"{sc['divergences']} divergences vs the line"
    )
    print(
        f"    realized edge: matchup-K won {sc['won_matchup']}/{sc['divergences']} "
        f"({wr_s}) | baseline {sc['won_base']}/{sc['divergences']}"
    )
    if sc["brier_matchup"] is not None:
        print(
            f"    Brier (lower=better): matchup-K {sc['brier_matchup']:.3f} | "
            f"baseline {sc['brier_base']:.3f}"
        )
    print(f"    FLIP-READY? {'YES' if ready else 'no'} -- {why}")
    if ready:
        print(
            "    >>> matchup-K has earned the flip to primary (see CLAUDE.md). "
            "This is a prompt, NOT an auto-flip — make the code change deliberately."
        )


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    log_scorecard()
