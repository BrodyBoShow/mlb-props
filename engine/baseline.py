"""Baseline projections from recent pitcher data.

All builders use the same weighted rolling-average pattern:
  - last RECENT_STARTS starts weighted RECENT_WEIGHT×
  - older starts weighted OLDER_WEIGHT×
  - skips pitchers with no data in the lookback window

No DB writes here — every function returns list[dict] shaped for the
projections table: game_id, player_id, prop_type, projection, projection_date.
"""

from datetime import date, timedelta
from typing import TYPE_CHECKING

import pybaseball

if TYPE_CHECKING:
    from schemas import ProjectionRow

import stats
from constants import (
    FANTASY_RECENCY_K_HITTER,
    FANTASY_RECENCY_K_PITCHER,
    HITTER_LEAGUE_PRIOR,
    HITTER_REGRESSION_K,
    LEAGUE_AVG_HITTER_FP,
    LEAGUE_AVG_PITCHER_FP,
    LOOKBACK_DAYS,
    OLDER_WEIGHT,
    RECENT_STARTS,
    RECENT_WEIGHT,
    STRIKEOUT_EVENTS,
    et_today,
)
from fantasy_score import (
    PITCHER_EARNED_RUN_PTS,
    PITCHER_OUT_PTS,
    PITCHER_QUALITY_START_PTS,
    PITCHER_STRIKEOUT_PTS,
    hitter_fantasy_score,
    is_quality_start,
)


# ─── shared weighting logic ──────────────────────────────────────────────────

def _weighted_projection(values_newest_first: list[float]) -> float:
    """Weighted mean: last RECENT_STARTS values get RECENT_WEIGHT, rest OLDER_WEIGHT."""
    if not values_newest_first:
        return 0.0
    weights = [
        RECENT_WEIGHT if i < RECENT_STARTS else OLDER_WEIGHT
        for i in range(len(values_newest_first))
    ]
    total_w = sum(weights)
    if total_w == 0:
        return 0.0
    return round(
        sum(w * v for w, v in zip(weights, values_newest_first)) / total_w, 1
    )


def _regressed_projection(
    values_newest_first: list[float], prior: float, k: float = HITTER_REGRESSION_K
) -> float:
    """Weighted rolling mean regressed toward `prior` (Marcel-style).

    Adds k pseudo-games at the prior to the weighted sum, so a THIN sample is
    pulled hard toward the prior (taming spiky 1-game projections) while a DEEP
    sample barely moves. Same weighting as _weighted_projection. Validated in
    engine/validate_regression.py — lowers RMSE for every hitter count prop,
    concentrated in thin samples. See constants.HITTER_LEAGUE_PRIOR.
    """
    if not values_newest_first:
        return round(prior, 1)
    weights = [
        RECENT_WEIGHT if i < RECENT_STARTS else OLDER_WEIGHT
        for i in range(len(values_newest_first))
    ]
    sw = sum(weights)
    wsum = sum(w * v for w, v in zip(weights, values_newest_first))
    return round((wsum + k * prior) / (sw + k), 1)


def _median_projection(values: list[float]) -> float:
    """Median of per-game values — the right central estimate for the
    fantasy-score props.

    PrizePicks fantasy-score lines are flat-payout DFS lines set near the
    player's MEDIAN game (the ~50% over/under point). Fantasy score is heavily
    right-skewed (a few 20–30 FP games), so the weighted MEAN runs systematically
    ABOVE the median — and thus above the line — producing an Over lean for nearly
    every player (measured: 87% Over, mean +1.99 FP above the line, vs the median
    which centres on the line at −0.08). Using the median makes the projection
    comparable to how the line is set, so the leans are balanced and informative.
    """
    import statistics
    if not values:
        return 0.0
    return round(float(statistics.median(values)), 1)


def _blend_fantasy_projection(
    values: list[float],
    prior_median: float | None,
    k: float,
    floor: float,
) -> float:
    """Recency-median fantasy projection shrunk toward the player's full-history
    median. See constants.FANTASY_RECENCY_K_* for the why.

    weight on recency = n/(n+k). Sparse recent window (noisy, biased low) leans on
    the stable prior; a full recent window (a genuine slump) keeps its lean.
    Falls back to the league floor only when there is neither recency nor a prior.
    """
    import statistics
    recency = float(statistics.median(values)) if values else 0.0
    n = len(values)
    has_prior = prior_median is not None and prior_median > 0
    if n == 0 and not has_prior:
        return floor
    if n == 0:
        return round(float(prior_median), 1)
    if not has_prior:
        return round(recency, 1) if recency > 0 else floor
    w = n / (n + k)
    blended = w * recency + (1.0 - w) * float(prior_median)
    return round(blended, 1) if blended > 0 else floor


# ─── strikeout projections (Statcast via pybaseball) ─────────────────────────

def _strikeouts_per_start(
    player_id: int, start_dt: str, end_dt: str, bulk_df=None,
) -> list[int]:
    """K count per start in the window, newest first (includes zero-K starts).

    bulk_df: optional pre-fetched Statcast DataFrame covering the window
    for many pitchers. When provided we filter by pitcher id instead of
    issuing a per-pitcher pybaseball.statcast_pitcher() request — this
    lets baseline and model share a single bulk fetch.
    """
    if bulk_df is not None and not bulk_df.empty:
        df = bulk_df[bulk_df["pitcher"] == player_id].copy()
    else:
        df = pybaseball.statcast_pitcher(start_dt, end_dt, player_id)
    if df is None or df.empty:
        return []
    df = df.copy()
    df["is_k"] = df["events"].isin(STRIKEOUT_EVENTS)
    per_game = df.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    return [int(k) for k in per_game.tolist()]


def build_strikeout_projections(
    starters: list[dict],
    projection_date: date | None = None,
    bulk_df=None,
) -> "list[ProjectionRow]":
    """One strikeout projection per probable starter with recent Statcast data.

    bulk_df: optional pre-fetched Statcast DataFrame (see model._fetch_bulk_statcast).
    When provided, each pitcher is filtered out of the shared frame in memory
    instead of triggering its own statcast_pitcher() round-trip.
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    start_dt = (proj_date - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    end_dt = proj_date.strftime("%Y-%m-%d")
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        ks = _strikeouts_per_start(player_id, start_dt, end_dt, bulk_df=bulk_df)
        if not ks:
            print(f"  no recent Statcast data for player {player_id}, skipping")
            continue
        projection = _weighted_projection(ks)
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": "strikeouts",
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {s.get('full_name', player_id)}: {ks} -> {projection} K")
    return rows


# ─── first-inning pitches (Statcast via pybaseball) ──────────────────────────

def _first_inning_pitches_per_start(
    player_id: int, start_dt: str, end_dt: str, bulk_df=None,
) -> list[int]:
    """Count of a pitcher's 1st-inning pitches per start in the window, newest first.

    Each Statcast row is one pitch, so filtering to inning == 1 and counting per
    game gives the first-inning pitch count. Shares the bulk Statcast frame with
    the strikeout builder when provided (no per-pitcher round-trip); falls back
    to a single statcast_pitcher() call otherwise. The MLB Stats API game-log
    carries no per-inning split, so this prop MUST come from Statcast.
    """
    if bulk_df is not None and not bulk_df.empty:
        df = bulk_df[bulk_df["pitcher"] == player_id]
    else:
        df = pybaseball.statcast_pitcher(start_dt, end_dt, player_id)
    if df is None or df.empty or "inning" not in df.columns:
        return []
    first = df[df["inning"] == 1]
    if first.empty:
        return []
    per_game = first.groupby("game_date").size().sort_index(ascending=False)
    return [int(n) for n in per_game.tolist()]


def build_pitcher_first_inning_pitches_projections(
    starters: list[dict],
    projection_date: date | None = None,
    bulk_df=None,
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a starter's 1st-inning pitch count.

    Statcast-based (the game-log has no per-inning data), so this mirrors
    build_strikeout_projections and shares the same bulk Statcast frame rather
    than the gameLog _build_from_starts path.
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    start_dt = (proj_date - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    end_dt = proj_date.strftime("%Y-%m-%d")
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        counts = _first_inning_pitches_per_start(
            player_id, start_dt, end_dt, bulk_df=bulk_df
        )
        if not counts:
            print(f"  no recent 1st-inning data for player {player_id}, skipping")
            continue
        projection = _weighted_projection([float(c) for c in counts])
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": "pitcher_first_inning_pitches",
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(
            f"  {s.get('full_name', player_id)}: {counts} -> "
            f"{projection} 1st-inn pitches"
        )
    return rows


def _first_inning_strikeouts_per_start(
    player_id: int, start_dt: str, end_dt: str, bulk_df=None,
) -> list[int]:
    """Count of a pitcher's 1st-inning strikeouts per start in the window, newest first.

    Counts STRIKEOUT_EVENTS among the pitcher's inning-1 Statcast rows, grouped
    per game so a 1st inning with 0 Ks correctly contributes a 0 (not a missing
    game). Shares the bulk Statcast frame with the strikeout builder when provided.
    """
    if bulk_df is not None and not bulk_df.empty:
        df = bulk_df[bulk_df["pitcher"] == player_id]
    else:
        df = pybaseball.statcast_pitcher(start_dt, end_dt, player_id)
    if df is None or df.empty or "inning" not in df.columns:
        return []
    first = df[df["inning"] == 1]
    if first.empty:
        return []
    first = first.copy()
    first["is_k"] = first["events"].isin(STRIKEOUT_EVENTS)
    per_game = first.groupby("game_date")["is_k"].sum().sort_index(ascending=False)
    return [int(k) for k in per_game.tolist()]


def build_pitcher_first_inning_strikeouts_projections(
    starters: list[dict],
    projection_date: date | None = None,
    bulk_df=None,
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a starter's 1st-inning strikeout count.

    Statcast-based (per-inning split), shares the bulk frame. The 1st-inning K
    line is a real two-sided ParlayAPI market — unlike 1st-inning pitches thrown
    (PrizePicks-only), so this prop can be graded lean-vs-line right away.
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    start_dt = (proj_date - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    end_dt = proj_date.strftime("%Y-%m-%d")
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        counts = _first_inning_strikeouts_per_start(
            player_id, start_dt, end_dt, bulk_df=bulk_df
        )
        if not counts:
            print(f"  no recent 1st-inning data for player {player_id}, skipping")
            continue
        projection = _weighted_projection([float(c) for c in counts])
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": "pitcher_first_inning_strikeouts",
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {s.get('full_name', player_id)}: {counts} -> {projection} 1st-inn K")
    return rows


# ─── MLB Stats API builders (hits, walks, earned runs, outs) ─────────────────

def _build_from_starts(
    starters: list[dict],
    field: str,
    prop_type: str,
    label: str,
    projection_date: date | None = None,
) -> "list[ProjectionRow]":
    """Generic weighted-average builder using stats.get_pitcher_starts().

    field:     key in the dicts returned by stats.get_pitcher_starts()
    prop_type: value to store in the projections table
    label:     short unit string for stdout (e.g. 'H', 'BB')
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        starts = stats.get_pitcher_starts(player_id, LOOKBACK_DAYS, proj_date)
        if not starts:
            print(f"  no recent game-log data for player {player_id}, skipping")
            continue
        values = [float(sp[field]) for sp in starts]
        projection = _weighted_projection(values)
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": prop_type,
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {s.get('full_name', player_id)}: {values[:5]} -> {projection} {label}")
    return rows


def build_hits_allowed_projections(
    starters: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for hits allowed per start."""
    return _build_from_starts(starters, "hits_allowed", "hits_allowed", "H", projection_date)


def build_walks_projections(
    starters: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for walks (BB) per start."""
    return _build_from_starts(starters, "walks", "walks", "BB", projection_date)


def build_earned_runs_projections(
    starters: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for earned runs per start."""
    return _build_from_starts(starters, "earned_runs", "earned_runs", "ER", projection_date)


def build_outs_recorded_projections(
    starters: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for outs recorded per start."""
    return _build_from_starts(starters, "outs_recorded", "outs_recorded", "outs", projection_date)


# ─── pitcher fantasy score (PrizePicks) ──────────────────────────────────────

def build_pitcher_fantasy_score_projections(
    starters: list[dict],
    projection_date: date | None = None,
    prior_medians: dict | None = None,
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a pitcher's PrizePicks fantasy score.

    Computes per-start FP from the components we already extract for every
    other pitcher prop (outs, K, ER) PLUS the QS bonus derived from
    outs + ER. The W bonus is NOT included historically -- stats.get_pitcher_
    starts doesn't carry per-start W decisions and refetching the live feed
    per historical start would balloon API calls. This makes the baseline
    systematically low by ~2.4 FP (league-average W rate × 6 pts), but the
    bias is uniform across pitchers so over/under leans vs the PrizePicks
    line still reflect real model signal.

    Once player_game_logs has sufficient graded fantasy-score rows, switch
    to reading historical actual_pitcher_fantasy_score directly -- that
    already includes the W bonus.
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")
    prior_medians = prior_medians or {}

    rows: list[dict] = []
    for s in starters:
        player_id = s["player_id"]
        starts = stats.get_pitcher_starts(player_id, LOOKBACK_DAYS, proj_date)
        prior = prior_medians.get(player_id)
        if not starts and prior is None:
            print(f"  no recent game-log data for player {player_id}, skipping")
            continue
        per_start_fp: list[float] = []
        for st in starts or []:
            outs = st["outs_recorded"]
            k = st["strikeouts"]
            er = st["earned_runs"]
            fp = (
                outs * PITCHER_OUT_PTS
                + k * PITCHER_STRIKEOUT_PTS
                + er * PITCHER_EARNED_RUN_PTS
            )
            if is_quality_start(outs, er):
                fp += PITCHER_QUALITY_START_PTS
            per_start_fp.append(float(fp))
        # MEDIAN over the recent starts, shrunk toward the pitcher's full-history
        # median — a 5-start window is noisy and one rough start biases it low.
        projection = _blend_fantasy_projection(
            per_start_fp, prior, FANTASY_RECENCY_K_PITCHER, LEAGUE_AVG_PITCHER_FP
        )
        rows.append(
            {
                "game_id": s["game_id"],
                "player_id": player_id,
                "prop_type": "pitcher_fantasy_score",
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(
            f"  {s.get('full_name', player_id)}: "
            f"{[round(v, 1) for v in per_start_fp[:5]]} -> {projection} FP"
        )
    return rows


# ─── hitter builders (MLB Stats API game logs) ───────────────────────────────

def _build_hitter_from_games(
    players: list[dict],
    field: str,
    prop_type: str,
    label: str,
    projection_date: date | None = None,
) -> "list[ProjectionRow]":
    """Generic weighted-average builder for hitters using stats.get_hitter_games().

    Mirrors _build_from_starts but for lineup hitters. Each player dict must
    carry player_id, game_id, and full_name (from fetch.fetch_lineups()).

    field:     key in the dicts returned by stats.get_hitter_games()
    prop_type: value to store in the projections table
    label:     short unit string for stdout (e.g. 'H', 'TB')
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")

    rows: list[dict] = []
    for p in players:
        player_id = p["player_id"]
        games = stats.get_hitter_games(player_id, LOOKBACK_DAYS, proj_date)
        if not games:
            print(f"  no recent game-log data for hitter {player_id}, skipping")
            continue
        values = [float(g[field]) for g in games]
        # Regress toward the league prior (Marcel-style) so a thin/spiky recent
        # window doesn't over-project; deep samples are barely touched. Falls back
        # to the plain weighted mean for any prop without a configured prior.
        prior = HITTER_LEAGUE_PRIOR.get(prop_type)
        projection = (
            _regressed_projection(values, prior)
            if prior is not None
            else _weighted_projection(values)
        )
        rows.append(
            {
                "game_id": p["game_id"],
                "player_id": player_id,
                "prop_type": prop_type,
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
        print(f"  {p.get('full_name', player_id)}: {values[:5]} -> {projection} {label}")
    return rows


def build_hitter_hits_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's hits per game."""
    return _build_hitter_from_games(lineup_players, "hits", "hitter_hits", "H", projection_date)


def build_hitter_total_bases_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's total bases per game."""
    return _build_hitter_from_games(lineup_players, "total_bases", "hitter_total_bases", "TB", projection_date)


def build_hitter_hits_runs_rbis_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's hits+runs+RBIs per game (combo)."""
    return _build_hitter_from_games(
        lineup_players, "hits_runs_rbis", "hitter_hits_runs_rbis", "HRR", projection_date
    )


def build_hitter_rbis_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's RBIs per game."""
    return _build_hitter_from_games(lineup_players, "rbis", "hitter_rbis", "RBI", projection_date)


def build_hitter_runs_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's runs per game."""
    return _build_hitter_from_games(lineup_players, "runs", "hitter_runs", "R", projection_date)


def build_hitter_home_runs_projections(
    lineup_players: list[dict], projection_date: date | None = None
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's home runs per game."""
    return _build_hitter_from_games(lineup_players, "home_runs", "hitter_home_runs", "HR", projection_date)


def build_hitter_fantasy_score_projections(
    lineup_players: list[dict],
    projection_date: date | None = None,
    prior_medians: dict | None = None,
) -> "list[ProjectionRow]":
    """Weighted rolling projection for a hitter's PrizePicks fantasy score.

    Computes per-game FP from each game's full component set (singles,
    doubles, triples, HRs, runs, RBIs, walks, HBP, SBs) via the shared
    fantasy_score.hitter_fantasy_score helper. get_hitter_games returns
    all five extra components alongside the existing five, so there is
    NO cold start -- the baseline works on day one without waiting for
    player_game_logs to accumulate.

    The recent-window median is shrunk toward the player's full-history median
    (prior_medians) so a sparse/quiet recent window can't bias a star's
    projection low and fake a wall of under-edges. See
    constants.FANTASY_RECENCY_K_HITTER.
    """
    proj_date = projection_date or et_today()  # Eastern, not UTC date.today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")
    prior_medians = prior_medians or {}

    rows: list[dict] = []
    for p in lineup_players:
        player_id = p["player_id"]
        games = stats.get_hitter_games(player_id, LOOKBACK_DAYS, proj_date)
        prior = prior_medians.get(player_id)
        if not games:
            # Debut / call-up with no recent game-log history. Never SKIP (the
            # player is a confirmed starter and must get a projection) and never
            # emit 0 — use the player's full-history median if we have one, else
            # the league-average hitter FP floor.
            projection = _blend_fantasy_projection(
                [], prior, FANTASY_RECENCY_K_HITTER, LEAGUE_AVG_HITTER_FP
            )
            rows.append(
                {
                    "game_id": p["game_id"],
                    "player_id": player_id,
                    "prop_type": "hitter_fantasy_score",
                    "projection": projection,
                    "projection_date": proj_date_str,
                }
            )
            src = "full-history prior" if prior else "league-avg floor"
            print(
                f"  {p.get('full_name', player_id)}: no recent history -> "
                f"{projection} FP ({src})"
            )
            continue
        per_game_fp = [
            hitter_fantasy_score(
                hits=g["hits"],
                doubles=g["doubles"],
                triples=g["triples"],
                home_runs=g["home_runs"],
                runs=g["runs"],
                rbis=g["rbis"],
                walks=g["walks"],
                hit_by_pitch=g["hit_by_pitch"],
                stolen_bases=g["stolen_bases"],
            )
            for g in games
        ]
        # MEDIAN over the recent window (PrizePicks lines sit at the ~50% point
        # and FP is right-skewed, so the mean over-projects), shrunk toward the
        # player's full-history median so a sparse/quiet window can't bias a
        # star's projection low. Thin samples that median to 0 fall to the prior
        # / league floor inside the blend.
        projection = _blend_fantasy_projection(
            per_game_fp, prior, FANTASY_RECENCY_K_HITTER, LEAGUE_AVG_HITTER_FP
        )
        print(
            f"  {p.get('full_name', player_id)}: "
            f"{[round(v, 1) for v in per_game_fp[:5]]} (med {_median_projection(per_game_fp)}, "
            f"prior {prior}) -> {projection} FP"
        )
        rows.append(
            {
                "game_id": p["game_id"],
                "player_id": player_id,
                "prop_type": "hitter_fantasy_score",
                "projection": projection,
                "projection_date": proj_date_str,
            }
        )
    return rows


if __name__ == "__main__":
    import fetch
    starters = fetch.fetch_starters()
    print(f"Building strikeout projections for {len(starters)} starters...")
    rows = build_strikeout_projections(starters)
    print(f"\nProduced {len(rows)} projections")
