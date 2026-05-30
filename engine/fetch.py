"""Pure-fetch layer. Talks to the MLB Stats API only. No DB code lives here.

Every function returns plain Python dicts/lists shaped to match the column
names in db/schema.sql, so db.py can upsert them without any reshaping.
"""

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

    for g in schedule:
        game_id = g["game_id"]
        for key in ("home_probable_pitcher", "away_probable_pitcher"):
            name = (g.get(key) or "").strip()
            if not name:
                continue
            matches = statsapi.lookup_player(name)
            if not matches:
                continue
            # lookup_player is fuzzy and can return loose extras; trust the
            # best (first) match, preferring an exact full-name hit if present.
            person = next(
                (m for m in matches if m.get("fullName", "").lower() == name.lower()),
                matches[0],
            )
            pid = person["id"]
            if pid in seen:
                continue
            seen.add(pid)
            records.append(
                {
                    "player_id": pid,
                    "game_id": game_id,
                    "full_name": person.get("fullName"),
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


if __name__ == "__main__":
    games = fetch_games()
    print(f"Games: {len(games)}")
    for g in games[:5]:
        print(f"  [{g['game_id']}] {g['away_team']} @ {g['home_team']}  ({g['status']})")

    starters = fetch_starters()
    print(f"\nProbable starters: {len(starters)}")
    for s in starters[:5]:
        print(f"  [{s['player_id']}] {s['full_name']}  -> game {s['game_id']}")
