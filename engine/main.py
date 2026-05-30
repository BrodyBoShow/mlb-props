"""Pipeline entrypoint: fetch the slate, project, then upsert to Supabase.

Logs to stdout only (GitHub Actions captures it). Never writes log rows
to the database.
"""

import baseline
import db
import fetch


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

    print("Building baseline strikeout projections...")
    projections = baseline.build_strikeout_projections(starters)

    print("Upserting projections...")
    n_proj = db.upsert_projections(projections)
    print(f"  upserted {n_proj} projections")

    print("Done.")


if __name__ == "__main__":
    main()
