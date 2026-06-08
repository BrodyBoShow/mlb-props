"""First-inning runs (NRFI / YRFI) — game-level model.

NRFI/YRFI is a whole-GAME yes/no bet (does any run score in the 1st inning,
either team), NOT a per-pitcher over/under. We model the PROBABILITY a run
scores — P(YRFI) — and compare it to 0.5:
    P(YRFI) < 0.5  -> NRFI lean (no run is favored)
    P(YRFI) >= 0.5 -> YRFI lean (a run is favored)

WHY A PROBABILITY, NOT EXPECTED RUNS: 1st-inning runs are heavily right-skewed
(most innings score 0, a few score 2-3), so the MEAN runs (~1.0) sits well above
0.5 even though ~50% of games are genuinely NRFI. Comparing expected runs to a
0.5 line therefore leans YRFI on nearly every game (measured: 9/9). Modeling the
binary directly via SCORELESS RATES is naturally calibrated to the real ~50%
base rate.

P(YRFI) = 1 - P(top 1st scoreless) * P(bottom 1st scoreless), where each
half-inning's scoreless probability blends the batting team's recent rate of
going scoreless in the 1st with the opposing starter's recent rate of holding
the 1st scoreless. Falls back to the league scoreless rate when a starter/team
has no history.

STORAGE: one projection row per game with prop_type='first_inning_runs', keyed
on the HOME starting pitcher as carrier player_id (the projections /
player_game_logs tables are player-keyed; the home SP is a unique, stable
carrier per game). projection = P(YRFI) (0-1). The grader writes the game's
actual 1st-inning run TOTAL onto that same home-SP row (actual_first_inning_runs;
0 = NRFI, >= 1 = YRFI). No DB writes here.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

import statsapi

if TYPE_CHECKING:
    from schemas import ProjectionRow

from constants import et_today

_HISTORY_DAYS = 21
_LEAGUE_SCORELESS_FALLBACK = 0.72   # ~72% of 1st half-innings are scoreless
# Clamp per-entity scoreless rates so a 1-game sample can't read 0% or 100%.
_MIN_SCORELESS = 0.40
_MAX_SCORELESS = 0.95


@lru_cache(maxsize=4)
def _first_inning_history(ref_str: str) -> tuple:
    """(sp_allowed, team_scored, league_scoreless) over the trailing window.

    sp_allowed[sp_id] -> list of 1st-inning runs that starter ALLOWED
    team_scored[team] -> list of 1st-inning runs that team SCORED
    league_scoreless  -> fraction of all 1st half-innings that scored 0 (prior)

    Built from one schedule call per date (hydrate=linescore,probablePitcher),
    cached by ref-date string so a cron run hits the network once. Fully
    defensive: a failed day is skipped, never fatal.
    """
    ref = date.fromisoformat(ref_str)
    sp_allowed: dict[int, list[int]] = {}
    team_scored: dict[str, list[int]] = {}
    halves: list[int] = []
    for d in range(1, _HISTORY_DAYS + 1):
        day = (ref - timedelta(days=d)).strftime("%Y-%m-%d")
        try:
            r = statsapi.get(
                "schedule",
                {"sportId": 1, "date": day, "hydrate": "linescore,probablePitcher"},
            )
        except Exception as exc:
            print(f"  first-inning history: schedule fetch failed {day}: {exc}")
            continue
        for dd in r.get("dates", []) or []:
            for g in dd.get("games", []) or []:
                if (g.get("status", {}) or {}).get("abstractGameState") != "Final":
                    continue
                innings = (g.get("linescore") or {}).get("innings") or []
                if not innings:
                    continue
                inn1 = innings[0]
                away_r = (inn1.get("away") or {}).get("runs")
                home_r = (inn1.get("home") or {}).get("runs")
                if away_r is None or home_r is None:
                    continue
                away_r, home_r = int(away_r), int(home_r)
                teams = g.get("teams", {}) or {}
                at = ((teams.get("away") or {}).get("team") or {}).get("name")
                ht = ((teams.get("home") or {}).get("team") or {}).get("name")
                asp = ((teams.get("away") or {}).get("probablePitcher") or {}).get("id")
                hsp = ((teams.get("home") or {}).get("probablePitcher") or {}).get("id")
                # Away batted the TOP 1st vs the HOME starter; home batted the
                # BOTTOM 1st vs the AWAY starter.
                if hsp:
                    sp_allowed.setdefault(int(hsp), []).append(away_r)
                if asp:
                    sp_allowed.setdefault(int(asp), []).append(home_r)
                if at:
                    team_scored.setdefault(at, []).append(away_r)
                if ht:
                    team_scored.setdefault(ht, []).append(home_r)
                halves.extend([away_r, home_r])
    league_scoreless = (
        sum(1 for v in halves if v == 0) / len(halves)
        if halves else _LEAGUE_SCORELESS_FALLBACK
    )
    return (sp_allowed, team_scored, league_scoreless)


def _scoreless_rate(vals: list[int], league: float) -> float:
    """Fraction of 1st innings in `vals` that scored 0 runs, league fallback +
    clamp so a thin sample can't read a degenerate 0/1."""
    if not vals:
        return league
    rate = sum(1 for v in vals if v == 0) / len(vals)
    return max(_MIN_SCORELESS, min(_MAX_SCORELESS, rate))


def build_first_inning_runs_projections(
    games: list[dict],
    projection_date: date | None = None,
) -> "list[ProjectionRow]":
    """One game-level P(YRFI) projection per game.

    Carrier player_id = the home starting pitcher (games['home_starter_id']).
    Games without a resolved home starter are skipped (no stable carrier).
    """
    proj_date = projection_date or et_today()
    proj_date_str = proj_date.strftime("%Y-%m-%d")
    sp_allowed, team_scored, league = _first_inning_history(proj_date_str)

    rows: list[dict] = []
    for g in games:
        # Date guard: only build games that ACTUALLY play on proj_date (Eastern).
        # NRFI is the one builder that iterates raw `games` (the others use the
        # today-only `starters` list), so a `games` list polluted with an adjacent
        # day at the cron's UTC/ET boundary would otherwise stamp yesterday's (or
        # tomorrow's) games with today's projection_date. Skip anything not on the
        # slate. Games with no start_time fall through (can't verify -> keep).
        st = g.get("start_time")
        if st:
            try:
                if datetime.fromisoformat(st).astimezone(_ET).date().isoformat() != proj_date_str:
                    continue
            except (ValueError, TypeError):
                pass
        home_sp = g.get("home_starter_id")
        if not home_sp:
            continue   # no stable carrier
        away_sp = g.get("away_starter_id")
        home_team = g.get("home_team")
        away_team = g.get("away_team")

        # Per-entity scoreless rates (1st inning).
        s_home_sp = _scoreless_rate(sp_allowed.get(int(home_sp), []), league)
        s_away_sp = _scoreless_rate(sp_allowed.get(int(away_sp), []) if away_sp else [], league)
        s_away_off = _scoreless_rate(team_scored.get(away_team, []), league)
        s_home_off = _scoreless_rate(team_scored.get(home_team, []), league)

        # P(half-inning scoreless) blends the batting team's scoreless rate with
        # the opposing starter's hold-scoreless rate (mean — robust to thin
        # samples). Top = away bats vs home SP; bottom = home bats vs away SP.
        p_top_scoreless = (s_away_off + s_home_sp) / 2.0
        p_bot_scoreless = (s_home_off + s_away_sp) / 2.0
        p_yrfi = 1.0 - p_top_scoreless * p_bot_scoreless

        rows.append(
            {
                "game_id": g["game_id"],
                "player_id": int(home_sp),
                "prop_type": "first_inning_runs",
                # projection = P(YRFI) (0-1), compared to a 0.5 line.
                "projection": round(p_yrfi, 3),
                "projection_date": proj_date_str,
            }
        )
        lean = "YRFI" if p_yrfi >= 0.5 else "NRFI"
        shown = p_yrfi if lean == "YRFI" else 1.0 - p_yrfi
        print(
            f"  {away_team} @ {home_team}: P(YRFI) {p_yrfi:.0%} -> {lean} {shown:.0%}"
        )
    return rows
