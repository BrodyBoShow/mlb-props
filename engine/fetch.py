"""Pure-fetch layer. Talks to the MLB Stats API only. No DB code lives here.

Every function returns plain Python dicts/lists shaped to match the column
names in db/schema.sql, so db.py can upsert them without any reshaping.

Design note: fetch_games() and fetch_starters() / fetch_starters_for_date()
all derive from the same statsapi.schedule() response, and the per-pitcher
statsapi.lookup_player() resolution is expensive (one HTTP round-trip per
probable pitcher name). _resolved_schedule() runs the schedule + lookup
pass ONCE per date_str and caches the result via lru_cache, so the three
callers that need it for the same date share the work for free.
"""

from datetime import date
from functools import lru_cache

import statsapi


# ─── shared schedule + starter resolution ────────────────────────────────────

def _resolve_pitcher(name: str, current_year: int) -> dict | None:
    """Resolve a probable-pitcher name to its statsapi person dict.

    Returns None on any ambiguity or miss — caller treats that as "starter
    not yet known" rather than crashing. Apply the pitcher-position filter
    BEFORE picking among candidates so a position player with the same name
    (e.g. two 'Luis Garcia's) can never be selected over the actual pitcher.
    """
    matches = statsapi.lookup_player(name, season=current_year)
    if not matches:
        return None

    active = [m for m in matches if m.get("active") is True]
    candidates = active if active else matches

    pitchers = [
        m for m in candidates
        if (m.get("primaryPosition") or {}).get("abbreviation") in ("P", "SP", "RP")
    ]
    if pitchers:
        candidates = pitchers

    # lookup_player is fuzzy — prefer an exact full-name hit; otherwise trust
    # a sole result. Multiple fuzzy matches with no exact hit are ambiguous;
    # skip rather than risk the wrong MLBAM id.
    exact = [
        m for m in candidates
        if (m.get("fullName") or "").lower() == name.lower()
    ]
    if exact:
        return exact[0]
    if len(candidates) == 1:
        return candidates[0]

    print(
        f"  WARNING: ambiguous lookup for '{name}' "
        f"({len(candidates)} matches) — skipping"
    )
    return None


@lru_cache(maxsize=8)
def _resolved_schedule(date_str: str | None):
    """Fetch statsapi.schedule() + resolve every probable pitcher in it.

    Returns (schedule, starter_records, starter_ids_by_game).
      schedule              -- raw list from statsapi.schedule(); [] on error.
      starter_records       -- one dedup'd dict per probable pitcher with
                               player_id/game_id/full_name/bio fields, the
                               same shape the baseline + grader consume.
      starter_ids_by_game   -- {game_id: {"home": pid|None, "away": pid|None}}
                               used by fetch_games() to populate games.
                               home_starter_id / games.away_starter_id.

    Cached by date_str so fetch_games + fetch_starters + fetch_starters_for_
    date for the same day share the lookup pass. lru_cache returns mutable
    objects — callers MUST copy before mutating (every caller below does).
    """
    try:
        schedule = statsapi.schedule(date=date_str) if date_str else statsapi.schedule()
    except Exception as exc:
        print(
            f"  WARNING: statsapi.schedule() failed for "
            f"{date_str or 'today'}: {exc}"
        )
        return [], [], {}

    current_year = date.today().year
    records: list[dict] = []
    starter_ids_by_game: dict[int, dict[str, int | None]] = {}
    seen: set[int] = set()

    for g in schedule:
        game_id = g["game_id"]
        starter_ids_by_game[game_id] = {"home": None, "away": None}

        for key in ("home_probable_pitcher", "away_probable_pitcher"):
            name = (g.get(key) or "").strip()
            if not name:
                continue

            person = _resolve_pitcher(name, current_year)
            if person is None:
                continue

            pid = person["id"]
            side = "home" if key == "home_probable_pitcher" else "away"
            starter_ids_by_game[game_id][side] = pid

            if pid in seen:
                continue
            seen.add(pid)
            records.append(
                {
                    "player_id": pid,
                    "game_id": game_id,
                    "full_name": person.get("fullName"),
                    "home_away": side,
                    "team": (person.get("currentTeam") or {}).get("name"),
                    "position": (person.get("primaryPosition") or {}).get("abbreviation"),
                    "bats": (person.get("batSide") or {}).get("code"),
                    "throws": (person.get("pitchHand") or {}).get("code"),
                    "player_type": "pitcher",
                }
            )

    # The lookup_player payload omits batSide/pitchHand and returns a nameless
    # currentTeam, so team/bats/throws above come back None. Backfill all three
    # in ONE bulk MLB /people call — the SAME helper the lineup path uses. We
    # keep lookup_player ONLY for the fuzzy name→id resolution; bio comes from
    # /people. Runs once per date (this function is lru_cached), so the enriched
    # records are shared by fetch_games / fetch_starters / fetch_probable_pitchers
    # / fetch_starters_for_date for free. Failure → bio stays None (graceful).
    if records:
        bio = _fetch_handedness_by_id([r["player_id"] for r in records])
        resolved = 0
        for r in records:
            b = bio.get(r["player_id"])
            if not b:
                continue
            if b.get("bats"):
                r["bats"] = b["bats"]
            if b.get("throws"):
                r["throws"] = b["throws"]
            if b.get("team"):
                r["team"] = b["team"]
            if b.get("throws") or b.get("team"):
                resolved += 1
        print(
            f"  resolved bio (team/bats/throws) for {resolved} / {len(records)} "
            f"probable starters via MLB /people"
        )

    return schedule, records, starter_ids_by_game


# ─── games ───────────────────────────────────────────────────────────────────

def fetch_games(date_str: str | None = None) -> list[dict]:
    """Today's (or a given date's) games, shaped for the `games` table.

    date_str: optional 'YYYY-MM-DD'. Defaults to today's slate.
    Returns [] on any statsapi outage so the pipeline degrades gracefully.

    home_starter_id / away_starter_id are populated when the probable
    starter resolves cleanly; otherwise the key is OMITTED from the row
    (NOT set to None) so the upsert never clobbers a previously-set value
    with NULL on a later cron tick where the lookup failed transiently.
    """
    schedule, _records, starter_ids_by_game = _resolved_schedule(date_str)
    games: list[dict] = []
    for g in schedule:
        game_id = g["game_id"]
        sids = starter_ids_by_game.get(game_id, {})
        row: dict = {
            "game_id": game_id,
            "game_date": g["game_date"],          # 'YYYY-MM-DD'
            "home_team": g["home_name"],
            "away_team": g["away_name"],
            "status": g.get("status"),
            # First-pitch ISO timestamp (UTC, Z-suffixed). Used by the
            # frontend to sort game cards chronologically. Defensive get:
            # statsapi sometimes omits game_datetime for TBD slots.
            "start_time": g.get("game_datetime"),
        }
        if sids.get("home") is not None:
            row["home_starter_id"] = sids["home"]
        if sids.get("away") is not None:
            row["away_starter_id"] = sids["away"]
        games.append(row)
    return games


# ─── starters ────────────────────────────────────────────────────────────────

def fetch_starters() -> list[dict]:
    """Probable starters for TODAY, linked to their game_id.

    Returns one dict per pitcher with player_id, game_id, full_name, bio
    fields. Single source the baseline and grader both consume.
    """
    _sched, records, _sids = _resolved_schedule(None)
    return [dict(r) for r in records]


def fetch_starters_for_date(date_str: str) -> list[dict]:
    """Probable starters for an arbitrary date (future-slate previews).

    Same shape as fetch_starters() but for a specific date string. Used by
    main._run_future_previews to pre-populate games + probable pitchers for
    the next 3 days so the frontend can show "tomorrow's slate" before
    projections exist. Returns [] gracefully on any statsapi outage.
    """
    _sched, records, _sids = _resolved_schedule(date_str)
    return [dict(r) for r in records]


def fetch_probable_pitchers() -> list[dict]:
    """Today's probable starting pitchers shaped for the `players` table."""
    _sched, records, _sids = _resolved_schedule(None)
    cols = ("player_id", "full_name", "team", "position", "bats", "throws", "player_type")
    return [{c: r[c] for c in cols} for r in records]


# ─── lineups (unchanged) ─────────────────────────────────────────────────────

def fetch_lineups(date_str: str | None = None) -> list[dict]:
    """Confirmed batting lineups for today's (or a given date's) games.

    Lineups post ~60-90 min before first pitch. Until then a game's
    battingOrder is empty and that game is skipped. Returns ONLY players from
    games whose lineup is confirmed; if no game has a posted lineup, returns []
    — main.py uses an empty list as the signal to skip the hitter prop block.

    Each row is shaped for the `players` table plus lineup context:
        player_id, full_name, team, position, bats, throws,
        game_id, batting_order (1-9), home_away ('home' | 'away').
    """
    try:
        schedule = statsapi.schedule(date=date_str) if date_str else statsapi.schedule()
    except Exception as exc:
        print(f"  WARNING: statsapi.schedule() failed in fetch_lineups: {exc} -- skipping hitter props")
        return []

    records: list[dict] = []
    for g in schedule:
        game_id = g["game_id"]
        try:
            box = statsapi.boxscore_data(game_id)
        except Exception as exc:
            print(f"  lineup fetch failed for game {game_id}: {exc}")
            continue

        for side in ("home", "away"):
            side_data = box.get(side, {}) or {}
            # battingOrder is the confirmed starting nine (ordered player ids).
            # Empty until the lineup is posted — that's the graceful skip.
            order = side_data.get("battingOrder") or []
            players = side_data.get("players", {}) or {}
            team_name = (side_data.get("team", {}) or {}).get("name")

            for idx, pid in enumerate(order):
                entry = players.get(f"ID{pid}", {}) or {}
                person = entry.get("person", {}) or {}
                full_name = person.get("fullName")
                if not full_name:
                    continue   # can't map a line/grade without a name

                position = (entry.get("position", {}) or {}).get("abbreviation")
                # bats / throws are populated from the bulk /people pass
                # below — the boxscore_data response strips person.batSide
                # and person.pitchHand out entirely (verified probe).
                records.append(
                    {
                        "player_id": int(pid),
                        "full_name": full_name,
                        "team": team_name,
                        "position": position,
                        "bats": None,
                        "throws": None,
                        "game_id": game_id,
                        "batting_order": idx + 1,   # 1-9, always non-zero
                        "home_away": side,
                    }
                )

    # Backfill bats + throws in ONE bulk MLB /people request for every
    # unique batter id we just collected. The boxscore strips both fields
    # so this is the only reliable path; doing it post-loop keeps it to
    # a single API call per fetch_lineups invocation regardless of slate
    # size. Players not returned by /people keep their None values, which
    # downstream consumers (db.upsert_players) leave NULL in the cache.
    unique_ids = list({r["player_id"] for r in records})
    handedness = _fetch_handedness_by_id(unique_ids)
    resolved = 0
    for r in records:
        h = handedness.get(r["player_id"])
        if h:
            if h.get("bats"):
                r["bats"] = h["bats"]
            if h.get("throws"):
                r["throws"] = h["throws"]
            if h.get("bats") or h.get("throws"):
                resolved += 1
    if records:
        print(
            f"  resolved bats/throws for {resolved} / {len(unique_ids)} "
            f"lineup players via MLB /people"
        )

    return records


def build_expected_hitters(
    line_players: dict[int, str],
    games: list[dict],
    exclude_ids: set[int] | None = None,
) -> list[dict]:
    """Shape lineup-style dicts for hitters that have a LINE but no confirmed
    lineup slot, so pre-game games (later starts + the not-yet-posted second
    team) still get hitter projections.

    line_players: {player_id: full_name} (from db.get_hitter_line_players_for_date).
    games:        today's games (need game_id, home_team, away_team).
    exclude_ids:  player_ids already covered by a confirmed lineup — skipped.

    Each player's team is resolved via the MLB /people bulk call and mapped to
    today's game (team == home_team -> home, == away_team -> away), giving the
    game_id + home_away the baseline builders need. batting_order is 0 (not a
    confirmed slot; the rolling-average builders don't use it). Players whose
    team isn't in today's slate (or can't be resolved) are dropped. Returns the
    same dict shape as fetch_lineups so it slots straight into the builders.
    """
    exclude = exclude_ids or set()
    ids = [pid for pid in line_players if pid not in exclude]
    if not ids or not games:
        return []

    # team name -> (game_id, home_away). games.home_team is the statsapi
    # home_name, which matches the /people currentTeam name string.
    team_to_game: dict[str, tuple[int, str]] = {}
    for g in games:
        gid = g.get("game_id")
        if gid is None:
            continue
        if g.get("home_team"):
            team_to_game[g["home_team"]] = (gid, "home")
        if g.get("away_team"):
            team_to_game[g["away_team"]] = (gid, "away")

    bio = _fetch_handedness_by_id(ids)
    out: list[dict] = []
    for pid in ids:
        b = bio.get(pid) or {}
        team = b.get("team")
        if not team:
            continue
        slot = team_to_game.get(team)
        if not slot:
            continue   # player's team has no game on this slate
        gid, home_away = slot
        out.append(
            {
                "player_id":     pid,
                "full_name":     line_players[pid],
                "team":          team,
                "position":      None,
                "bats":          b.get("bats"),
                "throws":        b.get("throws"),
                "game_id":       gid,
                "batting_order": 0,        # not a confirmed slot
                "home_away":     home_away,
            }
        )
    return out


def _fetch_handedness_by_id(player_ids: list[int]) -> dict[int, dict]:
    """Resolve player_id -> {bats, throws, team} via the MLB Stats API /people.

    A SINGLE bulk request resolves any number of player ids; the alternatives
    (statsapi.boxscore_data → person.batSide / person.pitchHand, and
    statsapi.lookup_player) both return batSide/pitchHand=None and a nameless
    currentTeam. Returns {} on any failure so callers can fall back to defaults.

    hydrate=currentTeam is required for the team NAME — the default /people
    response returns currentTeam with only an id. The full team-name string it
    yields matches games.home_team (statsapi home_name), which the HR-composite
    platoon term compares against.

    Each value is shaped {"bats": "L"|"R"|"S"|None, "throws": "L"|"R"|None,
    "team": str|None}. Players not in the response are silently dropped — caller
    treats absence as "unknown" and uses defaults. (Lineup callers that only read
    bats/throws are unaffected by the added team key.)
    """
    if not player_ids:
        return {}
    ids_csv = ",".join(str(int(p)) for p in player_ids)
    try:
        resp = statsapi.get("people", {"personIds": ids_csv, "hydrate": "currentTeam"})
    except Exception as exc:
        print(f"  WARNING: statsapi.get('people') failed: {exc}")
        return {}
    out: dict[int, dict] = {}
    for p in (resp.get("people") or []):
        pid = p.get("id")
        if pid is None:
            continue
        out[int(pid)] = {
            "bats":   (p.get("batSide") or {}).get("code"),
            "throws": (p.get("pitchHand") or {}).get("code"),
            "team":   (p.get("currentTeam") or {}).get("name"),
        }
    return out


def fetch_bats_by_id(player_ids: list[int]) -> dict[int, str]:
    """Resolve player_id -> bats code only. Thin wrapper around the richer
    _fetch_handedness_by_id helper for callers that only need bats (e.g.
    grade._opp_lineup_handedness which doesn't care about pitchHand).
    """
    full = _fetch_handedness_by_id(player_ids)
    return {pid: v["bats"] for pid, v in full.items() if v.get("bats")}


def compute_lineup_handedness(
    lineup_players: list[dict],
) -> dict[int, dict[str, float]]:
    """Per-game LHH / RHH percentages from a confirmed lineup list.

    Returns {game_id: {"lhh_pct": float, "rhh_pct": float}}. Switch hitters
    (bats == "S") count as 0.5 to each side. Missing bats fields default to
    "R" — most-common case for unannotated MLB roster entries.

    Used by main.py to attach lineup_lhh_pct to each game so grade.py can
    log it onto the pitcher's player_game_logs row. The model treats this
    as a context feature for the platoon split logic.
    """
    by_game: dict[int, list[str]] = {}
    for p in lineup_players:
        gid = p["game_id"]
        bats = p.get("bats") or "R"
        by_game.setdefault(gid, []).append(bats)
    result: dict[int, dict[str, float]] = {}
    for gid, bats_list in by_game.items():
        n = len(bats_list)
        if n == 0:
            continue
        lhh = sum(
            1.0 if b == "L" else 0.5 if b == "S" else 0.0
            for b in bats_list
        ) / n
        result[gid] = {
            "lhh_pct": round(lhh, 3),
            "rhh_pct": round(1 - lhh, 3),
        }
    return result


if __name__ == "__main__":
    games = fetch_games()
    print(f"Games: {len(games)}")
    for g in games[:5]:
        sids = (
            f"  starters: home={g.get('home_starter_id')} "
            f"away={g.get('away_starter_id')}"
        )
        print(f"  [{g['game_id']}] {g['away_team']} @ {g['home_team']}  ({g['status']}){sids}")

    starters = fetch_starters()
    print(f"\nProbable starters: {len(starters)}")
    for s in starters[:5]:
        print(f"  [{s['player_id']}] {s['full_name']}  -> game {s['game_id']}")
