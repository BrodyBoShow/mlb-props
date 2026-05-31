"""Pure-fetch layer. Talks to the MLB Stats API only. No DB code lives here.

Every function returns plain Python dicts/lists shaped to match the column
names in db/schema.sql, so db.py can upsert them without any reshaping.
"""

from datetime import date
from functools import lru_cache

import statsapi


def fetch_games(date_str: str | None = None) -> list[dict]:
    """Today's (or a given date's) games, shaped for the `games` table.

    date_str: optional 'YYYY-MM-DD'. Defaults to today's slate.
    """
    schedule = statsapi.schedule(date=date_str) if date_str else statsapi.schedule()
    games = []
    for g in schedule:
        games.append(
            {
                "game_id": g["game_id"],
                "game_date": g["game_date"],          # 'YYYY-MM-DD'
                "home_team": g["home_name"],
                "away_team": g["away_name"],
                "status": g.get("status"),
            }
        )
    return games


@lru_cache(maxsize=1)
def _fetch_starters_today() -> tuple[dict, ...]:
    """Probable starters for today, each linked to the game they start in.

    Returns rich records: player_id, game_id, plus bio fields. This is the
    single source both fetch_probable_pitchers (players-table rows) and the
    baseline (which needs game_id per pitcher) derive from. lru_cached so one
    pipeline run hits the schedule + lookups only once.
    """
    schedule = statsapi.schedule()
    records: list[dict] = []
    seen: set[int] = set()
    current_year = date.today().year

    for g in schedule:
        game_id = g["game_id"]
        for key in ("home_probable_pitcher", "away_probable_pitcher"):
            name = (g.get(key) or "").strip()
            if not name:
                continue

            matches = statsapi.lookup_player(name, season=current_year)
            if not matches:
                continue

            # Restrict to active MLB players when the API exposes the flag.
            active = [m for m in matches if m.get("active") is True]
            candidates = active if active else matches

            # lookup_player is fuzzy. Prefer an exact full-name hit; otherwise
            # only trust a sole result. Multiple fuzzy matches with no exact
            # hit are ambiguous — skip rather than risk the wrong MLBAM id.
            exact = [
                m for m in candidates
                if (m.get("fullName") or "").lower() == name.lower()
            ]
            if exact:
                person = exact[0]
            elif len(candidates) == 1:
                person = candidates[0]
            else:
                print(
                    f"  WARNING: ambiguous lookup for '{name}' "
                    f"({len(candidates)} matches) — skipping"
                )
                continue

            pid = person["id"]
            if pid in seen:
                continue
            seen.add(pid)
            records.append(
                {
                    "player_id": pid,
                    "game_id": game_id,
                    "full_name": person.get("fullName"),
                    "home_away": "home" if key == "home_probable_pitcher" else "away",
                    "team": (person.get("currentTeam") or {}).get("name"),
                    "position": (person.get("primaryPosition") or {}).get("abbreviation"),
                    "bats": (person.get("batSide") or {}).get("code"),
                    "throws": (person.get("pitchHand") or {}).get("code"),
                }
            )

    return tuple(records)


def fetch_starters() -> list[dict]:
    """Probable starters linked to their game_id (player_id, game_id, bio)."""
    return [dict(r) for r in _fetch_starters_today()]


def fetch_probable_pitchers() -> list[dict]:
    """Probable starting pitchers shaped for the `players` table."""
    cols = ("player_id", "full_name", "team", "position", "bats", "throws")
    return [{c: r[c] for c in cols} for r in _fetch_starters_today()]


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
    schedule = statsapi.schedule(date=date_str) if date_str else statsapi.schedule()

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
                records.append(
                    {
                        "player_id": int(pid),
                        "full_name": full_name,
                        "team": team_name,
                        "position": position,
                        "bats": (person.get("batSide", {}) or {}).get("code"),
                        "throws": (person.get("pitchHand", {}) or {}).get("code"),
                        "game_id": game_id,
                        "batting_order": idx + 1,   # 1-9, always non-zero
                        "home_away": side,
                    }
                )

    return records


if __name__ == "__main__":
    games = fetch_games()
    print(f"Games: {len(games)}")
    for g in games[:5]:
        print(f"  [{g['game_id']}] {g['away_team']} @ {g['home_team']}  ({g['status']})")

    starters = fetch_starters()
    print(f"\nProbable starters: {len(starters)}")
    for s in starters[:5]:
        print(f"  [{s['player_id']}] {s['full_name']}  -> game {s['game_id']}")
