"""Pipeline entrypoint: fetch the slate, project, then upsert to Supabase.

Blend strategy:
  - If player_game_logs has enough data: train XGBoost each run, blend
    BLEND_MODEL_WEIGHT model + BLEND_BASELINE_WEIGHT baseline per pitcher.
  - If train() returns None (insufficient data): baseline only.

Pybaseball cache is enabled up front so baseline and model share cached
Statcast responses for the same pitcher/date range — halves API calls.

Structure: main() is an executive summary. Each phase is its own private
helper (_grade_previous_slate / _setup_games_and_pitchers / etc.) so the
top-level read is the order of operations, and each helper is small
enough to reason about in isolation. Logic inside each helper is
unchanged from the pre-refactor single-function version.

Logs to stdout only (GitHub Actions captures it). Never writes log rows
to the DB.
"""

import time
import traceback
from datetime import date, datetime, timedelta

import pybaseball

pybaseball.cache.enable()

import baseline
import calibrate
import db
import edge
import fetch
import grade
import lines
import model as mlb_model
from constants import BLEND_BASELINE_WEIGHT, BLEND_MODEL_WEIGHT


# ─── blend helper (unchanged, just imports constants now) ────────────────────

def _blend(base_rows: list[dict], model_rows: list[dict]) -> list[dict]:
    """Weighted average of model and baseline projections.

    Pitchers that only appear in one source keep that source's projection
    unchanged.
    """
    model_map: dict[tuple, float] = {
        (r["game_id"], r["player_id"]): r["projection"] for r in model_rows
    }
    blended = []
    blended_count = 0
    for r in base_rows:
        key = (r["game_id"], r["player_id"])
        if key in model_map:
            proj = round(
                BLEND_MODEL_WEIGHT * model_map[key]
                + BLEND_BASELINE_WEIGHT * r["projection"],
                1,
            )
            blended.append({**r, "projection": proj})
            blended_count += 1
        else:
            blended.append(r)  # model had no prediction → keep baseline as-is
    pct_model = int(BLEND_MODEL_WEIGHT * 100)
    pct_baseline = int(BLEND_BASELINE_WEIGHT * 100)
    print(
        f"  blended {blended_count} pitchers "
        f"({pct_model}% model / {pct_baseline}% baseline); "
        f"{len(base_rows) - blended_count} baseline-only"
    )
    return blended


# ─── phase helpers ───────────────────────────────────────────────────────────

def _grade_previous_slate() -> None:
    """Grade yesterday's pitcher and hitter projections; upsert game logs.

    Guarded so later runs in the same day don't re-grade an already-graded
    slate — once player_game_logs has rows for yesterday, the work is done.

    Fetches yesterday's projection rows ONCE and reuses them for both the
    pitcher and hitter grading passes (each pass filters internally).
    """
    yesterday_str = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")

    already_graded = db.get_game_log_count_for_date(yesterday_str)
    if already_graded > 0:
        print(
            f"  {already_graded} rows already graded for {yesterday_str} -- skipping"
        )
        return

    projections = db.get_projections_for_date(yesterday_str)

    print("Grading yesterday's pitcher projections...")
    game_logs = grade.grade_yesterday(projections=projections)
    n_logs = db.upsert_game_logs(game_logs)
    print(f"  upserted {n_logs} pitcher game log rows")

    print("Grading yesterday's hitter projections...")
    hitter_logs = grade.grade_hitters_yesterday(projections=projections)
    n_hlogs = db.upsert_game_logs(hitter_logs)
    print(f"  upserted {n_hlogs} hitter game log rows")


def _setup_games_and_pitchers() -> tuple[list[dict], list[dict]]:
    """Fetch today's games + probable starters, upsert reference rows.

    Returns (games, starters). starters is the per-game-id pitcher list
    the projection builders consume; games is the games table payload
    needed by predict() to know home/away.
    """
    print("Fetching today's games...")
    games = fetch.fetch_games()
    print(f"  fetched {len(games)} games")

    print("Fetching probable starters...")
    starters = fetch.fetch_starters()
    players = fetch.fetch_probable_pitchers()
    print(f"  fetched {len(starters)} starters")

    # Reference tables first — projections reference both games and players.
    print("Upserting players...")
    n_players = db.upsert_players(players)
    print(f"  upserted {n_players} players")

    print("Upserting games...")
    n_games = db.upsert_games(games)
    print(f"  upserted {n_games} games")

    return games, starters


def _run_pitcher_pipeline(
    starters: list[dict], games: list[dict]
) -> tuple[list[dict], dict[str, int], int]:
    """Build + upsert all pitcher prop projections.

    Returns (all_pitcher_projections, name_to_id_pitchers, n_strikeout_proj).
    name_to_id is seeded with pitcher names here; _run_hitter_pipeline
    extends it with confirmed-lineup hitters.

    Skip path: if today's projections already exist (>= 20 rows), bail out
    of the expensive baseline + XGBoost work. name_to_id is still built
    from starters so the lines fetch can resolve pitcher names. The empty
    projections list is fine — _run_lines_and_edges() re-fetches from the
    DB in refresh mode so edges still compute.
    """
    today_str = date.today().strftime("%Y-%m-%d")
    existing = db.get_projection_count_for_date(today_str)
    name_to_id = {
        s["full_name"]: s["player_id"] for s in starters if s.get("full_name")
    }
    if existing >= 20:
        print(
            f"  {existing} projections already exist for {today_str} -- "
            f"skipping pitcher baseline + model"
        )
        return [], name_to_id, 0

    # ── strikeouts: baseline + optional XGBoost blend ───────────────────────
    # The XGBoost predict() path already does a single bulk Statcast fetch.
    # We pass that same DataFrame to baseline.build_strikeout_projections so
    # the baseline doesn't trigger a second wave of per-pitcher fetches.
    # When the model is skipped (insufficient training rows) we still want
    # the baseline to enjoy the bulk pattern, so we do a standalone fetch.
    print("Training XGBoost (no-ops if insufficient data)...")
    trained_model = mlb_model.train()

    if trained_model is not None:
        print("Running XGBoost predictions...")
        model_projections, bulk_df = mlb_model.predict(trained_model, starters, games)
    else:
        print("  no trained model — using baseline only")
        model_projections = []
        print("  bulk Statcast fetch (for baseline)...")
        bulk_df = mlb_model._fetch_bulk_statcast(date.today())

    print("Building baseline strikeout projections...")
    base_projections = baseline.build_strikeout_projections(starters, bulk_df=bulk_df)
    print(f"  baseline: {len(base_projections)} projections")

    if trained_model is not None:
        print("Blending baseline + model projections...")
        projections = _blend(base_projections, model_projections)
    else:
        projections = base_projections

    print("Upserting strikeout projections...")
    n_strikeout = db.upsert_projections(projections)
    print(f"  upserted {n_strikeout} strikeout projections")

    # Sanity check: a normal slate has 28-32 starters. Fewer than 20
    # strikeout projections means fetch_starters()/lookup_player() is
    # silently dropping pitchers — surface it without crashing.
    if len(projections) < 20:
        print(
            f"  WARNING: only {len(projections)} strikeout projections — "
            f"expected 25+. Check fetch_starters() and lookup_player()."
        )

    # ── other pitcher props (MLB Stats API game-log baseline) ───────────────
    other_prop_rows: list[dict] = []
    for builder, label in [
        (baseline.build_hits_allowed_projections, "hits_allowed"),
        (baseline.build_walks_projections, "walks"),
        (baseline.build_earned_runs_projections, "earned_runs"),
        (baseline.build_outs_recorded_projections, "outs_recorded"),
        (baseline.build_pitcher_fantasy_score_projections, "pitcher_fantasy_score"),
    ]:
        print(f"Building {label} projections...")
        rows = builder(starters)
        other_prop_rows.extend(rows)
        n = db.upsert_projections(rows)
        print(f"  upserted {n} {label} projections")

    all_pitcher_projections = projections + other_prop_rows

    # name_to_id was seeded above (before the skip check) so the lines fetch
    # can resolve pitcher names regardless of which branch we took.
    return all_pitcher_projections, name_to_id, n_strikeout


def _run_hitter_pipeline(
    name_to_id: dict[str, int],
) -> tuple[list[dict], int]:
    """Build + upsert hitter prop projections IF lineups have posted.

    Returns (hitter_projections, lineup_player_count). Mutates name_to_id
    in place to add lineup hitters so the lines fetch can resolve them.
    Lineups post ~60-90 min before first pitch; the 8 AM cron typically
    runs before lineups (returns empty list) and the 1 PM cron captures them.
    """
    print("Fetching lineup players...")
    lineup_players = fetch.fetch_lineups()
    if not lineup_players:
        print("  no confirmed lineups yet — skipping hitter props")
        return [], 0

    print(f"  {len(lineup_players)} lineup players confirmed")
    db.upsert_players(
        [
            {k: v for k, v in p.items()
             if k in ("player_id", "full_name", "team", "position", "bats", "throws")}
            for p in lineup_players
        ]
    )

    # Update name_to_id immediately so the lines fetch can resolve hitter
    # names whether or not we skip the baseline builders below.
    name_to_id.update(
        {p["full_name"]: p["player_id"] for p in lineup_players if p.get("full_name")}
    )

    # Skip path: if today's hitter projections already exist (>= 100 rows
    # for hitter_hits), bail out of the baseline builders. The names are
    # already in name_to_id so lines + edges still work.
    today_str = date.today().strftime("%Y-%m-%d")
    existing_hitter = db.get_projection_count_for_date(today_str, "hitter_hits")
    if existing_hitter >= 100:
        print(
            f"  {existing_hitter} hitter_hits projections already exist for "
            f"{today_str} -- skipping hitter baseline builders"
        )
        return [], len(lineup_players)

    hitter_projections: list[dict] = []
    hitter_hit_rows: list[dict] = []
    for builder, label in [
        (baseline.build_hitter_hits_projections,        "hitter_hits"),
        (baseline.build_hitter_total_bases_projections, "hitter_total_bases"),
        (baseline.build_hitter_rbis_projections,        "hitter_rbis"),
        (baseline.build_hitter_runs_projections,        "hitter_runs"),
        (baseline.build_hitter_home_runs_projections,   "hitter_home_runs"),
        (baseline.build_hitter_fantasy_score_projections, "hitter_fantasy_score"),
    ]:
        print(f"Building {label} projections...")
        rows = builder(lineup_players)
        if label == "hitter_hits":
            hitter_hit_rows = rows
        hitter_projections.extend(rows)
        n = db.upsert_projections(rows)
        print(f"  upserted {n} {label} projections")

    # Sanity check: a full slate of confirmed lineups yields 200+ hitter
    # projections (18 batters/game x ~15 games). Far fewer means
    # fetch_lineups() is dropping players — surface it without crashing.
    if len(hitter_hit_rows) < 100:
        print(
            f"  WARNING: only {len(hitter_hit_rows)} hitter projections — "
            f"expected 200+. Check fetch_lineups()."
        )

    # name_to_id was mutated above (before the skip check) so hitter names
    # are available to the lines fetch regardless of which branch we took.
    return hitter_projections, len(lineup_players)


def _run_lines_and_edges(
    name_to_id: dict[str, int],
    all_projections: list[dict],
) -> None:
    """Ingest today's prop lines and compute model-vs-market edges.

    Always runs — refresh-mode runs skip projection builders but still need
    to update lines + edges. When all_projections is empty (refresh mode)
    we pull today's existing projections from the DB so edges still compute
    against them; otherwise we use the freshly-built ones in memory.

    Per CLAUDE.md, betting data is the most fragile data source and must
    NEVER break projections. Entire block is wrapped in try/except so any
    flakiness (API down, a missing lines/edges table before its migration
    is run) logs and continues to the calibration step. Projections are
    already upserted by the time we reach this helper, so a failure here
    has no effect on what the frontend reads.
    """
    try:
        today_str = date.today().strftime("%Y-%m-%d")

        # Refresh mode: rebuild all_projections from the DB so edges have
        # something to compare lines against. Inject projection_date so
        # edge.compute_edges (which keys on it) finds a match.
        if not all_projections:
            existing = db.get_projections_for_date(today_str)
            all_projections = [{**p, "projection_date": today_str} for p in existing]
            print(
                f"  refresh mode: loaded {len(all_projections)} existing "
                f"projections from DB for edge computation"
            )

        print("Fetching prop lines from ParlayAPI...")
        line_rows = lines.fetch_prop_lines(name_to_id, date.today())
        n_lines = db.upsert_lines(line_rows)
        print(f"  upserted {n_lines} lines across {len(lines.BOOKMAKERS)} bookmakers")

        print("Computing edges...")
        all_lines = db.get_lines_for_date(today_str)
        edge_rows = edge.compute_edges(all_projections, all_lines)
        n_edges = db.upsert_edges(edge_rows)
        print(f"  computed {n_edges} edges")
    except Exception as exc:
        print(
            f"  betting layer failed ({exc}) -- skipping lines/edges, "
            f"projections unaffected"
        )


def _run_calibration(all_projections: list[dict]) -> None:
    """Compute per-(player, prop) confidence scores from graded history.

    Always runs — confidence is a rolling stat keyed on each projection
    row, so a refresh-mode run still benefits from the recompute. When
    all_projections is empty (refresh mode) we pull today's existing
    projections from the DB so every active row gets a fresh score.

    Only the last 60 days of graded logs matter for the rolling confidence
    window — bounding the fetch here keeps the calibration round-trip
    small as the season accumulates.
    """
    if not all_projections:
        today_str = date.today().strftime("%Y-%m-%d")
        existing = db.get_projections_for_date(today_str)
        all_projections = [{**p, "projection_date": today_str} for p in existing]
        print(
            f"  refresh mode: loaded {len(all_projections)} existing projections "
            f"for calibration"
        )

    print("Computing calibration confidence scores...")
    since = (date.today() - timedelta(days=60)).strftime("%Y-%m-%d")
    logs = db.get_game_logs(since_date=since) or []
    confidence_rows = calibrate.compute_confidences(all_projections, logs)
    n_conf = db.update_confidences(confidence_rows)
    print(f"  updated {n_conf} confidence scores")


def _run_future_previews() -> None:
    """Populate games + probable starters for the next 3 days.

    Fast — no Statcast, no projections, no lines. Safe to run on every
    cron pass. The frontend uses these rows to render a "tomorrow's
    slate" preview (matchups + probable pitchers) on dates that don't
    yet have projections.

    Each future date is wrapped in its own try/except so a single bad
    schedule fetch doesn't take down the others. Lookup failures for an
    individual starter are absorbed inside fetch.py (the row simply
    omits home_starter_id / away_starter_id, which upsert_games handles
    via the per-key-signature grouping in db.upsert_games).
    """
    today = date.today()
    for days_ahead in (1, 2, 3):
        future_date = today + timedelta(days=days_ahead)
        date_str = future_date.strftime("%Y-%m-%d")
        try:
            games = fetch.fetch_games(date_str)
            if not games:
                print(f"  future preview {date_str}: no games found")
                continue
            db.upsert_games(games)

            starters = fetch.fetch_starters_for_date(date_str)
            players = [
                {
                    k: v for k, v in s.items()
                    if k in (
                        "player_id", "full_name", "team",
                        "position", "bats", "throws", "player_type",
                    )
                }
                for s in starters
            ]
            if players:
                db.upsert_players(players)
            print(
                f"  future preview {date_str}: {len(games)} games, "
                f"{len(starters)} probable starters"
            )
        except Exception as exc:
            print(f"  future preview {date_str} failed: {exc} -- skipping")


# ─── entrypoint ──────────────────────────────────────────────────────────────

def main() -> None:
    t0 = time.time()
    try:
        print(f"=== pipeline run {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC ===")

        # Mode header: with six crons/day, only the first run of the day
        # builds projections. Subsequent runs detect existing rows and
        # skip straight to lines + edges + calibration.
        today_str = date.today().strftime("%Y-%m-%d")
        proj_count = db.get_projection_count_for_date(today_str)
        is_refresh = proj_count >= 20
        print(
            f"  mode: {'lines-only refresh' if is_refresh else 'full projection'}"
        )
        print(f"  existing projections for today: {proj_count}")

        _grade_previous_slate()
        games, starters = _setup_games_and_pitchers()
        pitcher_projections, name_to_id, n_strikeout = _run_pitcher_pipeline(
            starters, games
        )
        hitter_projections, lineup_count = _run_hitter_pipeline(name_to_id)
        all_projections = pitcher_projections + hitter_projections

        _run_lines_and_edges(name_to_id, all_projections)
        _run_calibration(all_projections)

        # Future-slate previews are decorative (powers the
        # "tomorrow's slate" cards on the frontend) so any failure
        # here is absorbed without affecting the main pipeline.
        print("Populating future-slate previews...")
        try:
            _run_future_previews()
        except Exception as exc:
            print(f"  future previews failed ({exc}) -- skipping")

        print("Done.")
        print(
            f"=== run complete: {n_strikeout} pitcher projections, "
            f"{lineup_count} lineup players ==="
        )
        print(f"  total runtime: {time.time() - t0:.1f}s")
    except Exception:
        # Surface the full traceback to stdout (Actions captures it) and let
        # the run fail — a failed Actions run emails a notification
        # automatically.
        print("PIPELINE FAILED:")
        traceback.print_exc()
        print(f"  total runtime before failure: {time.time() - t0:.1f}s")
        raise


if __name__ == "__main__":
    main()
