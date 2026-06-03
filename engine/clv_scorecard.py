"""Daily LOG-ONLY closing-line-value (CLV) scorecard.

CLV is the gold-standard LEADING indicator of betting skill: does the market move
TOWARD the model's side between the OPENING line (captured in line_opens,
keep-first) and the closing-ish line (the live `lines.line`)? A model that
consistently anticipates the close has real edge — and CLV is measurable in
WEEKS, long before win/loss results accumulate. This is the metric that turns
"nice projections" into "provable edge".

ZERO projection impact, READ-ONLY. Run once/day on the full pipeline run.

For each (player, prop, day) we pick one book present at BOTH open and close
(sharpest first — Pinnacle's moves carry the most information), take the model's
frozen projection, and:
    lean       = over if projection > opening_line, under if <  (|gap| < 0.1 = none)
    clv_points = (closing - opening) * (+1 over / -1 under)
Positive CLV = the line moved toward the model. Over the lines that actually
MOVED, we report the share that moved toward the model + the average signed CLV,
broken out for Pinnacle (sharp) separately since that's the credible signal.
"""

from __future__ import annotations

from collections import defaultdict

import db

# Sharpest first — Pinnacle's line moves carry the most information; DFS books
# (prizepicks) barely move, so they're least informative.
_BOOK_PREF = [
    "pinnacle", "draftkings", "fanduel", "bet365", "caesars", "betmgm",
    "espnbet", "pointsbet", "underdog", "betr", "sleeper", "prizepicks",
]
_LEAN_THRESHOLD = 0.1  # mirror the board/results "no lean" cutoff


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


def gather() -> list[dict]:
    """Join opening line + closing line + frozen model projection per
    (player, prop, day), picking the sharpest book present in BOTH. Read-only.
    Returns [] (gracefully) if line_opens doesn't exist yet (pre-migration)."""
    try:
        opens = _paginate(
            "line_opens",
            "player_id, prop_type, bookmaker, game_date, opening_line",
            [],
        )
    except Exception as exc:
        print(f"  CLV: line_opens read skipped ({exc}) -- apply add_line_opens.sql")
        return []
    if not opens:
        return []

    closes = _paginate("lines", "player_id, prop_type, bookmaker, game_date, line", [])
    projs = _paginate(
        "projections", "player_id, prop_type, projection_date, projection", []
    )

    rank = {b: i for i, b in enumerate(_BOOK_PREF)}
    open_by: dict = defaultdict(dict)
    for o in opens:
        open_by[(o["player_id"], o["prop_type"], o["game_date"])][o["bookmaker"]] = float(
            o["opening_line"]
        )
    close_by: dict = defaultdict(dict)
    for c in closes:
        if c.get("line") is not None:
            close_by[(c["player_id"], c["prop_type"], c["game_date"])][c["bookmaker"]] = float(
                c["line"]
            )
    proj_by: dict = {}
    for p in projs:
        if p.get("projection") is not None:
            proj_by[(p["player_id"], p["prop_type"], p["projection_date"])] = float(
                p["projection"]
            )

    rows: list[dict] = []
    for key, obooks in open_by.items():
        cbooks = close_by.get(key)
        proj = proj_by.get(key)
        if not cbooks or proj is None:
            continue
        shared = [b for b in obooks if b in cbooks]
        if not shared:
            continue
        book = min(shared, key=lambda b: rank.get(b, 99))
        rows.append(
            {
                "prop": key[1],
                "book": book,
                "open": obooks[book],
                "close": cbooks[book],
                "proj": proj,
            }
        )
    return rows


def compute(rows: list[dict], sharp_only: bool = False) -> dict:
    """Over the model's leans, how did the line move open->close relative to the
    leaned side. Only lines that actually MOVED inform the toward-rate."""
    n_lean = moved = toward = 0
    clv_sum = 0.0
    for r in rows:
        if sharp_only and r["book"] != "pinnacle":
            continue
        diff = r["proj"] - r["open"]
        if abs(diff) < _LEAN_THRESHOLD:
            continue  # model had no lean at open
        n_lean += 1
        clv = (r["close"] - r["open"]) * (1.0 if diff > 0 else -1.0)
        clv_sum += clv
        if r["close"] != r["open"]:
            moved += 1
            if clv > 0:
                toward += 1
    return {
        "n_lean": n_lean,
        "moved": moved,
        "toward": toward,
        "pct_toward": (toward / moved) if moved else None,
        "avg_clv": (clv_sum / n_lean) if n_lean else None,
    }


def log_scorecard() -> None:
    """Print the compact, log-only CLV readout. Never raises into the pipeline."""
    try:
        rows = gather()
    except Exception as exc:
        print(f"  CLV scorecard: failed ({exc}) -- skipping")
        return

    if not rows:
        print(
            "  CLV scorecard: no opening lines captured yet (needs add_line_opens.sql "
            "applied + a few crons to record opens and observe movement)."
        )
        return

    allc = compute(rows)
    sharp = compute(rows, sharp_only=True)
    print(
        f"  CLV scorecard (log-only): {allc['n_lean']} model leans with both an "
        f"opening and closing line"
    )

    def _line(sc: dict, label: str) -> None:
        if sc["moved"] == 0:
            print(f"    {label}: 0 lines have moved yet (CLV needs open != close)")
            return
        print(
            f"    {label}: {sc['moved']} moved, {sc['toward']}/{sc['moved']} toward "
            f"model ({sc['pct_toward']:.0%}) | avg CLV {sc['avg_clv']:+.3f} pts"
        )

    _line(allc, "all books")
    _line(sharp, "pinnacle (sharp)")

    # Honest verdict — prefer the sharp read once it has enough moved lines.
    sc = sharp if sharp["moved"] >= 10 else allc
    if sc["moved"] < 10:
        print("    verdict: too few moved lines yet -- CLV builds over the next weeks")
    elif sc["pct_toward"] and sc["pct_toward"] > 0.52 and sc["avg_clv"] and sc["avg_clv"] > 0:
        print(
            "    verdict: POSITIVE CLV -- the market is moving toward the model "
            "(a real, early edge signal)"
        )
    else:
        print("    verdict: CLV ~break-even so far -- not yet beating the close")


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    log_scorecard()
