"""Betting-line fetch layer — ParlayAPI. No DB code lives here.

Pulls pitcher prop lines for the slate and shapes them for the `lines` table.
Per CLAUDE.md, betting lines are the most fragile data source, so this layer
is defensive: any failure prints to stdout and returns [] — the projection
pipeline keeps running untouched.

Reads PARLAY_API_KEY from the environment (via python-dotenv).
"""

import os
from datetime import date

from dotenv import load_dotenv

# Import defensively: betting lines must never break the projection pipeline.
# main.py imports this module unconditionally, so a missing parlay-api package
# (e.g. local dev without it installed) must not crash the run. CI installs the
# real package from requirements.txt.
try:
    from parlay_api import ParlayAPI
except ImportError:
    ParlayAPI = None

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


# Our prop_type -> ParlayAPI market key.
PROP_TO_MARKET = {
    "strikeouts":    "player_strikeouts",
    "hits_allowed":  "player_hits_allowed",
    "walks":         "player_walks",
    "earned_runs":   "player_earned_runs",
    "outs_recorded": "player_pitcher_outs",
}
MARKET_TO_PROP = {v: k for k, v in PROP_TO_MARKET.items()}

# Sharp baseline (pinnacle) + major US books + main DFS apps.
BOOKMAKERS = ["pinnacle", "draftkings", "fanduel",
              "prizepicks", "underdog", "betr", "sleeper"]


def fetch_pitcher_lines(
    name_to_id: dict[str, int],   # full_name -> player_id, built from starters
    game_date: date,
) -> list[dict]:
    """Fetch all 5 pitcher prop markets in one ParlayAPI call.

    Keeps only rows whose `player` exactly matches a starter we projected,
    maps the market key back to our prop_type, and shapes each row for the
    `lines` table. On any API error, prints and returns [] so the pipeline
    continues (betting lines never break projections).
    """
    if ParlayAPI is None:
        print("  parlay-api package not installed -- skipping line ingestion")
        return []

    api_key = os.getenv("PARLAY_API_KEY")
    if not api_key:
        print("  PARLAY_API_KEY not set -- skipping line ingestion")
        return []

    try:
        client = ParlayAPI(api_key=api_key)
        raw = client.props(
            "baseball_mlb",
            markets=list(PROP_TO_MARKET.values()),
            bookmakers=BOOKMAKERS,
        )
    except Exception as exc:
        print(f"  ParlayAPI fetch failed: {exc} -- skipping line ingestion")
        return []

    game_date_str = game_date.strftime("%Y-%m-%d")
    rows: list[dict] = []
    per_prop: dict[str, int] = {p: 0 for p in PROP_TO_MARKET}

    for r in raw or []:
        player_name = r.get("player")
        player_id = name_to_id.get(player_name)
        if player_id is None:
            continue   # not a starter we projected today

        prop_type = MARKET_TO_PROP.get(r.get("market_key"))
        if prop_type is None:
            continue   # a market we don't track

        bookmaker = r.get("bookmaker")
        line = r.get("line")
        if bookmaker is None or line is None:
            continue   # both are NOT NULL in the schema

        rows.append({
            "player_id":   player_id,
            "player_name": player_name,
            "prop_type":   prop_type,
            "bookmaker":   bookmaker,
            "line":        line,
            "over_price":  r.get("over_price"),
            "under_price": r.get("under_price"),
            "game_date":   game_date_str,
        })
        per_prop[prop_type] += 1

    # Deduplicate: keep one row per (player_id, prop_type, bookmaker, game_date)
    # ParlayAPI returns main + alt lines — keep the first (main line).
    seen: set[tuple] = set()
    deduped: list[dict] = []
    for r in rows:
        key = (r["player_id"], r["prop_type"], r["bookmaker"], r["game_date"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    rows = deduped

    summary = ", ".join(f"{p}: {n}" for p, n in per_prop.items())
    print(f"  fetched {len(rows)} lines ({summary})")
    return rows
