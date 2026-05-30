"""Pipeline entrypoint: fetch the slate, then upsert it to Supabase.

Logs to stdout only (GitHub Actions captures it). Never writes log rows
to the database.
"""

import fetch
import db


def main() -> None:
    print("Fetching today's games...")
    games = fetch.fetch_games()
    print(f"  fetched {len(games)} games")

    print("Fetching probable pitchers...")
    players = fetch.fetch_probable_pitchers()
    print(f"  fetched {len(players)} players")

    # Players first — games reference nothing, but projections will reference
    # both, so keep the reference tables populated together.
    print("Upserting players...")
    n_players = db.upsert_players(players)
    print(f"  upserted {n_players} players")

    print("Upserting games...")
    n_games = db.upsert_games(games)
    print(f"  upserted {n_games} games")

    print("Done.")


if __name__ == "__main__":
    main()
