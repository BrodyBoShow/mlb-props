import os
import statsapi
from dotenv import load_dotenv

# 1. Load the environment variables from your root .env file
load_dotenv(dotenv_path="../.env")


def test_pipeline():
    print("--- Pipeline Configuration Check ---")
    print(f"Supabase URL loaded: {bool(os.getenv('SUPABASE_URL'))}")
    print(f"Parlay API Key loaded: {bool(os.getenv('PARLAY_API_KEY'))}")
    print("------------------------------------\n")

    print("Fetching today's live MLB schedule...")
    try:
        # 2. Call the official MLB API to grab today's matchups
        schedule = statsapi.schedule()

        if not schedule:
            print("No games scheduled for today or data is temporarily unavailable.")
            return

        print(f"Success! Found {len(schedule)} games today:\n")
        # Print just the first 5 games so we don't spam the terminal
        for game in schedule[:5]:
            game_id = game.get('game_id')
            away = game.get('away_name')
            home = game.get('home_name')

            print(f"[{game_id}] {away} @ {home}")

    except Exception as e:
        print(f"Error fetching MLB data: {e}")


if __name__ == "__main__":
    test_pipeline()
