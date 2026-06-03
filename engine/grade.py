"""Grade yesterday's pitcher projections against actual MLB box scores.

Fetches final game results from the MLB Stats API, matches each projected
pitcher to their actual stats, and returns rows ready to upsert into
player_game_logs. No DB writes here — returns list[dict] only.
"""

import time
from datetime import date, datetime, timedelta, timezone

import statsapi

import pybaseball

import db
import fetch
import stats
import weather
from constants import (
    LEAGUE_AVG_K_PCT,
    get_park_factor_hits,
    get_park_factor_k,
)
from fantasy_score import hitter_fantasy_score, pitcher_fantasy_score
from stats import _parse_innings
from schemas import (
    HitterGameLogRow,
    PitcherGameLogRow,
    ProjectionContextRow,
)


# Sleep between per-pitcher 30-day Statcast calls (Step 5). Polite to the
# Baseball Savant endpoint and keeps the grading job comfortably under the
# 20-minute Actions cap with a typical 15-20 pitcher slate.
_STATCAST_SLEEP_S = 0.5


def _pitcher_platoon_30d(player_id: int, end_date_str: str, start_date_str: str) -> dict:
    """30-day platoon splits + whiff% + CSW% for one pitcher (Statcast).

    Filtered from a single statcast_pitcher() call. Each field is None
    when the input is too sparse to compute (< 20 PAs for the split,
    no pitches in the window, etc.) — never fabricated.
    """
    try:
        sc = pybaseball.statcast_pitcher(start_date_str, end_date_str, player_id)
    except Exception as exc:
        print(f"  30d statcast fetch failed for player {player_id}: {exc}")
        return {
            "pitcher_k_vs_lhh_30d":  None,
            "pitcher_k_vs_rhh_30d":  None,
            "pitcher_whiff_pct_30d": None,
            "pitcher_csw_pct_30d":   None,
        }
    if sc is None or sc.empty:
        return {
            "pitcher_k_vs_lhh_30d":  None,
            "pitcher_k_vs_rhh_30d":  None,
            "pitcher_whiff_pct_30d": None,
            "pitcher_csw_pct_30d":   None,
        }

    def k_rate(side_df) -> float | None:
        if len(side_df) < 20:
            return None
        ks = side_df["events"].isin(
            ["strikeout", "strikeout_double_play"]
        ).sum()
        pas = side_df["events"].notna().sum()
        return round(float(ks / pas), 3) if pas > 0 else None

    lhh = sc[sc["stand"] == "L"]
    rhh = sc[sc["stand"] == "R"]
    k_vs_lhh = k_rate(lhh)
    k_vs_rhh = k_rate(rhh)

    # Whiff% = whiffs / swings. Swings = whiffs + foul + foul_tip + hit_into_play.
    desc = sc["description"]
    whiffs = desc.isin(["swinging_strike", "swinging_strike_blocked"]).sum()
    swings = desc.isin(
        ["swinging_strike", "swinging_strike_blocked",
         "foul", "foul_tip", "hit_into_play"]
    ).sum()
    whiff_pct = round(float(whiffs / swings), 3) if swings > 0 else None

    # CSW% = (called strikes + whiffs) / total pitches.
    called = desc.isin(["called_strike"]).sum()
    csw_pct = round(float((called + whiffs) / len(sc)), 3) if len(sc) > 0 else None

    return {
        "pitcher_k_vs_lhh_30d":  k_vs_lhh,
        "pitcher_k_vs_rhh_30d":  k_vs_rhh,
        "pitcher_whiff_pct_30d": whiff_pct,
        "pitcher_csw_pct_30d":   csw_pct,
    }


def _is_day_game(start_time_iso: str | None) -> bool | None:
    """Heuristic: before 5 PM ET is a day game.

    start_time_iso is the games.start_time UTC ISO string. Returns None
    if it's missing — the column stays NULL rather than default false.
    """
    if not start_time_iso:
        return None
    try:
        ts = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
    except Exception:
        return None
    # Convert to ET (UTC-4 standard / UTC-5 DST). Python's zoneinfo would
    # be more correct but ET-summer is UTC-4 and MLB regular season is
    # entirely DST, so this approximation is safe for our purposes.
    et = ts.astimezone(timezone(timedelta(hours=-4)))
    return et.hour < 17


def _parse_game_time(start_time_iso: str | None) -> datetime | None:
    """Parse games.start_time -> UTC datetime, None on any failure."""
    if not start_time_iso:
        return None
    try:
        ts = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
        return ts.astimezone(timezone.utc)
    except Exception:
        return None


# Pitch-type sets (mirrored from engine/model.py — same Statcast codes).
_FASTBALL_TYPES = {"FF", "SI", "FC"}
_BREAKING_TYPES = {"SL", "CU", "KC", "SV", "CS"}
_OFFSPEED_TYPES = {"CH", "FS", "FO", "SC"}


def _pitcher_pitch_mix(player_id: int, day_str: str) -> dict:
    """Pitch mix + avg velocity + total pitches from yesterday's Statcast.

    Single-day per-pitcher fetch keyed on day_str. Returns a dict of NULL-able
    feature values — when Savant flakes or the pitcher has no rows for the
    day, each value comes back as None so the grade row stays sane and the
    grader keeps going.
    """
    try:
        df = pybaseball.statcast_pitcher(day_str, day_str, player_id)
    except Exception as exc:
        print(f"  pitch-mix fetch failed for player {player_id}: {exc}")
        df = None

    if df is None or df.empty:
        return {
            "pitcher_fastball_pct":       None,
            "pitcher_breaking_pct":       None,
            "pitcher_offspeed_pct":       None,
            "pitcher_avg_velo":           None,
            "pitcher_pitches_last_start": None,
        }

    total = len(df)
    fb_pct = float(df["pitch_type"].isin(_FASTBALL_TYPES).sum() / total)
    br_pct = float(df["pitch_type"].isin(_BREAKING_TYPES).sum() / total)
    os_pct = float(df["pitch_type"].isin(_OFFSPEED_TYPES).sum() / total)
    fb_df = df[df["pitch_type"].isin(_FASTBALL_TYPES)]
    avg_velo = float(fb_df["release_speed"].mean()) if len(fb_df) > 0 else None
    return {
        "pitcher_fastball_pct":       round(fb_pct, 3),
        "pitcher_breaking_pct":       round(br_pct, 3),
        "pitcher_offspeed_pct":       round(os_pct, 3),
        "pitcher_avg_velo":           round(avg_velo, 1) if avg_velo is not None else None,
        "pitcher_pitches_last_start": int(total),
    }


def _opp_lineup_handedness(
    box: dict,
    opp_side: str,
    bats_by_id: dict[int, str],
) -> dict:
    """LHH/RHH percentages of the opposing starting 9 from the boxscore.

    MLB statsapi.boxscore_data() strips person.batSide entirely (verified
    via direct probe — only `id` and `fullName` are present on `person`),
    so we look bats up from the players table cache (db.get_player_bats),
    which fetch_lineups() / fetch_probable_pitchers() populates.

    Uses battingOrder (starting nine) rather than `batters` (everyone who
    came to bat, including pinch hitters) so the metric reflects the
    matchup the pitcher actually faced from the first inning, not the
    composite of the full game's batter pool.

    Switch hitters (bats=='S') count 0.5 to each side. Returns league-
    average splits (0.42 / 0.58) when battingOrder is empty (postponed
    or data gap) or when no batter resolves to a known bats code.
    """
    side_data = box.get(opp_side, {}) or {}
    order = side_data.get("battingOrder") or []
    bats_list: list[str] = []
    for pid in order:
        try:
            pid_int = int(pid)
        except (TypeError, ValueError):
            continue
        code = bats_by_id.get(pid_int)
        if code:
            bats_list.append(code)

    if not bats_list:
        return {"lineup_lhh_pct": 0.42, "lineup_rhh_pct": 0.58}
    n = len(bats_list)
    lhh = sum(
        1.0 if b == "L" else 0.5 if b == "S" else 0.0
        for b in bats_list
    ) / n
    return {
        "lineup_lhh_pct": round(lhh, 3),
        "lineup_rhh_pct": round(1 - lhh, 3),
    }


def _opp_starting_pitcher(box: dict, opp_side: str) -> tuple[int | None, str]:
    """Identify the opposing starting pitcher from the boxscore.

    The boxscore's `pitchers` list on each side is ordered by appearance,
    so element 0 is the starter. Returns (sp_id, sp_hand). sp_id is None
    when the pitcher list is empty (postponed / data gap); the caller
    treats that as "unknown SP" and uses league-average fallbacks.
    """
    side_data = box.get(opp_side, {}) or {}
    pitchers = side_data.get("pitchers") or []
    if not pitchers:
        return None, "R"
    sp_id = pitchers[0]
    entry = (side_data.get("players") or {}).get(f"ID{sp_id}", {}) or {}
    person = entry.get("person", {}) or {}
    return (
        sp_id,
        (person.get("pitchHand", {}) or {}).get("code") or "R",
    )


def _opp_sp_recent_stats(sp_id: int | None, yesterday: date) -> dict:
    """Last-5-start K%, ERA, WHIP for the opposing starting pitcher.

    Uses stats.get_pitcher_starts() so we don't need a second Statcast pass.
    Falls back to league-average constants when sp_id is None or there are
    no recent starts on file (rookie / call-up / data gap).
    """
    sp_starts: list[dict] = []
    if sp_id is not None:
        sp_starts = stats.get_pitcher_starts(sp_id, 30, yesterday) or []
    if not sp_starts:
        return {
            "opp_sp_k_rate_last5": round(LEAGUE_AVG_K_PCT, 3),
            "opp_sp_era_last5":    4.50,
            "opp_sp_whip_last5":   1.30,
        }
    recent = sp_starts[:5]
    total_outs = sum(s["outs_recorded"] for s in recent)
    total_innings = max(total_outs / 3, 1)   # avoid div-by-zero
    total_outs_for_era = max(total_outs, 1)

    k_per_ip = sum(s["strikeouts"] for s in recent) / total_innings
    # Normalize K/IP to a "K rate" so it shares units with LEAGUE_AVG_K_PCT.
    # An average ~8 K/9 → ~0.27 K-rate per IP segment.
    k_rate = k_per_ip / 9.0
    era = sum(s["earned_runs"] for s in recent) * 27 / total_outs_for_era
    whip = (
        sum(s["hits_allowed"] for s in recent)
        + sum(s["walks"] for s in recent)
    ) / total_innings
    return {
        "opp_sp_k_rate_last5": round(float(k_rate), 3),
        "opp_sp_era_last5":    round(float(era), 2),
        "opp_sp_whip_last5":   round(float(whip), 2),
    }


def _boxscore(game_id: int) -> dict:
    """Fetch boxscore_data for one game. Returns {} on any error."""
    try:
        return statsapi.boxscore_data(game_id)
    except Exception as exc:
        print(f"  boxscore fetch failed for game {game_id}: {exc}")
        return {}


def _decisions(game_id: int) -> tuple[int | None, int | None]:
    """Return (winning_pitcher_id, losing_pitcher_id) for a finished game.

    boxscore_data doesn't expose decisions, so we hit the live-feed endpoint
    once per game. Returns (None, None) on any error or for games that
    didn't reach an official decision — the caller treats both as "no W".
    """
    try:
        feed = statsapi.get("game", {"gamePk": game_id})
    except Exception as exc:
        print(f"  decisions fetch failed for game {game_id}: {exc}")
        return (None, None)

    deci = (feed.get("liveData") or {}).get("decisions") or {}
    winner = (deci.get("winner") or {}).get("id")
    loser = (deci.get("loser") or {}).get("id")
    return (winner, loser)


def _pitcher_result(box: dict, player_id: int) -> dict | None:
    """Return a dict of actual pitching stats for one pitcher from a boxscore.

    Returns None if the pitcher didn't appear in this game (scratched,
    postponed, or a data gap).

    Keys returned:
        home_away            str   'home' | 'away'
        actual_strikeouts    int
        actual_hits_allowed  int
        actual_walks         int
        actual_earned_runs   int
        actual_outs_recorded int   (inningsPitched converted to total outs)
    """
    for side in ("home", "away"):
        players = box.get(side, {}).get("players", {})
        entry = players.get(f"ID{player_id}", {})
        pitching = entry.get("stats", {}).get("pitching", {})

        # strikeOuts is always present if this pitcher appeared; use it as the
        # presence check (same guard as before).
        ks = pitching.get("strikeOuts")
        if ks is None:
            continue

        return {
            "home_away":            side,
            "actual_strikeouts":    int(ks),
            "actual_hits_allowed":  int(pitching.get("hits", 0)),
            "actual_walks":         int(pitching.get("baseOnBalls", 0)),
            "actual_earned_runs":   int(pitching.get("earnedRuns", 0)),
            "actual_outs_recorded": _parse_innings(pitching.get("inningsPitched", "0.0")),
        }

    return None


def grade_yesterday(
    grade_date: date | None = None,
    projections: list[ProjectionContextRow] | None = None,
) -> list[PitcherGameLogRow]:
    """Grade the previous day's slate against actual results.

    Returns rows shaped for player_game_logs. No DB writes here.
    Skips games not yet Final and pitchers not found in the box score.

    projections: optional pre-fetched projection rows for the same date.
    When the caller is grading pitchers and hitters back-to-back, fetching
    once and passing the rows here avoids a second identical round-trip.
    """
    yesterday = grade_date or (date.today() - timedelta(days=1))
    yesterday_str = yesterday.strftime("%Y-%m-%d")
    print(f"  grading projections for {yesterday_str}...")

    if projections is None:
        projections = db.get_projections_for_date(yesterday_str)
    if not projections:
        print(f"  no projections found for {yesterday_str} -- nothing to grade")
        return []

    # Only grade games the API confirms are Final
    schedule = statsapi.schedule(date=yesterday_str)
    final_ids = {g["game_id"] for g in schedule if "Final" in (g.get("status") or "")}
    if not final_ids:
        print(f"  no Final games for {yesterday_str} -- skipping")
        return []

    # Collapse to one entry per (player_id, game_id). The query now returns all
    # five prop types, but a game log row is per pitcher per game — prefer the
    # strikeouts row so the stored `projection` keeps tracking K projections.
    by_pitcher: dict[tuple[int, int], dict] = {}
    for proj in projections:
        key = (proj["player_id"], proj["game_id"])
        if key not in by_pitcher or proj.get("prop_type") == "strikeouts":
            by_pitcher[key] = proj

    year = yesterday.year

    # Fetch each game's box score + W/L decision once, keyed by game_id.
    box_cache: dict[int, dict] = {}
    decision_cache: dict[int, tuple[int | None, int | None]] = {}

    # Pre-fetch every starting batter's bats handedness via the MLB Stats
    # API /people endpoint — one bulk call for the whole slate. The
    # boxscore_data response strips person.batSide entirely (only `id` and
    # `fullName` come through), and our players-table cache is populated
    # from the same empty source, so this is the only reliable path.
    all_batter_ids: set[int] = set()
    for proj in by_pitcher.values():
        gid = proj["game_id"]
        if gid not in final_ids:
            continue
        if gid not in box_cache:
            box_cache[gid] = _boxscore(gid)
        for side in ("home", "away"):
            order = (box_cache[gid].get(side, {}) or {}).get("battingOrder") or []
            for pid in order:
                try:
                    all_batter_ids.add(int(pid))
                except (TypeError, ValueError):
                    continue
    bats_by_id = fetch.fetch_bats_by_id(list(all_batter_ids))
    print(
        f"  resolved bats handedness for {len(bats_by_id)} / "
        f"{len(all_batter_ids)} starting batters from MLB /people"
    )

    rows: list[dict] = []
    for proj in by_pitcher.values():
        game_id = proj["game_id"]
        player_id = proj["player_id"]

        if game_id not in final_ids:
            continue   # game still in progress or postponed

        if game_id not in box_cache:
            box_cache[game_id] = _boxscore(game_id)
        if game_id not in decision_cache:
            decision_cache[game_id] = _decisions(game_id)

        result = _pitcher_result(box_cache[game_id], player_id)

        if result is None:
            # Pitcher was scratched or data is missing -- don't log a 0
            print(f"  player {player_id} not found in box score for game {game_id} -- skipped")
            continue

        # Opposing (batting) team is the side the pitcher was NOT on. Use the
        # box score's authoritative home_away to pick it.
        side = result["home_away"]
        opp_team = proj["away_team"] if side == "home" else proj["home_team"]
        opp_k_rate = stats._opp_k_rate(opp_team or "", year)

        # Days rest: difference to this pitcher's most recent prior start in
        # the logs, capped at 10. Defaults to 5 when there's no prior entry.
        last_date = db.get_last_game_date(player_id, yesterday_str)
        days_rest = 5
        if last_date:
            try:
                prev = date.fromisoformat(last_date)
                days_rest = min((yesterday - prev).days, 10)
            except Exception:
                days_rest = 5

        # PrizePicks fantasy score: outs+K+ER (always graded) + W and QS
        # bonuses (final, since the game is Final). Computed via the shared
        # fantasy_score module so weights live in exactly one place.
        winner_id, _loser_id = decision_cache[game_id]
        actual_win = (winner_id == player_id)
        actual_pitcher_fp = pitcher_fantasy_score(
            outs=result["actual_outs_recorded"],
            strikeouts=result["actual_strikeouts"],
            earned_runs=result["actual_earned_runs"],
            win=actual_win,
        )

        # ── context features (additive, NULL-safe in the DB) ───────────────
        # Park factors keyed on the venue (always proj['home_team']).
        park_k = get_park_factor_k(proj["home_team"] or "")
        park_h = get_park_factor_hits(proj["home_team"] or "")

        # Opposing lineup handedness — read from the boxscore's battingOrder
        # (starting nine) and the pre-fetched bats_by_id cache (players
        # table). The boxscore doesn't carry batSide directly.
        opp_side = "away" if side == "home" else "home"
        hand_split = _opp_lineup_handedness(
            box_cache[game_id], opp_side, bats_by_id
        )

        # Pitch mix + velo from yesterday's single-day Statcast pass. One
        # API call per graded pitcher; bounded at ~15-20 per day.
        pitch_mix = _pitcher_pitch_mix(player_id, yesterday_str)

        # ── data-foundation features (Step 2-7 of the sprint) ─────────────
        # Each helper is independently None-safe so a single statsapi miss
        # for one pitcher doesn't take down the whole batch.

        # Rest & fatigue (reuses cached gameLog under the hood).
        rest = stats.get_pitcher_rest_metrics(player_id, yesterday)

        # Team schedule density — pitcher's own team (proj['home_team'] if
        # side == 'home' else away_team).
        own_team = proj["home_team"] if side == "home" else proj["away_team"]
        team_density = stats.get_team_schedule_density(own_team or "", yesterday)

        # Pitcher rolling 3-start form.
        pform = stats.get_pitcher_form(player_id, yesterday)

        # 30-day Statcast platoon + plate-discipline (Step 5). This is the
        # historical fill for the predict-time-only k_vs_lhh/rhh features
        # — finally giving the model real training signal on platoon.
        start_30 = (yesterday - timedelta(days=30)).strftime("%Y-%m-%d")
        platoon_30 = _pitcher_platoon_30d(player_id, yesterday_str, start_30)
        time.sleep(_STATCAST_SLEEP_S)   # polite to Savant

        # Series / game context.
        opp_team_for_series = (
            proj["away_team"] if side == "home" else proj["home_team"]
        )
        series = stats.get_series_context(
            own_team or "", opp_team_for_series or "", yesterday
        )
        start_time_iso = proj.get("start_time")
        is_day = _is_day_game(start_time_iso)

        # Weather (dome-aware; NULL when no API key).
        wx = weather.get_game_weather(
            proj["home_team"] or "", _parse_game_time(start_time_iso)
        )

        rows.append({
            "player_id":             player_id,
            "game_id":               game_id,
            "game_date":             yesterday_str,
            "player_type":           "pitcher",
            "actual_strikeouts":     result["actual_strikeouts"],
            "actual_hits_allowed":   result["actual_hits_allowed"],
            "actual_walks":          result["actual_walks"],
            "actual_earned_runs":    result["actual_earned_runs"],
            "actual_outs_recorded":  result["actual_outs_recorded"],
            "actual_win":            actual_win,
            "actual_pitcher_fantasy_score": actual_pitcher_fp,
            "home_away":             side,
            "opp_k_rate":            opp_k_rate,
            "days_rest":             days_rest,
            # Existing context features — all nullable.
            "lineup_lhh_pct":        hand_split["lineup_lhh_pct"],
            "lineup_rhh_pct":        hand_split["lineup_rhh_pct"],
            "park_factor_k":         park_k,
            "park_factor_hits":      park_h,
            "pitcher_fastball_pct":  pitch_mix["pitcher_fastball_pct"],
            "pitcher_breaking_pct":  pitch_mix["pitcher_breaking_pct"],
            "pitcher_offspeed_pct":  pitch_mix["pitcher_offspeed_pct"],
            "pitcher_avg_velo":      pitch_mix["pitcher_avg_velo"],
            "pitcher_pitches_last_start": pitch_mix["pitcher_pitches_last_start"],
            # Data-foundation: rest & workload
            "pitcher_days_rest":           rest["pitcher_days_rest"],
            "pitcher_starts_last_21d":     rest["pitcher_starts_last_21d"],
            "pitcher_pitches_last_3starts": rest["pitcher_pitches_last_3starts"],
            "pitcher_innings_last_21d":    rest["pitcher_innings_last_21d"],
            "team_games_last_3d":          team_density["team_games_last_3d"],
            "team_games_last_7d":          team_density["team_games_last_7d"],
            # Data-foundation: pitcher form
            "pitcher_k_rate_last3":        pform["pitcher_k_rate_last3"],
            "pitcher_era_last3":           pform["pitcher_era_last3"],
            "pitcher_whip_last3":          pform["pitcher_whip_last3"],
            # Data-foundation: platoon splits (logged historically now)
            "pitcher_k_vs_lhh_30d":        platoon_30["pitcher_k_vs_lhh_30d"],
            "pitcher_k_vs_rhh_30d":        platoon_30["pitcher_k_vs_rhh_30d"],
            "pitcher_whiff_pct_30d":       platoon_30["pitcher_whiff_pct_30d"],
            "pitcher_csw_pct_30d":         platoon_30["pitcher_csw_pct_30d"],
            # Data-foundation: series / game context
            "series_game_number":          series["series_game_number"],
            "is_getaway_day":              series["is_getaway_day"],
            "is_day_game":                 is_day,
            "is_home_team":                side == "home",
            # Data-foundation: weather
            "temperature_f":               wx["temperature_f"],
            "wind_speed_mph":              wx["wind_speed_mph"],
            "wind_dir":                    wx["wind_dir"],
            "precipitation_pct":           wx["precipitation_pct"],
            "is_dome":                     wx["is_dome"],
        })
        win_marker = "W" if actual_win else "—"
        print(
            f"  player {player_id}: projected {proj['projection']} K"
            f" -> actual {result['actual_strikeouts']} K"
            f" / {result['actual_hits_allowed']} H"
            f" / {result['actual_walks']} BB"
            f" / {result['actual_earned_runs']} ER"
            f" / {result['actual_outs_recorded']} outs"
            f"  ({win_marker}, FP {actual_pitcher_fp:.1f}, rest {days_rest}d, opp K% {opp_k_rate:.3f})"
        )

    print(f"  graded {len(rows)} / {len(by_pitcher)} projected pitchers")
    if rows:
        sample = rows[0]
        new_feats = [
            "pitcher_days_rest", "pitcher_starts_last_21d",
            "pitcher_k_rate_last3", "pitcher_k_vs_lhh_30d",
            "pitcher_whiff_pct_30d", "series_game_number",
            "temperature_f", "is_day_game",
        ]
        logged = {k: sample.get(k) for k in new_feats}
        print(
            f"  [data-foundation] sample pitcher row (player "
            f"{sample['player_id']}): {logged}"
        )
    return rows


# ─── hitter grading ──────────────────────────────────────────────────────────

def _hitter_result(box: dict, player_id: int) -> dict | None:
    """Return a dict of actual batting stats for one hitter from a boxscore.

    Returns None if the hitter didn't bat in this game (benched, scratched,
    pinch-runner only, or a data gap).

    Keys returned:
        home_away          str   'home' | 'away'
        actual_hits        int
        actual_total_bases int
        actual_rbis        int
        actual_runs        int
        actual_home_runs   int
        doubles            int   (component for fantasy score)
        triples            int
        walks              int
        hit_by_pitch       int
        stolen_bases       int

    The five component fields below the five existing actuals are needed
    to compute PrizePicks fantasy score from the same boxscore — see
    fantasy_score.hitter_fantasy_score.
    """
    for side in ("home", "away"):
        players = box.get(side, {}).get("players", {})
        entry = players.get(f"ID{player_id}", {})
        batting = entry.get("stats", {}).get("batting", {})

        # An empty batting dict means the player didn't bat in this game.
        if not batting:
            continue

        # MLB API uses 'hitByPitch' (singular) for batting-side HBP.
        #
        # totalBases is NOT in the boxscore batting object (verified via probe
        # 2026-05-31 -- batting.get('totalBases') returns None even for a
        # batter with one double). We must compute it ourselves:
        #   total_bases = hits + doubles + 2*triples + 3*home_runs
        # which is algebraically:
        #   singles*1 + doubles*2 + triples*3 + home_runs*4
        # where singles = hits - doubles - triples - home_runs.
        hits = int(batting.get("hits", 0))
        doubles = int(batting.get("doubles", 0))
        triples = int(batting.get("triples", 0))
        home_runs = int(batting.get("homeRuns", 0))
        total_bases = hits + doubles + 2 * triples + 3 * home_runs

        return {
            "home_away":          side,
            "actual_hits":        hits,
            "actual_total_bases": total_bases,
            "actual_hits_runs_rbis": hits
            + int(batting.get("runs", 0))
            + int(batting.get("rbi", 0)),
            "actual_rbis":        int(batting.get("rbi", 0)),
            "actual_runs":        int(batting.get("runs", 0)),
            "actual_home_runs":   home_runs,
            "doubles":            doubles,
            "triples":            triples,
            "walks":              int(batting.get("baseOnBalls", 0)),
            "hit_by_pitch":       int(batting.get("hitByPitch", 0)),
            "stolen_bases":       int(batting.get("stolenBases", 0)),
        }

    return None


def grade_hitters_yesterday(
    grade_date: date | None = None,
    projections: list[ProjectionContextRow] | None = None,
) -> list[HitterGameLogRow]:
    """Grade the previous day's hitter projections against actual box scores.

    Same shape and graceful behavior as grade_yesterday(), but for hitter prop
    types. Returns rows for player_game_logs with player_type='hitter'. No DB
    writes here.

    projections: optional pre-fetched projection rows (same as grade_yesterday).
    """
    yesterday = grade_date or (date.today() - timedelta(days=1))
    yesterday_str = yesterday.strftime("%Y-%m-%d")
    print(f"  grading hitter projections for {yesterday_str}...")

    if projections is None:
        projections = db.get_projections_for_date(yesterday_str)
    hitter_projs = [p for p in projections if (p.get("prop_type") or "").startswith("hitter_")]
    if not hitter_projs:
        print(f"  no hitter projections found for {yesterday_str} -- nothing to grade")
        return []

    schedule = statsapi.schedule(date=yesterday_str)
    final_ids = {g["game_id"] for g in schedule if "Final" in (g.get("status") or "")}
    if not final_ids:
        print(f"  no Final games for {yesterday_str} -- skipping hitter grading")
        return []

    # One entry per (player_id, game_id). Prefer the hitter_hits row so the
    # stored `projection` tracks the hits projection (parallels strikeouts).
    by_hitter: dict[tuple[int, int], dict] = {}
    for proj in hitter_projs:
        key = (proj["player_id"], proj["game_id"])
        if key not in by_hitter or proj.get("prop_type") == "hitter_hits":
            by_hitter[key] = proj

    box_cache: dict[int, dict] = {}

    rows: list[dict] = []
    for proj in by_hitter.values():
        game_id = proj["game_id"]
        player_id = proj["player_id"]

        if game_id not in final_ids:
            continue

        if game_id not in box_cache:
            box_cache[game_id] = _boxscore(game_id)

        result = _hitter_result(box_cache[game_id], player_id)
        if result is None:
            print(f"  hitter {player_id} did not bat in game {game_id} -- skipped")
            continue

        # PrizePicks fantasy score from the same boxscore components,
        # via the single source of truth in fantasy_score.py.
        actual_hitter_fp = hitter_fantasy_score(
            hits=result["actual_hits"],
            doubles=result["doubles"],
            triples=result["triples"],
            home_runs=result["actual_home_runs"],
            runs=result["actual_runs"],
            rbis=result["actual_rbis"],
            walks=result["walks"],
            hit_by_pitch=result["hit_by_pitch"],
            stolen_bases=result["stolen_bases"],
        )

        # ── opposing starting pitcher quality ─────────────────────────────
        # Opposing SP is the pitcher who appeared with pitchingOrder == 1 on
        # the OTHER side. We log their recent-5-start ERA / WHIP / K-rate so
        # the hitter prop model can condition on matchup difficulty.
        opp_side = "away" if result["home_away"] == "home" else "home"
        opp_sp_id, opp_sp_hand = _opp_starting_pitcher(box_cache[game_id], opp_side)
        sp_stats = _opp_sp_recent_stats(opp_sp_id, yesterday)

        # Park factor for the venue (proj['home_team']).
        park_h = get_park_factor_hits(proj["home_team"] or "")

        # Hitter's recent batting rate (rough proxy — until we log per-game
        # opp_sp_hand historically, this is just the last-15-games average
        # hits-per-PA estimate. Improves automatically as data accumulates.)
        hitter_games = stats.get_hitter_games(player_id, 60, yesterday) or []
        if hitter_games:
            recent_games = hitter_games[:15]
            recent_avg = sum(g["hits"] for g in recent_games) / max(
                len(recent_games) * 3.5, 1
            )
        else:
            recent_avg = 0.250

        # ── data-foundation features (Step 2-7 of the sprint) ─────────────
        own_team_hitter = (
            proj["home_team"] if result["home_away"] == "home"
            else proj["away_team"]
        )
        opp_team_hitter = (
            proj["away_team"] if result["home_away"] == "home"
            else proj["home_team"]
        )

        # Rolling form (avg, K rate, OPS, HR over last 7-15 games).
        hform = stats.get_hitter_form(player_id, yesterday)

        # Team schedule density (own team).
        td = stats.get_team_schedule_density(own_team_hitter or "", yesterday)
        # Hitter-specific games_last_7d: the hitter's actual game count.
        hitter_recent7 = [
            g for g in hitter_games
            if (yesterday - timedelta(days=7)).strftime("%Y-%m-%d")
               <= g["game_date"] <= yesterday.strftime("%Y-%m-%d")
        ]

        # Opponent bullpen aggregates (currently all-None — column scaffold).
        bp = stats.get_bullpen_metrics(opp_team_hitter or "", yesterday)

        # Series + day-game.
        series = stats.get_series_context(
            own_team_hitter or "", opp_team_hitter or "", yesterday
        )
        start_time_iso = proj.get("start_time")
        is_day = _is_day_game(start_time_iso)

        # Weather (dome-aware, NULL when no key).
        wx = weather.get_game_weather(
            proj["home_team"] or "", _parse_game_time(start_time_iso)
        )

        rows.append({
            "player_id":          player_id,
            "game_id":            game_id,
            "game_date":          yesterday_str,
            "player_type":        "hitter",
            "actual_hits":        result["actual_hits"],
            "actual_total_bases": result["actual_total_bases"],
            "actual_hits_runs_rbis": result["actual_hits_runs_rbis"],
            "actual_rbis":        result["actual_rbis"],
            "actual_runs":        result["actual_runs"],
            "actual_home_runs":   result["actual_home_runs"],
            "doubles":            result["doubles"],
            "triples":            result["triples"],
            "hit_by_pitch":       result["hit_by_pitch"],
            "stolen_bases":       result["stolen_bases"],
            "actual_hitter_fantasy_score": actual_hitter_fp,
            "home_away":          result["home_away"],
            # Existing context features — all nullable.
            "opp_sp_k_rate_last5": sp_stats["opp_sp_k_rate_last5"],
            "opp_sp_era_last5":    sp_stats["opp_sp_era_last5"],
            "opp_sp_whip_last5":   sp_stats["opp_sp_whip_last5"],
            "opp_sp_hand":         opp_sp_hand,
            "park_factor_hits_h":  park_h,
            "hitter_avg_vs_hand":  round(float(recent_avg), 3),
            # Data-foundation: schedule density + day-game
            "team_games_last_3d":  td["team_games_last_3d"],
            "team_games_last_7d":  td["team_games_last_7d"],
            "hitter_games_last_7d": len(hitter_recent7),
            "is_day_game":         is_day,
            # Data-foundation: hitter form
            "hitter_avg_last7":    hform["hitter_avg_last7"],
            "hitter_avg_last15":   hform["hitter_avg_last15"],
            "hitter_k_rate_last7": hform["hitter_k_rate_last7"],
            "hitter_ops_last15":   hform["hitter_ops_last15"],
            "hitter_hr_last15":    hform["hitter_hr_last15"],
            # Data-foundation: opp bullpen (scaffold — all None for now)
            "opp_bullpen_era_14d":        bp["opp_bullpen_era_14d"],
            "opp_bullpen_k_rate_14d":     bp["opp_bullpen_k_rate_14d"],
            "opp_bullpen_whip_14d":       bp["opp_bullpen_whip_14d"],
            "opp_bullpen_innings_last3d": bp["opp_bullpen_innings_last3d"],
            # Data-foundation: series + travel
            "series_game_number":  series["series_game_number"],
            "is_getaway_day":      series["is_getaway_day"],
            "is_home_team":        result["home_away"] == "home",
            # Data-foundation: weather
            "temperature_f":       wx["temperature_f"],
            "wind_speed_mph":      wx["wind_speed_mph"],
            "wind_dir":            wx["wind_dir"],
            "precipitation_pct":   wx["precipitation_pct"],
            "is_dome":             wx["is_dome"],
        })
        print(
            f"  hitter {player_id}: projected {proj['projection']}"
            f" -> {result['actual_hits']} H"
            f" / {result['actual_total_bases']} TB"
            f" / {result['actual_rbis']} RBI"
            f" / {result['actual_runs']} R"
            f" / {result['actual_home_runs']} HR"
            f"  (FP {actual_hitter_fp:.1f})"
        )

    print(f"  graded {len(rows)} / {len(by_hitter)} projected hitters")
    if rows:
        sample = rows[0]
        new_feats = [
            "hitter_avg_last7", "hitter_avg_last15", "hitter_k_rate_last7",
            "hitter_ops_last15", "hitter_hr_last15", "hitter_games_last_7d",
            "series_game_number", "temperature_f", "is_day_game",
        ]
        logged = {k: sample.get(k) for k in new_feats}
        print(
            f"  [data-foundation] sample hitter row (player "
            f"{sample['player_id']}): {logged}"
        )
    return rows
