"""Edge calculation — step 12. Pure math, no DB reads/writes, no API calls.

Compares the model's projection to the market's de-vigged "fair" over
probability for each pitcher prop, and reports the difference (the edge).

Baseline ("fair") probability source, in priority order:
  1. Pinnacle — the sharpest book; de-vig its over/under to a fair over prob.
  2. Consensus of traditional books (DraftKings, FanDuel, Caesars) — average
     their individual de-vigged over probabilities.
  3. Neither available -> skip this projection (no edge row emitted).

Model over probability uses a Poisson survival function for the integer count
props (the correct distribution for counts — sane for low-mean props like HR,
where the old normal approximation overstated the over) and a normal
approximation for the continuous fantasy-score props, until calibrated
confidence scores accumulate.
Positive edge = the model thinks the over is more likely than the book implies.
"""

from typing import TYPE_CHECKING

import math

from scipy.stats import norm, poisson

from constants import MIN_STD, PROP_CV

if TYPE_CHECKING:
    from schemas import EdgeRow, LineRow, ProjectionContextRow

# Books we trust to form a fair-probability baseline when Pinnacle is absent.
# DFS apps (PrizePicks/Underdog/etc.) carry no two-sided vig to remove, so
# they never seed the baseline. Caesars is NOT ingested by lines.py so it
# would never appear in book_lines — kept out of the list.
CONSENSUS_BOOKS = ["draftkings", "fanduel"]

# PROP_CV (coefficient of variation for the normal approximation) and MIN_STD
# (scale floor) now live in engine/constants.py so the same values can be
# referenced from the frontend math docs and any future calibration work.


def _american_to_implied(price) -> float | None:
    """American odds -> implied probability (still includes vig). None if unusable."""
    if price is None:
        return None
    try:
        price = float(price)
    except (TypeError, ValueError):
        return None
    if price < 0:
        return abs(price) / (abs(price) + 100.0)
    if price > 0:
        return 100.0 / (price + 100.0)
    return None   # price == 0 is not a real line


def _devig_over_prob(over_price, under_price) -> float | None:
    """De-vig a two-sided market to a fair over probability (0–1), or None.

    Normalizes the two implied probabilities so they sum to 1, removing the
    book's hold. Requires both sides priced.
    """
    over_imp = _american_to_implied(over_price)
    under_imp = _american_to_implied(under_price)
    if over_imp is None or under_imp is None:
        return None
    total = over_imp + under_imp
    if total <= 0:
        return None
    return over_imp / total


def _model_over_prob(projection: float, line: float, prop_type: str | None = None) -> float:
    """P(actual > line) given the model's projection.

    Integer COUNT props (strikeouts, hits, total bases, HR, ...) use the POISSON
    survival function — the correct distribution for non-negative integer
    outcomes, and critically SANE for low-mean props. The old normal
    approximation (std = projection * 0.35) badly overstated P(over) for small
    counts: a HR projected 1.0 vs a 0.5 line read 0.98 (Poisson gives 0.63),
    which is exactly what inflated the displayed HR / total-bases edges to
    implausible +0.5 .. +0.85 values.

    Over wins when actual > line; for a half-point line L the smallest winning
    integer is floor(L)+1, so P(over) = P(X >= floor(L)+1) = poisson.sf(floor(L)).

    Fantasy-score props are a continuous points total (not a count), so they keep
    the normal approximation. They never yield a two-sided de-vigged edge anyway
    (DFS-only line), so that branch is effectively defensive.

    (Poisson assumes variance == mean; real counts are mildly over-dispersed, so a
    negative binomial would be marginally better — a future refinement once
    calibration data accumulates. Poisson is the right first correction.)
    """
    if prop_type and prop_type.endswith("fantasy_score"):
        std = max(projection * PROP_CV, MIN_STD)
        return float(1.0 - norm.cdf(line - 0.5, loc=projection, scale=std))
    mu = max(projection, 1e-6)  # Poisson mean must be > 0
    return float(poisson.sf(math.floor(line), mu))


def _fair_over_prob(book_lines: dict) -> tuple[str, dict, float] | None:
    """Pick the baseline fair over probability for one player/prop.

    book_lines: {bookmaker -> line row}.
    Returns (source_bookmaker, source_line_row, fair_over_prob) or None when
    no book can seed a baseline.
    """
    # 1. Pinnacle, the sharp baseline.
    pin = book_lines.get("pinnacle")
    if pin is not None:
        fair = _devig_over_prob(pin.get("over_price"), pin.get("under_price"))
        if fair is not None:
            return "pinnacle", pin, fair

    # 2. Consensus of traditional books.
    fair_probs: list[float] = []
    consensus_rows: list[dict] = []
    for book in CONSENSUS_BOOKS:
        row = book_lines.get(book)
        if row is None:
            continue
        fair = _devig_over_prob(row.get("over_price"), row.get("under_price"))
        if fair is not None:
            fair_probs.append(fair)
            consensus_rows.append(row)

    if fair_probs:
        avg = sum(fair_probs) / len(fair_probs)
        # Represent the consensus with its own label; the line shown is the
        # average of the contributing books' lines (they cluster tightly).
        avg_line = sum(float(r["line"]) for r in consensus_rows) / len(consensus_rows)
        synth = {"line": avg_line, "over_price": None, "under_price": None}
        return "consensus", synth, avg

    return None


def compute_edges(
    projections: "list[ProjectionContextRow]",
    lines: "list[LineRow]",
) -> "list[EdgeRow]":
    """Compute over-edge rows by comparing projections to de-vigged market lines.

    projections: rows with player_id, prop_type, projection, projection_date.
    lines:       rows with player_id, prop_type, game_date, bookmaker, line,
                 over_price, under_price.

    Returns one edge row per (player_id, prop_type, game_date) that has a usable
    baseline line. Projections with no matching line are skipped — sparse line
    coverage degrades gracefully to fewer edge rows, never an error.
    """
    if not projections or not lines:
        print("  no projections or no lines -- 0 edges")
        return []

    # Index lines by (player_id, prop_type, game_date) -> {bookmaker -> row}.
    by_key: dict[tuple, dict] = {}
    for ln in lines:
        key = (ln["player_id"], ln["prop_type"], ln["game_date"])
        by_key.setdefault(key, {})[ln["bookmaker"]] = ln

    edges: list[dict] = []
    skipped_no_line = 0
    skipped_no_baseline = 0

    for proj in projections:
        player_id = proj["player_id"]
        prop_type = proj.get("prop_type")
        game_date = proj.get("projection_date") or proj.get("game_date")

        book_lines = by_key.get((player_id, prop_type, game_date))
        if not book_lines:
            skipped_no_line += 1
            continue

        baseline = _fair_over_prob(book_lines)
        if baseline is None:
            skipped_no_baseline += 1
            continue

        source_book, source_row, fair_over_prob = baseline
        line = float(source_row["line"])
        model_proj = float(proj["projection"])
        model_over_prob = _model_over_prob(model_proj, line, prop_type)
        edge = model_over_prob - fair_over_prob

        edges.append({
            "player_id":       player_id,
            "prop_type":       prop_type,
            "game_date":       game_date,
            "bookmaker":       source_book,
            "line":            round(line, 2),
            "fair_over_prob":  round(fair_over_prob, 4),
            "model_proj":      round(model_proj, 2),
            "model_over_prob": round(model_over_prob, 4),
            "edge":            round(edge, 4),
            "over_price":      source_row.get("over_price"),
            "under_price":     source_row.get("under_price"),
        })

    print(
        f"  edges: {len(edges)} computed, "
        f"{skipped_no_line} skipped (no line), "
        f"{skipped_no_baseline} skipped (no de-viggable baseline)"
    )
    return edges
