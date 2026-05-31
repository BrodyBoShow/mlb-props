"""Calibration confidence scores — step 10.

For each projection, computes a confidence value (0.0–1.0) representing the
fraction of that pitcher's recent graded starts in which their actual output
met or exceeded the current projection level.

This is a practical "hit rate" signal, not isotonic regression (that requires
hundreds of rows; we'll add it once enough data has accumulated). The design
is the same: read graded logs, emit confidence rows, no DB writes here.

Limitations (to revisit once player_game_logs is richer):
  - Only strikeouts projections receive confidence scores today, because
    player_game_logs only stores actual_strikeouts. When the grading job
    stores actuals for the other four props, add a mapping here.

Graceful degradation: if game_logs is empty, or no pitcher has enough graded
starts, this returns [] and the caller leaves confidence NULL in the DB.
"""

from collections import defaultdict

from constants import MIN_GRADED_STARTS

# MIN_GRADED_STARTS lives in engine/constants.py.
# How many of the pitcher's most recent starts to use for the rate calculation.
CONFIDENCE_WINDOW = 10

# prop_type → key in player_game_logs that holds the actual value.
# All pitcher + hitter prop types are graded and stored by grade.py.
_ACTUAL_COL: dict[str, str] = {
    # pitcher
    "strikeouts":    "actual_strikeouts",
    "hits_allowed":  "actual_hits_allowed",
    "walks":         "actual_walks",
    "earned_runs":   "actual_earned_runs",
    "outs_recorded": "actual_outs_recorded",
    # hitter
    "hitter_hits":        "actual_hits",
    "hitter_total_bases": "actual_total_bases",
    "hitter_rbis":        "actual_rbis",
    "hitter_runs":        "actual_runs",
    "hitter_home_runs":   "actual_home_runs",
    # PrizePicks fantasy score — single book, scored via fantasy_score module.
    "pitcher_fantasy_score": "actual_pitcher_fantasy_score",
    "hitter_fantasy_score":  "actual_hitter_fantasy_score",
}


def compute_confidences(
    projections: list[dict],
    game_logs: list[dict],
) -> list[dict]:
    """Return confidence rows for projections that have enough graded history.

    projections: list of projection dicts (game_id, player_id, prop_type,
                 projection, projection_date).
    game_logs:   list of player_game_logs rows (player_id, game_date,
                 actual_strikeouts, …).

    Returns a list of dicts: {game_id, player_id, prop_type,
    projection_date, confidence}. Pitchers with < MIN_GRADED_STARTS graded
    starts are omitted — their confidence column stays NULL.
    """
    if not game_logs:
        print("  no game logs available — confidence scores skipped")
        return []

    # Index logs by player_id for fast lookup.
    logs_by_player: dict[int, list[dict]] = defaultdict(list)
    for log in game_logs:
        pid = log.get("player_id")
        if pid is not None:
            logs_by_player[pid].append(log)

    results: list[dict] = []
    skipped_prop = 0
    skipped_history = 0

    for proj in projections:
        prop_type = proj.get("prop_type", "")
        actual_col = _ACTUAL_COL.get(prop_type)

        if actual_col is None:
            # No actual-value column mapped for this prop type yet.
            skipped_prop += 1
            continue

        player_id = proj.get("player_id")
        player_logs = logs_by_player.get(player_id, [])

        # Filter to logs that actually have an actual value for this prop.
        graded = [lg for lg in player_logs if lg.get(actual_col) is not None]

        if len(graded) < MIN_GRADED_STARTS:
            skipped_history += 1
            continue

        # Most-recent CONFIDENCE_WINDOW starts.
        recent = sorted(graded, key=lambda r: r.get("game_date", ""), reverse=True)
        recent = recent[:CONFIDENCE_WINDOW]

        projection_val = float(proj.get("projection", 0))
        hit_count = sum(
            1 for lg in recent if float(lg.get(actual_col, 0)) >= projection_val
        )
        confidence = round(hit_count / len(recent), 3)

        results.append(
            {
                "game_id": proj["game_id"],
                "player_id": proj["player_id"],
                "prop_type": prop_type,
                "projection_date": proj["projection_date"],
                "confidence": confidence,
            }
        )

    print(
        f"  confidence: {len(results)} scores computed, "
        f"{skipped_history} skipped (< {MIN_GRADED_STARTS} graded starts), "
        f"{skipped_prop} skipped (prop not graded yet)"
    )
    return results
