"""Pipeline entrypoint: fetch the slate, project, then upsert to Supabase.

Blend strategy:
  - If player_game_logs has enough data: train XGBoost each run, blend
    60% model + 40% baseline per pitcher.
  - If train() returns None (insufficient data): baseline only.

Pybaseball cache is enabled up front so baseline and model share cached
Statcast responses for the same pitcher/date range — halves API calls.

Logs to stdout only (GitHub Actions captures it). Never writes log rows to the DB.
"""

import pybaseball

pybaseball.cache.enable()

import baseline
import db
import fetch
import grade
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
    # ── grade yesterday before projecting today ───────────────────────────────
    print("Grading yesterday's projections...")
    game_logs = grade.grade_yesterday()
    n_logs = db.upsert_game_logs(game_logs)
    print(f"  upserted {n_logs} game log rows")

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

    # ── baseline ──────────────────────────────────────────────────────────────
    print("Building baseline strikeout projections...")
    base_projections = baseline.build_strikeout_projections(starters)
    print(f"  baseline: {len(base_projections)} projections")

    # ── XGBoost layer ─────────────────────────────────────────────────────────
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

    # ── upsert ────────────────────────────────────────────────────────────────
    print("Upserting projections...")
    n_proj = db.upsert_projections(projections)
    print(f"  upserted {n_proj} projections")

    print("Done.")


if __name__ == "__main__":
    main()
