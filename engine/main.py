"""Pipeline entrypoint: fetch the slate, project, then upsert to Supabase.

Blend strategy:
  - If model.pkl exists: 60% XGBoost + 40% baseline per pitcher.
  - If model.pkl is absent or a pitcher has no model prediction: baseline only.
Training attempt runs each time; it no-ops until player_game_logs has >= 50 rows.

Logs to stdout only (GitHub Actions captures it). Never writes log rows to the DB.
"""

import baseline
import db
import fetch
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
    mlb_model.train(db._client())

    print("Running XGBoost predictions...")
    model_projections = mlb_model.predict(starters, games)

    # ── blend ─────────────────────────────────────────────────────────────────
    if model_projections:
        print("Blending baseline + model projections...")
        projections = _blend(base_projections, model_projections)
    else:
        print("  no model predictions available — using baseline only")
        projections = base_projections

    # ── upsert ────────────────────────────────────────────────────────────────
    print("Upserting projections...")
    n_proj = db.upsert_projections(projections)
    print(f"  upserted {n_proj} projections")

    print("Done.")


if __name__ == "__main__":
    main()
