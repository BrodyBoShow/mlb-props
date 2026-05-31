"""Pipeline entrypoint: fetch the slate, project, then upsert to Supabase.

Blend strategy:
  - If player_game_logs has enough data: train XGBoost each run, blend
    60% model + 40% baseline per pitcher.
  - If train() returns None (insufficient data): baseline only.

Pybaseball cache is enabled up front so baseline and model share cached
Statcast responses for the same pitcher/date range — halves API calls.

Logs to stdout only (GitHub Actions captures it). Never writes log rows to the DB.
"""

import traceback
from datetime import date

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

MODEL_WEIGHT = 0.6
BASELINE_WEIGHT = 0.4


def _blend(base_rows: list[dict], model_rows: list[dict]) -> list[dict]:
    """Weighted average of model and baseline projections.

    Pitchers that only appear in one source keep that source's projection unchanged.
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
                MODEL_WEIGHT * model_map[key] + BASELINE_WEIGHT * r["projection"], 1
            )
            blended.append({**r, "projection": proj})
            blended_count += 1
        else:
            blended.append(r)  # model had no prediction → keep baseline as-is
    print(f"  blended {blended_count} pitchers (60% model / 40% baseline); "
          f"{len(base_rows) - blended_count} baseline-only")
    return blended


def main() -> None:
    try:
        # ── grade yesterday before projecting today ───────────────────────────
        print("Grading yesterday's pitcher projections...")
        game_logs = grade.grade_yesterday()
        n_logs = db.upsert_game_logs(game_logs)
        print(f"  upserted {n_logs} pitcher game log rows")

        print("Grading yesterday's hitter projections...")
        hitter_logs = grade.grade_hitters_yesterday()
        n_hlogs = db.upsert_game_logs(hitter_logs)
        print(f"  upserted {n_hlogs} hitter game log rows")

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

        # ── baseline ──────────────────────────────────────────────────────────
        print("Building baseline strikeout projections...")
        base_projections = baseline.build_strikeout_projections(starters)
        print(f"  baseline: {len(base_projections)} projections")

        # ── XGBoost layer ───────────────────────────────────────────────────────
        print("Training XGBoost (no-ops if insufficient data)...")
        trained_model = mlb_model.train()

        if trained_model is not None:
            print("Running XGBoost predictions...")
            model_projections = mlb_model.predict(trained_model, starters, games)
            print("Blending baseline + model projections...")
            projections = _blend(base_projections, model_projections)
        else:
            print("  no trained model — using baseline only")
            projections = base_projections

        # ── upsert strikeout projections ──────────────────────────────────────
        print("Upserting strikeout projections...")
        n_proj = db.upsert_projections(projections)
        print(f"  upserted {n_proj} strikeout projections")

        # Sanity check: a normal slate has 28-32 starters. Fewer than 20
        # strikeout projections means fetch_starters()/lookup_player() is
        # silently dropping pitchers — surface it without crashing.
        if len(projections) < 20:
            print(f"  WARNING: only {len(projections)} strikeout projections — "
                  f"expected 25+. Check fetch_starters() and lookup_player().")

        # ── additional prop types (MLB Stats API game-log baseline) ───────────
        other_prop_rows: list[dict] = []
        for builder, label in [
            (baseline.build_hits_allowed_projections, "hits_allowed"),
            (baseline.build_walks_projections, "walks"),
            (baseline.build_earned_runs_projections, "earned_runs"),
            (baseline.build_outs_recorded_projections, "outs_recorded"),
        ]:
            print(f"Building {label} projections...")
            rows = builder(starters)
            other_prop_rows.extend(rows)
            n = db.upsert_projections(rows)
            print(f"  upserted {n} {label} projections")

        all_projections = projections + other_prop_rows

        # name_to_id seeds with pitchers; hitters are added below if lineups posted.
        name_to_id = {s["full_name"]: s["player_id"] for s in starters if s.get("full_name")}

        # ── hitter props (requires confirmed lineups; graceful skip otherwise) ─
        # Lineups post ~60-90 min before first pitch. The 8 AM cron typically
        # runs before lineups -> skip; the 1 PM cron captures them.
        print("Fetching lineup players...")
        lineup_players = fetch.fetch_lineups()
        if not lineup_players:
            print("  no confirmed lineups yet — skipping hitter props")
        else:
            print(f"  {len(lineup_players)} lineup players confirmed")
            db.upsert_players([
                {k: v for k, v in p.items()
                 if k in ("player_id", "full_name", "team", "position", "bats", "throws")}
                for p in lineup_players
            ])
            hitter_hit_rows: list[dict] = []
            for builder, label in [
                (baseline.build_hitter_hits_projections,        "hitter_hits"),
                (baseline.build_hitter_total_bases_projections, "hitter_total_bases"),
                (baseline.build_hitter_rbis_projections,        "hitter_rbis"),
                (baseline.build_hitter_runs_projections,        "hitter_runs"),
                (baseline.build_hitter_home_runs_projections,   "hitter_home_runs"),
            ]:
                print(f"Building {label} projections...")
                rows = builder(lineup_players)
                if label == "hitter_hits":
                    hitter_hit_rows = rows
                all_projections.extend(rows)
                n = db.upsert_projections(rows)
                print(f"  upserted {n} {label} projections")

            # Sanity check: a full slate of confirmed lineups yields 200+ hitter
            # projections (18 batters/game x ~15 games). Far fewer means
            # fetch_lineups() is dropping players — surface it without crashing.
            if len(hitter_hit_rows) < 100:
                print(f"  WARNING: only {len(hitter_hit_rows)} hitter projections — "
                      f"expected 200+. Check fetch_lineups().")

            # Include hitters in the line fetch so edges cover them too.
            hitter_name_to_id = {
                p["full_name"]: p["player_id"]
                for p in lineup_players if p.get("full_name")
            }
            name_to_id.update(hitter_name_to_id)

        # ── betting lines + edges (most fragile source — fully isolated) ───────
        # Per CLAUDE.md, betting data must never break projections. This whole
        # block is wrapped so any flakiness (API down, a missing lines/edges
        # table before its migration is run) logs and continues to Done.
        try:
            print("Fetching prop lines from ParlayAPI...")
            line_rows = lines.fetch_prop_lines(name_to_id, date.today())
            n_lines = db.upsert_lines(line_rows)
            print(f"  upserted {n_lines} lines across {len(lines.BOOKMAKERS)} bookmakers")

            print("Computing edges...")
            all_lines = db.get_lines_for_date(date.today().strftime("%Y-%m-%d"))
            edge_rows = edge.compute_edges(all_projections, all_lines)
            n_edges = db.upsert_edges(edge_rows)
            print(f"  computed {n_edges} edges")
        except Exception as exc:
            print(f"  betting layer failed ({exc}) -- skipping lines/edges, projections unaffected")

        # ── calibration confidence scores ─────────────────────────────────────
        print("Computing calibration confidence scores...")
        logs = db.get_game_logs() or []
        confidence_rows = calibrate.compute_confidences(all_projections, logs)
        n_conf = db.update_confidences(confidence_rows)
        print(f"  updated {n_conf} confidence scores")

        print("Done.")
    except Exception:
        # Surface the full traceback to stdout (Actions captures it) and let the
        # run fail — a failed Actions run emails a notification automatically.
        print("PIPELINE FAILED:")
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
