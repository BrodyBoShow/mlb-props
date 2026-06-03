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
from datetime import datetime, timedelta, timezone

import pybaseball

pybaseball.cache.enable()

import baseline
import calibrate
import db
import edge
import fetch
import grade
import lines
import matchup_k
import model as mlb_model
import stats
import sweet_spot
import weather
from constants import BLEND_BASELINE_WEIGHT, BLEND_MODEL_WEIGHT, LOOKBACK_DAYS, et_today


# ─── blend helper (unchanged, just imports constants now) ────────────────────

def _blend(base_rows: list[dict], model_rows: list[dict]) -> list[dict]:
    """Weighted average of model and baseline projections.

    Pitchers that only appear in one source keep that source's projection
    unchanged.
    """
    # Key -> full model row so we can carry both the projection AND the
    # opp_k_rate the model computed. The blended row is built from the
    # baseline row (which has no opp_k_rate), so without this the context
    # feature would be silently dropped in the blend.
    model_map: dict[tuple, dict] = {
        (r["game_id"], r["player_id"]): r for r in model_rows
    }
    blended = []
    blended_count = 0
    for r in base_rows:
        key = (r["game_id"], r["player_id"])
        if key in model_map:
            m = model_map[key]
            proj = round(
                BLEND_MODEL_WEIGHT * m["projection"]
                + BLEND_BASELINE_WEIGHT * r["projection"],
                1,
            )
            merged = {**r, "projection": proj}
            # Preserve the opposing-lineup K rate the model carried (feature 4).
            if m.get("opp_k_rate") is not None:
                merged["opp_k_rate"] = m["opp_k_rate"]
            blended.append(merged)
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
    yesterday_str = (et_today() - timedelta(days=1)).strftime("%Y-%m-%d")

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


def _parse_start_time(iso: str | None) -> "datetime | None":
    """ISO timestamp string → naive UTC datetime (or None on parse failure).

    games.start_time is stored as an ISO UTC string; weather.get_game_weather
    forces tzinfo=UTC on whatever it's handed, so we return a naive-UTC datetime.
    """
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except Exception:
        return None


def _run_game_weather(games: list[dict]) -> None:
    """Fetch today's wind per game and persist it to the games table.

    DISPLAY-ONLY: powers the HR-card wind tag. For each game we ask
    weather.get_game_weather for the forecast at first pitch (dome venues
    short-circuit to wind 0 / is_dome True) and write {wind_speed_mph,
    wind_dir_deg, is_dome} onto the games row via a targeted update. These
    values NEVER enter the model / projection / edge math.

    Runs every cron tick (full + refresh) so wind stays fresh through the day.
    The caller wraps this in try/except — weather flakiness must never affect
    projections, and a missing OPENWEATHER_API_KEY just yields NULL wind (the
    wind tag then degrades to the static park label).
    """
    updates: list[dict] = []
    for g in games:
        home = g.get("home_team")
        if not home:
            continue
        wx = weather.get_game_weather(home, _parse_start_time(g.get("start_time")))
        updates.append({
            "game_id": g["game_id"],
            "wind_speed_mph": wx.get("wind_speed_mph"),
            "wind_dir_deg": wx.get("wind_dir_deg"),
            "is_dome": wx.get("is_dome"),
        })
    n = db.update_game_weather(updates)
    print(f"  game weather: wrote wind to {n} games")


def _opposing_lineup_lhh(starters: list[dict]) -> dict[int, float]:
    """{starter player_id -> opposing lineup LHH fraction} for predict-time.

    Fetches today's confirmed lineups and, per starter, returns the handedness
    of the team the pitcher actually FACES (home pitcher → away lineup, away
    pitcher → home lineup). Uses fetch.compute_lineup_handedness per side so the
    metric matches grade.py's _opp_lineup_handedness (switch hitters 0.5/side).
    Returns {} when no lineups are posted yet (morning runs) — predict() then
    falls back to the 0.42 placeholder.
    """
    lineup_players = fetch.fetch_lineups()
    if not lineup_players:
        return {}
    home = fetch.compute_lineup_handedness(
        [p for p in lineup_players if p.get("home_away") == "home"]
    )
    away = fetch.compute_lineup_handedness(
        [p for p in lineup_players if p.get("home_away") == "away"]
    )
    out: dict[int, float] = {}
    for s in starters:
        # The pitcher faces the OTHER side's batters.
        src = away if s.get("home_away") == "home" else home
        v = src.get(s["game_id"], {}).get("lhh_pct")
        if v is not None:
            out[s["player_id"]] = v
    return out


def _run_pitcher_pipeline(
    starters: list[dict], games: list[dict],
    lineup_lhh_by_pid: dict[int, float] | None = None,
) -> "tuple[list[dict], dict[str, int], int, object]":
    """Build + upsert all pitcher prop projections.

    Returns (all_pitcher_projections, name_to_id_pitchers, n_strikeout_proj,
    bulk_df). bulk_df is the whole-window Statcast frame fetched for the model
    /baseline — reused by the hitter pipeline for the display-only sweet-spot
    footer (no extra Statcast call). It is None on the skip path (refresh runs
    do no Statcast fetch); the sweet-spot step then no-ops and the existing
    hitter_home_runs rows keep whatever sweet-spot values a prior full run set.
    name_to_id is seeded with pitcher names here; _run_hitter_pipeline
    extends it with confirmed-lineup hitters.

    Skip path: if today's projections already exist (>= 20 rows), bail out
    of the expensive baseline + XGBoost work. name_to_id is still built
    from starters so the lines fetch can resolve pitcher names. The empty
    projections list is fine — _run_lines_and_edges() re-fetches from the
    DB in refresh mode so edges still compute.
    """
    today_str = et_today().strftime("%Y-%m-%d")
    existing = db.get_projection_count_for_date(today_str)
    name_to_id = {
        s["full_name"]: s["player_id"] for s in starters if s.get("full_name")
    }
    if existing >= 20:
        # Stale-detection: skip only when the stored strikeouts ids match
        # today's probable starters AND there's no significant excess (i.e.
        # leftover ids that AREN'T current starters). The excess check
        # catches the case where a prior rebuild added fresh rows alongside
        # stale ones — the new rows match current starters (overlap ok) but
        # the stale rows are still present and rendering on the frontend.
        existing_ids = db.get_projection_player_ids_for_date(today_str, "strikeouts")
        current_ids = {s["player_id"] for s in starters if s.get("player_id")}
        overlap = existing_ids & current_ids
        excess = existing_ids - current_ids
        match_ok = len(overlap) >= max(1, int(0.8 * len(current_ids))) if current_ids else False
        clean = len(excess) <= 2   # tolerance for late scratches
        if match_ok and clean:
            print(
                f"  {existing} projections already exist for {today_str} -- "
                f"skipping pitcher baseline + model "
                f"({len(overlap)}/{len(current_ids)} starters match, "
                f"{len(excess)} excess stale ids)"
            )
            return [], name_to_id, 0, None
        reason = (
            f"{len(overlap)}/{len(current_ids)} overlap, "
            f"{len(excess)} excess stale ids"
        )
        print(
            f"  WARNING: stored projections for {today_str} appear stale "
            f"({reason}) -- rebuilding"
        )
        # Delete the stale rows so the fresh rebuild fully replaces them.
        # Different game_ids on stale vs fresh rows would otherwise leave
        # both in the table after the upsert (composite PK includes game_id).
        db.delete_projections_for_date_props(today_str, db._PITCHER_PROP_TYPES)

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
        if lineup_lhh_by_pid:
            print(
                f"  using real opposing-lineup handedness for "
                f"{len(lineup_lhh_by_pid)} starters (lineup_lhh_pct now live)"
            )
        model_projections, bulk_df = mlb_model.predict(
            trained_model, starters, games, lineup_lhh_by_pid=lineup_lhh_by_pid
        )
    else:
        print("  no trained model — using baseline only")
        model_projections = []
        print("  bulk Statcast fetch (for baseline)...")
        bulk_df = mlb_model._fetch_bulk_statcast(et_today())

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
        rows = builder(starters, projection_date=et_today())
        other_prop_rows.extend(rows)
        n = db.upsert_projections(rows)
        print(f"  upserted {n} {label} projections")

    all_pitcher_projections = projections + other_prop_rows

    # name_to_id was seeded above (before the skip check) so the lines fetch
    # can resolve pitcher names regardless of which branch we took. bulk_df is
    # handed to the hitter pipeline for the display-only sweet-spot footer.
    return all_pitcher_projections, name_to_id, n_strikeout, bulk_df


def _run_hitter_pipeline(
    name_to_id: dict[str, int],
    bulk_df: object = None,
    starters: list[dict] | None = None,
) -> tuple[list[dict], int]:
    """Build + upsert hitter prop projections IF lineups have posted.

    Returns (hitter_projections, lineup_player_count). Mutates name_to_id
    in place to add lineup hitters so the lines fetch can resolve them.
    Lineups post ~60-90 min before first pitch; the 8 AM cron typically
    runs before lineups (returns empty list) and the 1 PM cron captures them.

    bulk_df (from the pitcher pipeline) is threaded to _build_and_upsert_hitters
    so the hitter_home_runs rows carry the display-only sweet-spot footer. None
    on refresh runs → sweet-spot is simply skipped for that run. starters (the
    probable pitchers) is threaded too, so the hitter_home_runs rows can carry
    the opposing-starter HR/9 (HR-composite 4th term).
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
    # for hitter_hits) AND the stored player_ids overlap with today's
    # lineup, bail out of the baseline builders. The overlap check is
    # the same stale-detection used in _run_pitcher_pipeline — without it,
    # a prior cron's wrong-slate projections would persist forever once
    # the count threshold was crossed.
    today_str = et_today().strftime("%Y-%m-%d")
    existing_hitter = db.get_projection_count_for_date(today_str, "hitter_hits")
    if existing_hitter >= 100:
        existing_ids = db.get_projection_player_ids_for_date(today_str, "hitter_hits")
        current_ids = {p["player_id"] for p in lineup_players if p.get("player_id")}
        overlap = existing_ids & current_ids
        excess = existing_ids - current_ids
        match_ok = len(overlap) >= max(1, int(0.8 * len(current_ids))) if current_ids else False
        # Hitters churn more than pitchers (bench moves, late scratches),
        # so allow more excess tolerance than the pitcher path's 2.
        clean = len(excess) <= 15
        if match_ok and clean:
            # Even when the bulk is "done", late-posting lineups (West Coast
            # games whose lineups appear after the count crossed 100, between
            # the 2 PM and 9 PM ET crons) leave whole games with NO hitter
            # projections. Build those missing players — and ONLY those — so a
            # skip run still covers newly-posted games. existing_ids is the
            # set already projected (hitter_hits), so anyone in tonight's
            # lineup but not in it is uncovered.
            missing = [
                p for p in lineup_players
                if p.get("player_id") and p["player_id"] not in existing_ids
            ]
            if missing:
                missing_games = {p["game_id"] for p in missing}
                print(
                    f"  {existing_hitter} hitter_hits already exist for {today_str}, "
                    f"but {len(missing)} lineup players across {len(missing_games)} "
                    f"game(s) have no hitter projections — filling those in"
                )
                _build_and_upsert_hitters(missing, bulk_df=bulk_df, starters=starters)
            else:
                print(
                    f"  {existing_hitter} hitter_hits projections already exist for "
                    f"{today_str} -- skipping hitter baseline builders "
                    f"({len(overlap)}/{len(current_ids)} match, {len(excess)} excess)"
                )
            # Return [] so _run_lines_and_edges re-fetches the COMPLETE set
            # from the DB (bulk + any fill-in just upserted), not a partial.
            return [], len(lineup_players)
        print(
            f"  WARNING: stored hitter projections for {today_str} appear stale "
            f"({len(overlap)}/{len(current_ids)} overlap, {len(excess)} excess) "
            f"-- rebuilding"
        )
        # Delete stale rows before rebuild — same reasoning as the pitcher
        # path (composite PK on game_id means UPSERT doesn't replace rows
        # tied to the wrong-slate game_ids).
        db.delete_projections_for_date_props(today_str, db._HITTER_PROP_TYPES)

    hitter_projections, hitter_hit_rows = _build_and_upsert_hitters(
        lineup_players, bulk_df=bulk_df, starters=starters
    )

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


def _build_and_upsert_hitters(
    players: list[dict],
    bulk_df: object = None,
    starters: list[dict] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Run all six hitter prop builders over `players` and upsert each.

    Shared by the full-rebuild path and the targeted fill-in path (a subset
    of lineup players whose games posted late). Returns
    (all_hitter_projections, hitter_hits_rows) — the latter feeds the
    full-path sanity check.

    starters (the probable pitchers, with game_id/home_away) lets each hitter's
    OPPOSING starter HR/9 be attached to the hitter_home_runs rows (HR-composite
    4th term, opp_sp_hr9). Display/ranking-only — never a model input.

    bulk_df (whole-window Statcast) drives the DISPLAY-ONLY sweet-spot footer:
    a rolling 7-day sweet-spot% + avg exit velo per hitter, attached to the
    hitter_home_runs rows so the HR card (and the HR-composite power term) can use
    batted-ball quality. These values never enter the model.

    The frame comes from EITHER the pitcher pipeline's bulk_df (full run, free) OR
    — when that's None (refresh run) — an INDEPENDENT _fetch_bulk_statcast call.
    Decoupling sweet-spot from bulk_df is what makes the power term actually live:
    the first hitter build of the day happens on a refresh run (lineups post after
    the 1 AM full pitcher run), so without the independent fetch the frame never
    reached this step and sweet-spot was skipped every run, every day.
    """
    # Display-only batted-ball quality for the HR-card footer / composite power
    # term. Resolve the Statcast frame, then compute ONCE (covers all hitters);
    # hitters with < 5 batted balls are omitted → footer/power degrade.
    today = et_today()
    player_ids = [p["player_id"] for p in players if p.get("player_id")]
    df = bulk_df
    _have_frame = df is not None and not bool(getattr(df, "empty", False))
    if not _have_frame and player_ids:
        # Refresh run (no full-pitcher bulk_df). Fetch independently — but ONLY
        # when sweet-spot is actually MISSING for these hitters' hitter_home_runs
        # rows (guard c: never refetch to recompute values that already exist).
        # One fetch per run (covers all hitters), pybaseball-cached, try/except
        # so a Statcast flake leaves sweet-spot null (power term degrades).
        have = db.get_players_with_sweet_spot(today.strftime("%Y-%m-%d"))
        need = [pid for pid in player_ids if pid not in have]
        if not need:
            print(
                "  sweet-spot already present for these hitters -- "
                "skipping independent bulk Statcast fetch"
            )
            df = None
        else:
            try:
                print(
                    f"  refresh run: independent bulk Statcast fetch for sweet-spot "
                    f"({len(need)}/{len(player_ids)} hitters missing)..."
                )
                df = mlb_model._fetch_bulk_statcast(today)
            except Exception as exc:
                print(f"  sweet-spot bulk fetch failed ({exc}) -- leaving sweet-spot null")
                df = None

    sweet: dict[int, dict] = {}
    if player_ids and df is not None and not bool(getattr(df, "empty", False)):
        try:
            sweet = sweet_spot.compute_sweet_spot(df, player_ids, today)
            if sweet:
                print(f"  sweet-spot: computed for {len(sweet)} hitters (HR footer)")
        except Exception as exc:
            print(f"  sweet-spot computation skipped ({exc})")
            sweet = {}

    # Opposing-starter HR/9 for the HR-composite 4th term. Each hitter's opposing
    # SP is the OTHER side's probable pitcher; HR/9 is over their last 5 starts
    # (same get_pitcher_starts source as the pitcher props — no Statcast). Computed
    # once per opposing starter (cached), attached to hitter_home_runs rows. NULL
    # when the opp starter is unknown or has no recent starts → composite degrades
    # that term to neutral. NOT a model input.
    opp_hr9: dict[int, float] = {}
    if starters:
        sp_by_game_side = {
            (s["game_id"], s["home_away"]): s["player_id"]
            for s in starters
            if s.get("game_id") is not None and s.get("home_away") and s.get("player_id")
        }
        hr9_cache: dict[int, float | None] = {}
        for p in players:
            gid, ha, pid = p.get("game_id"), p.get("home_away"), p.get("player_id")
            if gid is None or not ha or pid is None:
                continue
            opp_sp_id = sp_by_game_side.get((gid, "away" if ha == "home" else "home"))
            if opp_sp_id is None:
                continue
            if opp_sp_id not in hr9_cache:
                try:
                    hr9_cache[opp_sp_id] = stats.get_pitcher_hr9_last5(
                        opp_sp_id, LOOKBACK_DAYS, today
                    )
                except Exception:
                    hr9_cache[opp_sp_id] = None
            v = hr9_cache[opp_sp_id]
            if v is not None:
                opp_hr9[pid] = v
        if opp_hr9:
            print(f"  opp-SP HR/9: computed for {len(opp_hr9)} hitters (HR composite)")

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
        rows = builder(players, projection_date=today)
        if label == "hitter_hits":
            hitter_hit_rows = rows
        # Attach display/ranking context to the HR rows only (never to the model).
        if label == "hitter_home_runs":
            for r in rows:
                s = sweet.get(r.get("player_id"))
                if s:
                    r["sweet_spot_pct"] = s["sweet_spot_pct"]
                    r["avg_exit_velo"] = s["avg_exit_velo"]
                h9 = opp_hr9.get(r.get("player_id"))
                if h9 is not None:
                    r["opp_sp_hr9"] = h9
        hitter_projections.extend(rows)
        n = db.upsert_projections(rows)
        print(f"  upserted {n} {label} projections")
    return hitter_projections, hitter_hit_rows


def _run_matchup_shadow(starters: list[dict], games: list[dict]) -> None:
    """SHADOW MODE: deterministic matchup-expected-K stored ALONGSIDE the live
    strikeout projection (projections.matchup_expected_k). NEVER changes the
    displayed projection / edge / blend — it's logged only, pending calibration
    validation against actuals (a separate future step that would flip it to
    primary with the rolling average demoted to a light regularizer).

    Needs the OPPOSING posted lineup, so it no-ops on morning runs (no lineup)
    and populates on afternoon/evening runs. The caller wraps this in try/except
    so any flakiness is absorbed — it must never affect the real pipeline.
    """
    from collections import defaultdict

    today = et_today()
    today_str = today.strftime("%Y-%m-%d")

    lineup_players = fetch.fetch_lineups()
    if not lineup_players:
        print("  matchup-K shadow: no posted lineups yet — skipping (NULL stays)")
        return

    by_side: dict[tuple[int, str], list[dict]] = defaultdict(list)
    for b in lineup_players:
        by_side[(b["game_id"], b["home_away"])].append(b)

    starter_ids = [s["player_id"] for s in starters]
    hand = fetch._fetch_handedness_by_id(starter_ids)   # {id: {bats, throws}}
    csw_map = db.get_latest_pitcher_csw(starter_ids)    # {id: recent CSW%}

    updates: list[dict] = []
    name_by_pid = {s["player_id"]: s.get("full_name", s["player_id"]) for s in starters}

    for s in starters:
        pid, gid = s["player_id"], s["game_id"]
        ha = s.get("home_away", "home")
        opp_lineup = by_side.get((gid, "away" if ha == "home" else "home"), [])
        if len({b["batting_order"] for b in opp_lineup}) < 9:
            continue  # opposing lineup not fully posted → leave matchup_expected_k NULL

        # Pitcher stuff — recency-weighted recent K%/PA + expected IP (last 5
        # starts, the recent 2 doubled, matching the project's baseline weights).
        starts = stats.get_pitcher_starts(pid, LOOKBACK_DAYS, today)
        recent = starts[:5]
        w = [2, 2, 1, 1, 1][: len(recent)]
        wK = sum(st["strikeouts"] * wi for st, wi in zip(recent, w))
        wBF = sum(
            (st["outs_recorded"] + st["hits_allowed"] + st["walks"]) * wi
            for st, wi in zip(recent, w)
        )
        recent_k_per_pa = (wK / wBF) if wBF > 0 else None
        expected_ip = (
            sum((st["outs_recorded"] / 3.0) * wi for st, wi in zip(recent, w)) / sum(w)
            if recent else None
        )
        pitcher_hand = (hand.get(pid) or {}).get("throws")
        csw = csw_map.get(pid)

        # Opposing lineup → per-batter recent K%/PA (engine regresses them) + bats.
        lineup_in: list[dict] = []
        for b in sorted(opp_lineup, key=lambda x: x["batting_order"])[:9]:
            games_b = stats.get_hitter_games(b["player_id"], LOOKBACK_DAYS, today)[:15]
            lineup_in.append({
                "slot": b["batting_order"],
                "strikeouts": sum(g["strikeouts"] for g in games_b),
                "plate_appearances": sum(g["plate_appearances"] for g in games_b),
                "bats": b.get("bats"),
            })

        mk = matchup_k.compute_matchup_expected_k(
            csw, recent_k_per_pa, pitcher_hand, expected_ip, lineup_in
        )
        if mk is None:
            continue
        updates.append({
            "game_id": gid, "player_id": pid,
            "projection_date": today_str, "matchup_expected_k": mk,
        })

    if not updates:
        print("  matchup-K shadow: no starters with a fully posted opposing lineup")
        return

    n = db.update_matchup_expected_k(updates)
    print(f"  matchup-K shadow: wrote {n} matchup_expected_k values (shadow only)")

    # Diagnostic: matchup-K vs the live strikeout baseline for a few starters.
    live: dict[int, float] = {}
    try:
        for r in db.get_projections_for_date(today_str):
            if r.get("prop_type") == "strikeouts" and r.get("player_id") is not None:
                live[r["player_id"]] = r.get("projection")
    except Exception:
        pass
    for u in updates[:6]:
        base = live.get(u["player_id"])
        print(
            f"    {name_by_pid.get(u['player_id'])}: matchup-K "
            f"{u['matchup_expected_k']} vs baseline {base}"
        )


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
        today_str = et_today().strftime("%Y-%m-%d")

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
        line_rows = lines.fetch_prop_lines(name_to_id, et_today())
        n_lines = db.upsert_lines(line_rows)
        print(f"  upserted {n_lines} lines across {len(lines.BOOKMAKERS)} bookmakers")

        # CLV capture: record the OPENING line (keep-first, separate table) so
        # closing-line value can be measured later. Fully defensive — a separate
        # table + ignore-duplicates upsert, so it never affects the lines above.
        try:
            n_opens = db.record_line_opens(line_rows)
            if n_opens:
                print(f"  recorded opening-line candidates for {n_opens} rows (keep-first)")
        except Exception as exc:
            print(f"  line-opens capture failed ({exc}) -- skipping (CLV degrades)")

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
        today_str = et_today().strftime("%Y-%m-%d")
        existing = db.get_projections_for_date(today_str)
        all_projections = [{**p, "projection_date": today_str} for p in existing]
        print(
            f"  refresh mode: loaded {len(all_projections)} existing projections "
            f"for calibration"
        )

    print("Computing calibration confidence scores...")
    since = (et_today() - timedelta(days=60)).strftime("%Y-%m-%d")
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
    today = et_today()
    for days_ahead in (1, 2, 3):
        future_date = today + timedelta(days=days_ahead)
        date_str = future_date.strftime("%Y-%m-%d")
        try:
            games = fetch.fetch_games(date_str)
            if not games:
                print(f"  future preview {date_str}: no games found")
                continue

            # IMPORTANT: upsert players BEFORE games. games.home_starter_id
            # and games.away_starter_id are FK columns referencing
            # players(player_id), so inserting a games row with a starter
            # id that isn't yet in `players` violates the FK constraint.
            # _setup_games_and_pitchers() (the main-pipeline path) already
            # does this in the correct order — same order here keeps the
            # future-preview path consistent.
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
            db.upsert_games(games)
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
        # tz-aware UTC (the naive utc-now helper is deprecated). strftime has no
        # %z, so the rendered log string is byte-identical to before.
        print(f"=== pipeline run {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC ===")

        # Mode header: with six crons/day, only the first run of the day
        # builds projections. Subsequent runs detect existing rows and
        # skip straight to lines + edges + calibration.
        today_str = et_today().strftime("%Y-%m-%d")
        proj_count = db.get_projection_count_for_date(today_str)
        is_refresh = proj_count >= 20
        print(
            f"  mode: {'lines-only refresh' if is_refresh else 'full projection'}"
        )
        print(f"  existing projections for today: {proj_count}")

        _grade_previous_slate()
        games, starters = _setup_games_and_pitchers()

        # DISPLAY-ONLY: today's wind onto the games table for the HR-card wind
        # tag. Decorative + external-API-dependent, so any failure is absorbed
        # and never touches projections.
        print("Fetching game-time weather (HR wind tag)...")
        try:
            _run_game_weather(games)
        except Exception as exc:
            print(f"  game weather failed ({exc}) -- skipping (wind tag degrades)")

        # Opposing-lineup handedness for the strikeouts model — fetched BEFORE
        # the pitcher pipeline so predict() can use the real lineup_lhh_pct when
        # lineups are posted ({} on morning runs → 0.42 fallback).
        lineup_lhh_by_pid = _opposing_lineup_lhh(starters)
        pitcher_projections, name_to_id, n_strikeout, bulk_df = _run_pitcher_pipeline(
            starters, games, lineup_lhh_by_pid=lineup_lhh_by_pid
        )
        # bulk_df → sweet-spot footer; starters → opposing-SP HR/9 (composite term).
        hitter_projections, lineup_count = _run_hitter_pipeline(
            name_to_id, bulk_df=bulk_df, starters=starters
        )
        all_projections = pitcher_projections + hitter_projections

        # SHADOW: matchup-expected-K (logged onto strikeouts rows, never the
        # live projection). Decorative + experimental, so any failure is
        # absorbed and never touches the real pipeline.
        print("Computing matchup-expected-K (shadow)...")
        try:
            _run_matchup_shadow(starters, games)
        except Exception as exc:
            print(f"  matchup-K shadow failed ({exc}) -- skipping")

        # LOG-ONLY daily scorecard: does the shadow matchup-K beat the baseline
        # yet? Prints a FLIP-READY verdict so the validate-then-flip decision is
        # data-driven. NEVER changes the live projection and NEVER auto-flips.
        # Full run only (once/day, after yesterday graded) to avoid 7x/day reads.
        if not is_refresh:
            print("Scoring shadow matchup-K vs baseline (log-only)...")
            try:
                import matchup_k_scorecard
                matchup_k_scorecard.log_scorecard()
            except Exception as exc:
                print(f"  matchup-K scorecard failed ({exc}) -- skipping")

            # CLV (closing-line value): does the market move toward the model's
            # side? Log-only, read-only — the leading proof-of-edge metric.
            print("Scoring closing-line value (log-only)...")
            try:
                import clv_scorecard
                clv_scorecard.log_scorecard()
            except Exception as exc:
                print(f"  CLV scorecard failed ({exc}) -- skipping")

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
