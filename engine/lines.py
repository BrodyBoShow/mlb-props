"""Betting-line fetch layer — ParlayAPI. No DB code lives here.

Pulls pitcher prop lines for the slate and shapes them for the `lines` table.
Per CLAUDE.md, betting lines are the most fragile data source, so this layer
is defensive: any failure prints to stdout and returns [] — the projection
pipeline keeps running untouched.

Reads PARLAY_API_KEY from the environment (via python-dotenv).
"""

import json
import os
import unicodedata
import urllib.error
import urllib.request
from datetime import date
from typing import TYPE_CHECKING

from dotenv import load_dotenv

if TYPE_CHECKING:
    from schemas import LineRow

# Import defensively: betting lines must never break the projection pipeline.
# main.py imports this module unconditionally, so a missing parlay-api package
# (e.g. local dev without it installed) must not crash the run. CI installs the
# real package from requirements.txt.
try:
    from parlay_api import ParlayAPI
except ImportError:
    ParlayAPI = None

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


# REQUEST keys -- one per prop_type, sent as the `markets` parameter to
# ParlayAPI. ParlayAPI substring-matches this against its internal catalog
# so the request key doesn't have to equal the response market_key.
PROP_TO_MARKET = {
    # pitcher
    "strikeouts":    "player_strikeouts",
    "hits_allowed":  "player_hits_allowed",
    "walks":         "player_walks",
    "earned_runs":   "player_earned_runs",
    "outs_recorded": "player_pitcher_outs",
    "pitcher_first_inning_pitches": "player_first_inning_pitches",
    "pitcher_first_inning_strikeouts": "player_1st_inning_pitcher_strikeouts",
    # hitter
    "hitter_hits":        "player_hits",
    "hitter_total_bases": "player_total_bases",
    "hitter_hits_runs_rbis": "player_hits_runs_rbis",
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

# RESPONSE keys -- the values of `market_key` in the rows ParlayAPI returns.
# Multiple response keys can map to the same prop_type because ParlayAPI
# normalizes some markets differently from the request. Anything NOT in this
# map is dropped (which includes alt/milestone/inning variants we don't want).
#
# Discovered via the engine/_probe_keys.py probe (2026-05-31). The OUTS map
# below is the one that was broken: requesting 'player_pitcher_outs' returns
# rows with market_key='player_outs' or 'player_pitching_outs', neither of
# which was previously accepted -- all 14 daily outs lines were getting
# dropped silently.
MARKET_TO_PROP = {
    # pitcher
    "player_strikeouts":            "strikeouts",
    "player_pitcher_strikeouts":    "strikeouts",
    "player_hits_allowed":          "hits_allowed",
    "player_walks":                 "walks",
    "player_walks_allowed":         "walks",
    "player_earned_runs":           "earned_runs",
    "player_earned_runs_allowed":   "earned_runs",
    "player_outs":                  "outs_recorded",
    "player_pitching_outs":         "outs_recorded",
    # First-inning pitches. The exact response key ParlayAPI returns isn't yet
    # confirmed (the prop is intermittently posted, mostly by PrizePicks closer
    # to first pitch), so several plausible variants are mapped; the lines.py
    # diagnostic prints any unmapped market_key so the real one can be confirmed
    # from the cron log and pruned here.
    "player_first_inning_pitches":      "pitcher_first_inning_pitches",
    "player_1st_inning_pitches":        "pitcher_first_inning_pitches",
    "player_pitches_thrown_1st_inning": "pitcher_first_inning_pitches",
    "player_first_inning_pitches_thrown": "pitcher_first_inning_pitches",
    # 1st-inning strikeouts — confirmed real ParlayAPI market (from the cron log's
    # market_keys diagnostic). Two-sided book line, so it grades lean-vs-line.
    "player_1st_inning_pitcher_strikeouts": "pitcher_first_inning_strikeouts",
    # hitter
    "player_hits":         "hitter_hits",
    "player_total_bases":  "hitter_total_bases",
    "player_hits_runs_rbis": "hitter_hits_runs_rbis",
    "player_hits_runs_rbis_thrown": "hitter_hits_runs_rbis",
    "player_hits_+_runs_+_rbis": "hitter_hits_runs_rbis",
    "player_rbis":         "hitter_rbis",
    "player_runs":         "hitter_runs",
    "player_home_runs":    "hitter_home_runs",
    # PrizePicks-only fantasy
    "player_pitcher_fantasy_score": "pitcher_fantasy_score",
    "player_hitter_fantasy_score":  "hitter_fantasy_score",
}

# Prop types that are scored against PrizePicks only — any line on any other
# book for these props is dropped on ingest, no matter what ParlayAPI returns.
# This is a hard contract: fantasy-score lines from any other book would be
# meaningless because the scoring formula is PrizePicks-specific.
PRIZEPICKS_ONLY_PROPS = {"pitcher_fantasy_score", "hitter_fantasy_score"}

# Sharp baseline (pinnacle) + major US books + main DFS apps. Books that
# ParlayAPI doesn't actually list for a given market are silently no-ops on
# the API side, so widening this list only costs response bytes — there's no
# per-book quota or rate-limit hit. The wider the list, the better our
# coverage when DK/FD don't post a particular prop.
#
# Removed after the engine/_probe_books.py diagnostic (1804 raw rows across
# all 12 markets): betmgm, espnbet, pointsbet returned 0 rows on every
# market we ingest. ParlayAPI accepts the names without erroring but
# returns nothing for them on MLB props — most likely a tier/availability
# limit, not a name-aliasing bug. Re-add if a future probe shows coverage.
BOOKMAKERS = [
    "pinnacle",
    "draftkings",
    "fanduel",
    "caesars",
    "bet365",
    "prizepicks",
    "underdog",
    "betr",
    "sleeper",
]

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


# PrizePicks' own projections API returns each fantasy line tagged with
# odds_type ('standard' | 'goblin' | 'demon') — the discriminator ParlayAPI
# strips when it normalizes DFS payouts. We read the STANDARD rung directly so
# the stored fantasy line is the real PrizePicks line, not a random alt rung.
_PP_STAT_TO_PROP = {
    "Hitter Fantasy Score":  "hitter_fantasy_score",
    "Pitcher Fantasy Score": "pitcher_fantasy_score",
}


def _pp_prop_for_stat(stat_type: str | None) -> str | None:
    """Map a PrizePicks stat_type to our prop_type.

    Exact map for the fantasy props, plus a FLEXIBLE match for the 1st-inning
    pitch-count prop: PrizePicks posts it late and we haven't seen its exact
    label (the sibling 'pitcher allows a 1st-inning run' shows as '1st Inning
    Runs Allowed'), so we match any '1st inning ... pitch(es)' stat_type that
    isn't the runs/strikeout variant. The cron log prints the exact label the
    first time it's captured so the mapping can be pinned if needed.
    """
    if stat_type in _PP_STAT_TO_PROP:
        return _PP_STAT_TO_PROP[stat_type]
    s = (stat_type or "").lower()
    if "1st inning" in s and "pitch" in s and "run" not in s and "strikeout" not in s:
        return "pitcher_first_inning_pitches"
    return None
_PP_PROJECTIONS_URL = "https://api.prizepicks.com/projections?league_id=2&per_page=1000"

# Realistic browser headers — a free attempt to defeat a header-based block.
# Likely insufficient against Cloudflare's IP block on datacenter ranges (that's
# what PRIZEPICKS_PROXY_URL is for), but cheap and harmless.
_PP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://app.prizepicks.com",
    "Referer": "https://app.prizepicks.com/",
}


def _fetch_prizepicks_standard_fantasy(
    name_to_id: dict[str, int],
    normalized_to_id: dict[str, int],
) -> dict[tuple[int, str], float]:
    """Fetch PrizePicks STANDARD fantasy-score lines straight from PrizePicks.

    Returns {(player_id, prop_type): standard_line} for players we can match to
    name_to_id. Free (no ParlayAPI credits) and DETERMINISTIC — filters to
    odds_type == 'standard', so there's no goblin/demon alt-line ambiguity.

    Fully defensive: any failure (network, Cloudflare block on a datacenter IP,
    shape change) prints and returns {}, and fetch_prop_lines falls back to the
    ParlayAPI ladder + the db.py median accumulation. PrizePicks is behind
    Cloudflare and MAY block GitHub Actions IPs.

    Proxy: when PRIZEPICKS_PROXY_URL (http://user:pass@host:port) is set, ONLY
    this request is routed through it (a dedicated opener, NOT a global proxy —
    other urllib traffic is unaffected) so authentic standard lines work from a
    CI datacenter IP. When unset, behaves exactly as a direct request.
    """
    out: dict[tuple[int, str], float] = {}
    seen_inning_stats: set[str] = set()   # exact PrizePicks labels we matched

    # Dedicated opener so the proxy (if any) applies ONLY here, never globally.
    proxy_url = os.getenv("PRIZEPICKS_PROXY_URL")
    opener = (
        urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        )
        if proxy_url
        else None
    )
    via = "via proxy" if proxy_url else "(direct)"

    def _open(req):
        return (opener.open(req, timeout=20) if opener
                else urllib.request.urlopen(req, timeout=20))

    try:
        page = 1
        total_pages = 1
        while page <= total_pages and page <= 20:
            url = f"{_PP_PROJECTIONS_URL}&page={page}"
            req = urllib.request.Request(url, headers=_PP_HEADERS)
            with _open(req) as resp:
                data = json.load(resp)

            total_pages = (data.get("meta", {}) or {}).get("total_pages", 1) or 1

            # included[] carries new_player rows: id -> display_name.
            pp_players = {
                inc["id"]: (inc.get("attributes", {}) or {}).get("display_name")
                for inc in data.get("included", [])
                if inc.get("type") == "new_player"
            }

            for d in data.get("data", []):
                a = d.get("attributes", {}) or {}
                if a.get("odds_type") != "standard":
                    continue
                prop_type = _pp_prop_for_stat(a.get("stat_type"))
                if prop_type is None:
                    continue
                if prop_type == "pitcher_first_inning_pitches":
                    seen_inning_stats.add(a.get("stat_type") or "")
                line = a.get("line_score")
                if line is None:
                    continue
                try:
                    pp_pid = d["relationships"]["new_player"]["data"]["id"]
                except (KeyError, TypeError):
                    continue
                nm = pp_players.get(pp_pid)
                if not nm:
                    continue
                player_id = name_to_id.get(nm)
                if player_id is None:
                    player_id = normalized_to_id.get(_normalize(nm))
                if player_id is None:
                    continue
                out[(player_id, prop_type)] = float(line)

            page += 1
    except urllib.error.HTTPError as exc:
        print(
            f"  PrizePicks-direct unavailable (HTTP {exc.code}) {via} -- "
            f"ladder/median fallback"
        )
        return {}
    except Exception as exc:
        print(
            f"  PrizePicks-direct unavailable ({exc}) {via} -- "
            f"ladder/median fallback"
        )
        return {}

    print(f"  PrizePicks-direct standard {via}: {len(out)} lines")
    if seen_inning_stats:
        print(f"    captured 1st-inning-pitches lines (PrizePicks label{'s' if len(seen_inning_stats) > 1 else ''}: "
              f"{', '.join(sorted(seen_inning_stats))})")
    return out


def fetch_prop_lines(
    name_to_id: dict[str, int],   # full_name -> player_id (pitchers + hitters)
    game_date: date,
) -> list["LineRow"]:
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

    # Deduplicate: keep one row per (player_id, prop_type, bookmaker, game_date).
    # For non-fantasy props ParlayAPI returns main + alt lines and the first is
    # the main line. For the two PrizePicks fantasy props the API returns a
    # RANDOM rung of the goblin/standard/demon ladder, so "first" is unreliable —
    # those get overridden below with the PrizePicks-direct standard line.
    seen: set[tuple] = set()
    deduped: list[dict] = []
    for r in rows:
        key = (r["player_id"], r["prop_type"], r["bookmaker"], r["game_date"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    rows = deduped

    # ── PrizePicks-direct standard fantasy lines (authoritative override) ─────
    # Replace the ParlayAPI fantasy rows (random alt rung) with the real
    # PrizePicks STANDARD line read straight from PrizePicks. We set
    # observed_lines to the single standard value so db.upsert_lines treats the
    # row as authoritative and does NOT median-merge it. Players PrizePicks-
    # direct doesn't cover keep their ParlayAPI row, which still flows through
    # the median accumulation as a fallback. If PrizePicks-direct fails entirely
    # (e.g. Cloudflare blocks the runner), pp_standard is {} and every fantasy
    # row falls back to the ladder/median path — no regression.
    pp_standard = _fetch_prizepicks_standard_fantasy(name_to_id, normalized_to_id)
    pp_applied = 0
    pp_dropped_stale = 0
    # Fantasy-score lines are sourced ONLY from the authoritative PrizePicks-direct
    # standard. Any fantasy row PP-direct DOESN'T cover (because it failed — e.g. a
    # 403 from a non-proxied IP — or doesn't list that player) is DROPPED rather
    # than ingested: the ParlayAPI ladder rung is a random goblin/standard/demon
    # value that would otherwise pollute the last-good standard line via db's
    # median merge (the Ohtani 8.5 -> "8.5,14.5" -> 11.5 bug). Dropping it leaves
    # the existing DB line untouched — the last-good snapshot — until PP-direct
    # provides a fresh authoritative value. ALWAYS runs (even when pp_standard is
    # empty) so a failed PP-direct never corrupts the board.
    id_to_name = {r["player_id"]: r["player_name"] for r in rows}
    kept: list[dict] = []
    for r in rows:
        if r["prop_type"] in PRIZEPICKS_ONLY_PROPS:
            if (r["player_id"], r["prop_type"]) not in pp_standard:
                pp_dropped_stale += 1
                continue   # uncovered: drop (preserve last-good DB line)
            continue       # covered: drop the ParlayAPI rung; replaced authoritatively below
        kept.append(r)
    for (player_id, prop_type), line in pp_standard.items():
        kept.append({
            "player_id":      player_id,
            "player_name":    id_to_name.get(player_id, ""),
            "prop_type":      prop_type,
            "bookmaker":      "prizepicks",
            "line":           line,
            "over_price":     100,
            "under_price":    -100,
            "game_date":      game_date_str,
            # Single value marks this row authoritative -> db.py stores it
            # verbatim (no median merge).
            "observed_lines": str(line),
        })
        pp_applied += 1
    rows = kept

    norm_note = f" [{normalized_matches} via normalized match]" if normalized_matches else ""
    pp_note = f" [{pp_only_dropped} non-PrizePicks fantasy lines dropped]" if pp_only_dropped else ""
    ppd_note = (
        f" [{pp_applied} fantasy lines from PrizePicks-direct standard]"
        if pp_applied
        else f" [PrizePicks-direct unavailable -- {pp_dropped_stale} fantasy rows dropped, last-good lines kept]"
    )
    summary = ", ".join(f"{p}: {n}" for p, n in per_prop.items())
    print(f"  fetched {len(rows)} lines ({summary}){norm_note}{pp_note}{ppd_note}")

    # ── per-book breakdown ──────────────────────────────────────────────────
    # Surfaces which books are actually returning lines vs which are dead
    # entries in BOOKMAKERS. Sorted by row count descending so the heavy
    # hitters land first.
    per_book: dict[str, int] = {}
    for r in rows:
        per_book[r["bookmaker"]] = per_book.get(r["bookmaker"], 0) + 1
    if per_book:
        book_summary = ", ".join(
            f"{b}:{n}" for b, n in sorted(per_book.items(), key=lambda x: -x[1])
        )
        print(f"  by book: {book_summary}")

    # ── unmatched player names ──────────────────────────────────────────────
    # Any raw row whose player name didn't exact- or normalized-match a known
    # projected player. Surfaces typos/diacritics/lookup_player misses so we
    # can patch the normalizer (or fetch.py) when a pattern emerges.
    unmatched: list[str] = []
    for r in raw or []:
        name = r.get("player")
        if name and name_to_id.get(name) is None:
            norm = _normalize(name)
            if normalized_to_id.get(norm) is None:
                if name not in unmatched:
                    unmatched.append(name)
    if unmatched:
        print(
            f"  unmatched players (first 10, {len(unmatched)} total): "
            f"{unmatched[:10]}"
        )

    # ── market_keys returned by the API ─────────────────────────────────────
    # Helps diagnose new markets the API has started returning that we're
    # not mapping in MARKET_TO_PROP (and therefore silently dropping).
    all_market_keys = sorted(set(
        r.get("market_key") for r in raw or []
        if r.get("market_key")
    ))
    print(f"  market_keys from API: {all_market_keys}")

    return rows
