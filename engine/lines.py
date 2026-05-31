"""Betting-line fetch layer — ParlayAPI. No DB code lives here.

Pulls pitcher prop lines for the slate and shapes them for the `lines` table.
Per CLAUDE.md, betting lines are the most fragile data source, so this layer
is defensive: any failure prints to stdout and returns [] — the projection
pipeline keeps running untouched.

Reads PARLAY_API_KEY from the environment (via python-dotenv).
"""

import os
import unicodedata
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


# Our prop_type -> ParlayAPI market key. Pitcher props + hitter props.
PROP_TO_MARKET = {
    # pitcher
    "strikeouts":    "player_strikeouts",
    "hits_allowed":  "player_hits_allowed",
    "walks":         "player_walks",
    "earned_runs":   "player_earned_runs",
    "outs_recorded": "player_pitcher_outs",
    # hitter
    "hitter_hits":        "player_hits",
    "hitter_total_bases": "player_total_bases",
    "hitter_rbis":        "player_rbis",
    "hitter_runs":        "player_runs",
    "hitter_home_runs":   "player_home_runs",
    # PrizePicks-exclusive fantasy score props (Phase 0 confirmed prizepicks
    # is the sole book listing either). The PrizePicks-only restriction is
    # enforced below in fetch_prop_lines, not by including/excluding books
    # here — the books list is the universe we query for the OTHER props.
    "pitcher_fantasy_score": "player_pitcher_fantasy_score",
    "hitter_fantasy_score":  "player_hitter_fantasy_score",
}
MARKET_TO_PROP = {v: k for k, v in PROP_TO_MARKET.items()}

# Prop types that are scored against PrizePicks only — any line on any other
# book for these props is dropped on ingest, no matter what ParlayAPI returns.
# This is a hard contract: fantasy-score lines from any other book would be
# meaningless because the scoring formula is PrizePicks-specific.
PRIZEPICKS_ONLY_PROPS = {"pitcher_fantasy_score", "hitter_fantasy_score"}

# Sharp baseline (pinnacle) + major US books + main DFS apps.
BOOKMAKERS = ["pinnacle", "draftkings", "fanduel",
              "prizepicks", "underdog", "betr", "sleeper"]

# Name suffixes to strip when normalizing. Lower-case with leading space.
_SUFFIXES = (" jr.", " sr.", " ii", " iii", " iv")


def _normalize(name: str) -> str:
    """Canonical form for fuzzy player-name matching.

    1. Lowercase.
    2. Strip accents (NFD decomposition, drop combining characters).
    3. Remove common name suffixes (Jr., Sr., II, III, IV).
    4. Collapse extra whitespace.

    Uses only the Python standard library (unicodedata is built-in).
    """
    # Lowercase first so suffix stripping is case-insensitive.
    s = name.lower()
    # Strip accents: decompose to NFD, drop combining (non-ASCII) chars.
    s = "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )
    # Remove suffixes in order (longest first to avoid partial matches).
    for suffix in _SUFFIXES:
        if s.endswith(suffix):
            s = s[: -len(suffix)]
            break   # only strip one suffix per name
    return " ".join(s.split())   # collapse extra whitespace


def fetch_prop_lines(
    name_to_id: dict[str, int],   # full_name -> player_id (pitchers + hitters)
    game_date: date,
) -> list[dict]:
    """Fetch all pitcher + hitter prop markets in one ParlayAPI call.

    name_to_id covers both projected starters and confirmed lineup hitters.
    Tries an exact name match first, then a normalized fallback (strips
    accents, suffixes, extra whitespace) before skipping a row. Maps the
    market key back to our prop_type and shapes each row for the `lines`
    table. On any API error, prints and returns [] so the pipeline
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

    # Build a normalized lookup alongside the exact one so we only pay the
    # normalization cost once per key in name_to_id, not once per API row.
    normalized_to_id = {_normalize(k): v for k, v in name_to_id.items()}

    rows: list[dict] = []
    per_prop: dict[str, int] = {p: 0 for p in PROP_TO_MARKET}
    normalized_matches = 0
    pp_only_dropped = 0   # diagnostic: lines dropped by the PrizePicks-only rule

    for r in raw or []:
        player_name = r.get("player")

        # 1. Exact match (fast path — no allocation).
        player_id = name_to_id.get(player_name)

        # 2. Normalized fallback: strips accents, suffixes, extra whitespace.
        if player_id is None and player_name:
            player_id = normalized_to_id.get(_normalize(player_name))
            if player_id is not None:
                normalized_matches += 1

        if player_id is None:
            continue   # not a player we projected today

        # ParlayAPI does substring matching on the markets parameter, so a
        # request for hitter_fantasy_score returns inning-specific variants
        # too (player_2nd_inning_hitter_fantasy_score, etc.). MARKET_TO_PROP
        # is an exact map, so a market_key we don't recognize gets dropped
        # here — partial-game variants can never sneak through.
        prop_type = MARKET_TO_PROP.get(r.get("market_key"))
        if prop_type is None:
            continue   # a market we don't track (incl. inning variants)

        bookmaker = r.get("bookmaker")
        line = r.get("line")
        if bookmaker is None or line is None:
            continue   # both are NOT NULL in the schema

        # PrizePicks-exclusive prop_types: drop any line from any other book.
        # Phase 0 probe confirmed PrizePicks is the sole listing today, but
        # if a different book ever picks them up we still ignore those rows.
        if prop_type in PRIZEPICKS_ONLY_PROPS and bookmaker != "prizepicks":
            pp_only_dropped += 1
            continue

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

    norm_note = f" [{normalized_matches} via normalized match]" if normalized_matches else ""
    pp_note = f" [{pp_only_dropped} non-PrizePicks fantasy lines dropped]" if pp_only_dropped else ""
    summary = ", ".join(f"{p}: {n}" for p, n in per_prop.items())
    print(f"  fetched {len(rows)} lines ({summary}){norm_note}{pp_note}")
    return rows
