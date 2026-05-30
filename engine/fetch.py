"""Pure-fetch layer. Talks to the MLB Stats API only. No DB code lives here.

Every function returns plain Python dicts/lists shaped to match the column
names in db/schema.sql, so db.py can upsert them without any reshaping.
"""

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


def fetch_probable_pitchers(date_str: str | None = None) -> list[dict]:
    """Probable starting pitchers for the slate, shaped for the `players` table.

    Reads probable-pitcher names off the schedule, then looks each one up to
    resolve the official MLBAM id and bio fields. De-duplicated by player_id.
    """
    schedule = statsapi.schedule(date=date_str) if date_str else statsapi.schedule()

    names: list[str] = []
    for g in schedule:
        for key in ("home_probable_pitcher", "away_probable_pitcher"):
            name = g.get(key)
            if name and name.strip():
                names.append(name.strip())

    players: dict[int, dict] = {}
    for name in names:
        matches = statsapi.lookup_player(name)
        if not matches:
            continue
        # lookup_player is fuzzy and can return loose extras; trust the best
        # (first) match only, preferring an exact full-name hit if present.
        person = next(
            (m for m in matches if m.get("fullName", "").lower() == name.lower()),
            matches[0],
        )
        pid = person["id"]
        if pid in players:
            continue
        players[pid] = {
            "player_id": pid,
            "full_name": person.get("fullName"),
            "team": (person.get("currentTeam") or {}).get("name"),
            "position": (person.get("primaryPosition") or {}).get("abbreviation"),
            "bats": (person.get("batSide") or {}).get("code"),
            "throws": (person.get("pitchHand") or {}).get("code"),
        }

    return list(players.values())


if __name__ == "__main__":
    games = fetch_games()
    print(f"Games: {len(games)}")
    for g in games[:5]:
        print(f"  [{g['game_id']}] {g['away_team']} @ {g['home_team']}  ({g['status']})")

    pitchers = fetch_probable_pitchers()
    print(f"\nProbable pitchers: {len(pitchers)}")
    for p in pitchers[:5]:
        print(f"  [{p['player_id']}] {p['full_name']}  {p['team']}  throws {p['throws']}")
