"""Daily LOG-ONLY scorecard for the SHADOW hitter matchup signal.

ZERO projection impact. READS ONLY — projections.matchup_projection (the shadow
column), the live baseline projection, player_game_logs actuals, and the book
line — and prints, PER PROP (total_bases / hits / home_runs), whether the
matchup model has earned a flip to primary. Nothing here ever flips: a
"FLIP-READY? YES" line is a prompt for a human, not an auto-switch.

Called once/day from main() on the full (non-refresh) run, wrapped in try/except
so it can never affect the pipeline. Mirrors matchup_k_scorecard.py, but uses the
Poisson over-probability (matching edge.py for count props) and grades each prop
independently — the offline backtest (validate_matchup_hitter.py) found the props
behave very differently (hits has signal, total_bases is a shrinkage mirage,
home_runs is dead), so a single blended verdict would be misleading.

Flip gate per prop (pre-committed, see constants):
  - >= MATCHUP_HITTER_FLIP_MIN_DIVERGENCES graded games where the matchup and the
    baseline leaned OPPOSITE the line, AND
  - the matchup's side won >= MATCHUP_HITTER_FLIP_MIN_WINRATE of those, AND
  - the matchup's line-region Brier <= the baseline's (calibration at least as good).
"""

from __future__ import annotations

import math

from scipy.stats import poisson

import db
from constants import (
    MATCHUP_HITTER_FLIP_MIN_DIVERGENCES,
    MATCHUP_HITTER_FLIP_MIN_WINRATE,
)

# Same single-book preference the rest of the betting layer uses.
_BOOK_PREF = ["draftkings", "fanduel", "pinnacle", "prizepicks", "underdog", "betr", "sleeper"]

# (prop_type, player_game_logs actual column)
_PROPS = [
    ("hitter_total_bases", "actual_total_bases"),
    ("hitter_hits", "actual_hits"),
    ("hitter_home_runs", "actual_home_runs"),
]


def _p_over(mu: float, line: float) -> float:
    """P(actual > line) under the Poisson model edge.py uses for count props.
    For a half-point line L, P(X > L) = P(X >= floor(L)+1) = poisson.sf(floor(L))."""
    return float(poisson.sf(math.floor(line), max(mu, 1e-6)))


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


def _lean(pred: float, line: float) -> str:
    if abs(pred - line) < 0.1:
        return "even"
    return "over" if pred > line else "under"


def gather_rows(prop_type: str, actual_col: str) -> list[dict]:
    """Join shadow matchup projection + baseline projection + book line + actual
    for every graded game that carries a matchup_projection for this prop."""
    proj = _paginate(
        "projections",
        "game_id, player_id, projection, projection_date, matchup_projection",
        [lambda q: q.eq("prop_type", prop_type)],
    )
    graded = [p for p in proj if p.get("matchup_projection") is not None]
    if not graded:
        return []

    logs = _paginate(
        "player_game_logs",
        f"player_id, game_id, {actual_col}",
        [lambda q: q.not_.is_(actual_col, "null")],
    )
    actual = {
        (int(r["player_id"]), int(r["game_id"])): float(r[actual_col])
        for r in logs if r.get(actual_col) is not None
    }

    line_rows = _paginate(
        "lines",
        "player_id, bookmaker, line, game_date",
        [lambda q: q.eq("prop_type", prop_type)],
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
        rows.append({
            "matchup": float(p["matchup_projection"]),
            "base": float(p["projection"]),
            "line": float(ln["line"]),
            "actual": a,
        })
    return rows


def compute(rows: list[dict]) -> dict:
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
    d = sc["divergences"]
    wr = sc["winrate_matchup"]
    bm, bb = sc["brier_matchup"], sc["brier_base"]
    if d < MATCHUP_HITTER_FLIP_MIN_DIVERGENCES:
        return False, f"only {d}/{MATCHUP_HITTER_FLIP_MIN_DIVERGENCES} divergence-games so far"
    if wr is None or wr < MATCHUP_HITTER_FLIP_MIN_WINRATE:
        shown = "n/a" if wr is None else f"{wr:.0%}"
        return False, f"win-rate {shown} < {MATCHUP_HITTER_FLIP_MIN_WINRATE:.0%}"
    if bm is None or bb is None or bm > bb:
        return False, f"calibration not yet >= baseline (Brier {bm:.3f} vs {bb:.3f})"
    return True, "all gates passed"


def log_scorecard() -> None:
    any_data = False
    for prop_type, actual_col in _PROPS:
        try:
            rows = gather_rows(prop_type, actual_col)
        except Exception as exc:
            print(f"  hitter-matchup scorecard [{prop_type}]: read failed ({exc}) -- skipping")
            continue
        if not rows:
            continue
        any_data = True
        sc = compute(rows)
        ready, why = flip_ready(sc)
        wr = sc["winrate_matchup"]
        wr_s = f"{wr:.0%}" if wr is not None else "n/a"
        print(
            f"  hitter-matchup [{prop_type}]: {sc['n']} graded, "
            f"{sc['divergences']} divergences | matchup won {sc['won_matchup']}/"
            f"{sc['divergences']} ({wr_s}) vs baseline {sc['won_base']} | "
            f"Brier m {sc['brier_matchup']:.3f} / b {sc['brier_base']:.3f} | "
            f"FLIP-READY? {'YES' if ready else 'no'} -- {why}"
        )
    if not any_data:
        print(
            "  hitter-matchup scorecard: no graded shadow games yet (needs "
            "add_hitter_matchup.sql applied + posted-lineup runs to grade)."
        )


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    log_scorecard()
