"""MLB Stats API data fetchers and team-rate helpers.

Pure fetch layer — no Statcast, no DB code, no math beyond unit conversion.
All functions return plain Python dicts shaped for downstream consumers.

Also owns team K-rate helpers (_opp_k_rate and friends) because they are
data-fetching utilities, not model logic. grade.py and model.py import from
here so the logic lives in exactly one place.
"""

from datetime import date, timedelta
from functools import lru_cache

import requests
import statsapi

from constants import LEAGUE_AVG_K_PCT, TEAM_NAME_TO_ID


# ─── FanGraphs anti-403 shim ─────────────────────────────────────────────────
# FanGraphs returns 403 to requests carrying the default python-requests UA on
# the GitHub Actions runner. Monkey-patch a browser UA as the default on every
# requests.Session so pybaseball's internal calls inherit it. Idempotent: only
# fills in a UA when the caller hasn't set one.

_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

if not getattr(requests.Session, "_mlb_props_ua_patched", False):
    _orig_request = requests.Session.request

    def _request_with_ua(self, method, url, **kwargs):  # type: ignore[no-redef]
        headers = dict(kwargs.pop("headers", None) or {})
        headers.setdefault("User-Agent", _BROWSER_UA)
        headers.setdefault("Accept-Language", "en-US,en;q=0.9")
        kwargs["headers"] = headers
        return _orig_request(self, method, url, **kwargs)

    requests.Session.request = _request_with_ua  # type: ignore[assignment]
    requests.Session._mlb_props_ua_patched = True  # type: ignore[attr-defined]


# Hardcoded 2024 team batting K% (FanGraphs season totals, fraction form).
# Used as a last-resort fallback when FanGraphs 403s the Actions runner three
# times in a row. Keyed by FanGraphs team abbreviation — same key space as
# _team_k_pcts() so callers don't have to branch.
_TEAM_K_PCT_2024 = {
    "ARI": 0.218, "ATL": 0.227, "BAL": 0.221, "BOS": 0.226,
    "CHC": 0.238, "CWS": 0.256, "CIN": 0.230, "CLE": 0.216,
    "COL": 0.238, "DET": 0.238, "HOU": 0.200, "KC":  0.195,
    "LAA": 0.247, "LAD": 0.218, "MIA": 0.240, "MIL": 0.241,
    "MIN": 0.230, "NYM": 0.231, "NYY": 0.229, "OAK": 0.238,
    "ATH": 0.238, "PHI": 0.228, "PIT": 0.228, "SD":  0.218,
    "SF":  0.224, "SEA": 0.242, "STL": 0.218, "TB":  0.226,
    "TEX": 0.226, "TOR": 0.203, "WSH": 0.224,
}


# ─── team K-rate helpers ─────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _mlb_name_to_abbr() -> dict:
    """Full team name (MLB Stats API) -> abbreviation, e.g. 'New York Yankees' -> 'NYY'."""
    try:
        resp = statsapi.get("teams", {"sportId": 1, "activeStatus": "Yes"})
        return {t["name"]: t["abbreviation"] for t in resp.get("teams", [])}
    except Exception:
        return {}


@lru_cache(maxsize=4)
def _team_k_pcts(year: int) -> dict:
    """Season team batting K%, keyed by FanGraphs abbreviation. Cached per year.

    Source: MLB Stats API teams_stats endpoint (statsapi.mlb.com), same
    authoritative source MLB.com publishes. No scraping, no User-Agent
    games, no 403s -- replaces the previous pybaseball/FanGraphs path
    which Cloudflare-blocks every Actions runner.

    Returns a dict like {'NYY': 0.229, 'BAL': 0.221, ...}. Keys are the
    FanGraphs abbreviations from TEAM_NAME_MAP so _opp_k_rate's lookup
    logic is unchanged.

    Falls back to _TEAM_K_PCT_2024 if the API fails or fewer than 20 of
    30 teams resolve -- belt-and-suspenders for early-season runs where
    sample sizes are tiny and for unexpected name-mapping drift.
    """
    expected_abbrs = set(TEAM_NAME_MAP.values())
    HEALTHY_MATCH = 20

    try:
        resp = statsapi.get(
            "teams_stats",
            {
                "season": year,
                "sportIds": 1,
                "group": "hitting",
                "stats": "season",
            },
        )
    except Exception as exc:
        print(
            f"  MLB Stats API teams_stats({year}) failed: {exc}; "
            f"using 2024 fallback table"
        )
        return dict(_TEAM_K_PCT_2024)

    result: dict[str, float] = {}
    for entry in resp.get("stats", []):
        if entry.get("group", {}).get("displayName") != "hitting":
            continue
        if entry.get("type", {}).get("displayName") != "season":
            continue
        for split in entry.get("splits", []):
            team_name = (split.get("team") or {}).get("name") or ""
            abbr = TEAM_NAME_MAP.get(team_name)
            if not abbr:
                continue
            stat = split.get("stat") or {}
            try:
                so = float(stat.get("strikeOuts", 0) or 0)
                pa = float(stat.get("plateAppearances", 0) or 0)
            except (TypeError, ValueError):
                continue
            if pa > 0:
                result[abbr] = so / pa

    overlap = len(set(result.keys()) & expected_abbrs)
    if overlap >= HEALTHY_MATCH:
        return result

    print(
        f"  WARNING: MLB Stats API teams_stats({year}) matched only "
        f"{overlap}/30 teams; using 2024 fallback table"
    )
    return dict(_TEAM_K_PCT_2024)


# MLB Stats API full team name -> FanGraphs team abbreviation (the key
# _team_k_pcts uses). The statsapi abbreviation often differs from FanGraphs'
# (e.g. statsapi 'AZ' vs FanGraphs 'ARI'), so mapping the full name straight to
# the FanGraphs key avoids silent fallbacks. Covers all 30 teams.
TEAM_NAME_MAP = {
    "Arizona Diamondbacks":  "ARI",
    "Atlanta Braves":        "ATL",
    "Baltimore Orioles":     "BAL",
    "Boston Red Sox":        "BOS",
    "Chicago Cubs":          "CHC",
    "Chicago White Sox":     "CWS",
    "Cincinnati Reds":       "CIN",
    "Cleveland Guardians":   "CLE",
    "Colorado Rockies":      "COL",
    "Detroit Tigers":        "DET",
    "Houston Astros":        "HOU",
    "Kansas City Royals":    "KC",
    "Los Angeles Angels":    "LAA",
    "Los Angeles Dodgers":   "LAD",
    "Miami Marlins":         "MIA",
    "Milwaukee Brewers":     "MIL",
    "Minnesota Twins":       "MIN",
    "New York Mets":         "NYM",
    "New York Yankees":      "NYY",
    "Oakland Athletics":     "OAK",   # pre-2025 (FanGraphs historical key)
    "Athletics":             "ATH",   # 2025+ rebrand; statsapi current full name
    "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates":    "PIT",
    "San Diego Padres":      "SD",
    "San Francisco Giants":  "SF",
    "Seattle Mariners":      "SEA",
    "St. Louis Cardinals":   "STL",
    "Tampa Bay Rays":        "TB",
    "Texas Rangers":         "TEX",
    "Toronto Blue Jays":     "TOR",
    "Washington Nationals":  "WSH",
}


@lru_cache(maxsize=128)
def _opp_k_rate(opp_team_full_name: str, year: int) -> float:
    """K% of the opposing team as batters (0-1). Falls back to league average.

    Resolution order: TEAM_NAME_MAP (full name -> FanGraphs abbr), then the
    statsapi abbreviation, then a WARNING + league-average fallback so any
    unmatched team surfaces in the Actions log instead of silently degrading.
    """
    k_pcts = _team_k_pcts(year)

    # 1. Mapped FanGraphs abbreviation (preferred -- covers all 30 teams).
    mapped = TEAM_NAME_MAP.get(opp_team_full_name)
    if mapped and mapped in k_pcts:
        return k_pcts[mapped]

    # 2. Original name -> statsapi abbreviation.
    abbr = _mlb_name_to_abbr().get(opp_team_full_name)
    if abbr and abbr in k_pcts:
        return k_pcts[abbr]

    # 3. No match -- surface it so the mismatch is visible, then fall back.
    print(
        f"  WARNING: no FanGraphs K% match for team '{opp_team_full_name}' "
        f"(mapped={mapped}, abbr={abbr}) -- using league average"
    )
    return LEAGUE_AVG_K_PCT


def _parse_innings(ip_str: str) -> int:
    """Convert an inningsPitched string to total outs recorded.

    Baseball notation: "6.2" means 6 full innings + 2 outs = 20 outs.
    The fractional part is *outs*, not tenths of an inning.
    """
    try:
        whole, partial = str(ip_str).split(".")
        return int(whole) * 3 + int(partial)
    except Exception:
        return 0


@lru_cache(maxsize=64)
def get_pitcher_starts(
    player_id: int,
    lookback_days: int,
    end_date: date,
) -> list[dict]:
    """Return per-start pitching stats for one pitcher over a lookback window.

    Uses the MLB Stats API game-log endpoint — fast, no Statcast download.
    Returns newest start first. Returns [] gracefully on any API error.

    Each dict has keys:
        game_date       str  'YYYY-MM-DD'
        strikeouts      int
        hits_allowed    int
        walks           int
        earned_runs     int
        outs_recorded   int   (inningsPitched converted to outs)
        home_runs       int   (HR allowed; feeds opp-SP HR/9)
    """
    start_date = end_date - timedelta(days=lookback_days)
    season = end_date.year

    try:
        raw = statsapi.get(
            "person",
            {
                "personId": player_id,
                "hydrate": f"stats(group=pitching,type=gameLog,season={season})",
            },
        )
    except Exception as exc:
        print(f"  statsapi error for player {player_id}: {exc}")
        return []

    splits: list[dict] = []
    for stat_group in raw.get("people", [{}])[0].get("stats", []):
        if stat_group.get("type", {}).get("displayName") == "gameLog":
            splits = stat_group.get("splits", [])
            break

    results: list[dict] = []
    for sp in splits:
        try:
            game_date = date.fromisoformat(sp["date"])
        except Exception:
            continue

        # STRICT-PRIOR boundary: < end_date (not <=). A projection or grade
        # anchored to end_date must NEVER include the start ON end_date — the
        # game being projected/graded itself — so a mid-game rebuild can never
        # pull an in-progress start into its own projection. (The form helpers
        # already re-filter < game_date; this makes the baseline builders safe
        # too. See the projection-freeze hardening.)
        if not (start_date <= game_date < end_date):
            continue

        st = sp.get("stat", {})
        results.append(
            {
                "game_date": sp["date"],
                "strikeouts": int(st.get("strikeOuts", 0)),
                "hits_allowed": int(st.get("hits", 0)),
                "walks": int(st.get("baseOnBalls", 0)),
                "earned_runs": int(st.get("earnedRuns", 0)),
                "outs_recorded": _parse_innings(st.get("inningsPitched", "0.0")),
                "home_runs": int(st.get("homeRuns", 0)),
            }
        )

    # Newest first so callers can slice [:5] for "last 5 starts"
    results.sort(key=lambda r: r["game_date"], reverse=True)
    return results


def get_pitcher_hr9_last5(
    player_id: int,
    lookback_days: int,
    end_date: date,
) -> float | None:
    """HR allowed per 9 IP over a pitcher's last 5 starts (newest within the
    window). Same data source as _opp_sp_recent_stats / the pitcher props
    (get_pitcher_starts — no new fetch). Returns None when there are no recent
    starts on file or zero innings (rookie / call-up / data gap) so the caller
    leaves opp_sp_hr9 NULL and the composite degrades the term to neutral.

    HR/9 = HR * 9 / IP = HR * 27 / total_outs.
    """
    recent = (get_pitcher_starts(player_id, lookback_days, end_date) or [])[:5]
    total_outs = sum(s.get("outs_recorded", 0) for s in recent)
    if not recent or total_outs <= 0:
        return None
    hr = sum(s.get("home_runs", 0) for s in recent)
    return round(hr * 27.0 / total_outs, 3)


@lru_cache(maxsize=512)
def get_hitter_games(
    player_id: int,
    lookback_days: int,
    end_date: date,
) -> list[dict]:
    """Return per-game hitting stats for one batter over a lookback window.

    Uses the same MLB Stats API game-log endpoint as the pitcher fetcher
    (statsapi.get with a hydrate string), which is the approach proven to
    return splits reliably for this project. Newest game first. Returns []
    gracefully on any API error. lru_cached so all 5 hitter prop builders
    share one API call per batter per run.

    Each dict has keys:
        game_date    str  'YYYY-MM-DD'
        hits         int
        total_bases  int
        rbis         int
        runs         int
        home_runs    int
        doubles      int   (component for fantasy score)
        triples      int
        walks        int
        hit_by_pitch int
        stolen_bases int
    """
    start_date = end_date - timedelta(days=lookback_days)
    season = end_date.year

    try:
        raw = statsapi.get(
            "person",
            {
                "personId": player_id,
                "hydrate": f"stats(group=hitting,type=gameLog,season={season})",
            },
        )
    except Exception as exc:
        print(f"  statsapi error for hitter {player_id}: {exc}")
        return []

    splits: list[dict] = []
    for stat_group in raw.get("people", [{}])[0].get("stats", []):
        if stat_group.get("type", {}).get("displayName") == "gameLog":
            splits = stat_group.get("splits", [])
            break

    results: list[dict] = []
    for sp in splits:
        try:
            game_date = date.fromisoformat(sp["date"])
        except Exception:
            continue

        # STRICT-PRIOR boundary: < end_date (not <=). A projection anchored to
        # end_date must NEVER include the game ON end_date (today's in-progress
        # game), so a mid-game rebuild can't corrupt the frozen pre-game
        # projection. Form helpers already re-filter < game_date; this closes
        # the baseline-builder gap too.
        if not (start_date <= game_date < end_date):
            continue

        st = sp.get("stat", {})
        # The hitting/gameLog endpoint sometimes uses 'hitByPitch' and
        # sometimes 'hitByPitches'. Coalesce so the fantasy-score baseline
        # gets the right number regardless.
        hbp = int(st.get("hitByPitch", st.get("hitByPitches", 0)) or 0)
        results.append(
            {
                "game_date":    sp["date"],
                "hits":         int(st.get("hits", 0)),
                "total_bases":  int(st.get("totalBases", 0)),
                "rbis":         int(st.get("rbi", 0)),
                "runs":         int(st.get("runs", 0)),
                # combo prop: hits + runs + RBIs (main betting line usually 1.5)
                "hits_runs_rbis": int(st.get("hits", 0))
                + int(st.get("runs", 0))
                + int(st.get("rbi", 0)),
                "home_runs":    int(st.get("homeRuns", 0)),
                "doubles":      int(st.get("doubles", 0)),
                "triples":      int(st.get("triples", 0)),
                "walks":        int(st.get("baseOnBalls", 0)),
                "hit_by_pitch": hbp,
                "stolen_bases": int(st.get("stolenBases", 0)),
                # Extra components for hitter-form helpers. Not used by
                # the existing baseline builders or fantasy-score logic,
                # but consumed by get_hitter_form() below.
                "at_bats":     int(st.get("atBats", 0)),
                "strikeouts":  int(st.get("strikeOuts", 0)),
                "plate_appearances": int(st.get("plateAppearances", 0)),
            }
        )

    results.sort(key=lambda r: r["game_date"], reverse=True)
    return results


# ═══════════════════════════════════════════════════════════════════════════
# Data-foundation metric helpers — pure aggregation over the cached fetchers
# above. Each returns a dict shaped for one row in player_game_logs. Anything
# the source data doesn't expose comes back as None so the column stays NULL.
# ═══════════════════════════════════════════════════════════════════════════


def get_pitcher_rest_metrics(pitcher_id: int, game_date: date) -> dict:
    """Days of rest, recent workload, and innings load over the last 21d.

    Filters out any start on or after game_date — the model is logging
    features for THE start on game_date, so days_rest is the gap from the
    pitcher's PRIOR start to game_date, not the start being graded.

    Reuses get_pitcher_starts (lru_cached) so multiple metric helpers in
    one grading run only pay the statsapi cost once per pitcher.
    """
    raw = get_pitcher_starts(pitcher_id, 30, game_date)
    # Strict-prior filter: exclude any start dated game_date or later so
    # the "last start" reference is genuinely the one BEFORE today's.
    starts: list[dict] = []
    for s in raw or []:
        try:
            sd = date.fromisoformat(s["game_date"])
        except Exception:
            continue
        if sd < game_date:
            starts.append(s)

    if not starts:
        return {
            "pitcher_days_rest":           None,
            "pitcher_starts_last_21d":     0,
            "pitcher_pitches_last_3starts": None,
            "pitcher_innings_last_21d":    0.0,
        }
    try:
        last_date = date.fromisoformat(starts[0]["game_date"])
        days_rest = (game_date - last_date).days
    except Exception:
        days_rest = None
    cutoff_21 = game_date - timedelta(days=21)
    recent_21 = [
        s for s in starts
        if date.fromisoformat(s["game_date"]) >= cutoff_21
    ]
    # Per-start pitch counts aren't in the statsapi gameLog schema we pull —
    # leave the field None rather than fabricate.
    return {
        "pitcher_days_rest":           days_rest,
        "pitcher_starts_last_21d":     len(recent_21),
        "pitcher_pitches_last_3starts": None,
        "pitcher_innings_last_21d":    round(
            sum(s["outs_recorded"] for s in recent_21) / 3, 1
        ),
    }


def get_team_schedule_density(team: str, game_date: date) -> dict:
    """How many games has `team` played in the last 3 / 7 days?

    Uses statsapi.schedule filtered to the team's recent games. Returns
    None for both fields on any API failure so downstream code can treat
    them uniformly.
    """
    if not team:
        return {"team_games_last_3d": None, "team_games_last_7d": None}
    # statsapi.schedule(team=...) requires an int team id, not the name string.
    team_id = TEAM_NAME_TO_ID.get(team)
    if team_id is None:
        return {"team_games_last_3d": None, "team_games_last_7d": None}
    start = (game_date - timedelta(days=7)).strftime("%Y-%m-%d")
    end = (game_date - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        games = statsapi.schedule(start_date=start, end_date=end, team=team_id)
    except Exception:
        return {"team_games_last_3d": None, "team_games_last_7d": None}
    g3_cutoff = game_date - timedelta(days=3)
    games_3d = 0
    for g in games or []:
        try:
            gd = date.fromisoformat(g.get("game_date", ""))
        except Exception:
            continue
        if gd >= g3_cutoff:
            games_3d += 1
    return {
        "team_games_last_3d": games_3d,
        "team_games_last_7d": len(games or []),
    }


def _compute_ops(games: list[dict]) -> float | None:
    """Approximate OPS (OBP + SLG) from per-game hitting components.

    Components needed: at_bats, hits, doubles, triples, home_runs, walks,
    hit_by_pitch. Returns None when at_bats sum is zero.
    """
    if not games:
        return None
    ab = sum(int(g.get("at_bats") or 0) for g in games)
    if ab == 0:
        return None
    h    = sum(int(g.get("hits") or 0) for g in games)
    db   = sum(int(g.get("doubles") or 0) for g in games)
    tp   = sum(int(g.get("triples") or 0) for g in games)
    hr   = sum(int(g.get("home_runs") or 0) for g in games)
    bb   = sum(int(g.get("walks") or 0) for g in games)
    hbp  = sum(int(g.get("hit_by_pitch") or 0) for g in games)
    singles = max(h - db - tp - hr, 0)
    tb = singles + 2 * db + 3 * tp + 4 * hr
    slg = tb / ab
    obp_denom = ab + bb + hbp
    obp = (h + bb + hbp) / obp_denom if obp_denom > 0 else 0.0
    return round(obp + slg, 3)


def get_hitter_form(hitter_id: int, game_date: date) -> dict:
    """Rolling 7- and 15-game batting average + 7-game K rate + 15-game OPS
    and HR count. Returns all-None when no recent games are on file.

    Filters strictly-prior to game_date — "last 7 / 15 games" must refer
    to history BEFORE the game we're grading today.
    """
    raw = get_hitter_games(hitter_id, 30, game_date)
    games: list[dict] = []
    for g in raw or []:
        try:
            gd = date.fromisoformat(g["game_date"])
        except Exception:
            continue
        if gd < game_date:
            games.append(g)
    if not games:
        return {
            "hitter_avg_last7":    None,
            "hitter_avg_last15":   None,
            "hitter_k_rate_last7": None,
            "hitter_ops_last15":   None,
            "hitter_hr_last15":    None,
        }
    last7 = games[:7]
    last15 = games[:15]

    def batting_avg(gs: list[dict]) -> float | None:
        ab = sum(int(g.get("at_bats") or 0) for g in gs)
        if ab == 0:
            return None
        h = sum(int(g.get("hits") or 0) for g in gs)
        return round(h / ab, 3)

    pa7 = sum(int(g.get("plate_appearances") or 0) for g in last7)
    if pa7 == 0:
        pa7 = sum(
            int(g.get("at_bats") or 0)
            + int(g.get("walks") or 0)
            + int(g.get("hit_by_pitch") or 0)
            for g in last7
        )
    k7 = sum(int(g.get("strikeouts") or 0) for g in last7)

    return {
        "hitter_avg_last7":    batting_avg(last7),
        "hitter_avg_last15":   batting_avg(last15),
        "hitter_k_rate_last7": round(k7 / pa7, 3) if pa7 > 0 else None,
        "hitter_ops_last15":   _compute_ops(last15),
        "hitter_hr_last15":    sum(int(g.get("home_runs") or 0) for g in last15),
    }


def get_pitcher_form(pitcher_id: int, game_date: date) -> dict:
    """Rolling K rate / ERA / WHIP from the pitcher's last 3 starts.

    Filters strictly-prior to game_date — see get_pitcher_rest_metrics for
    the same reasoning. The "last 3 starts" reference must exclude the
    start being graded today.
    """
    raw = get_pitcher_starts(pitcher_id, 30, game_date)
    starts: list[dict] = []
    for s in raw or []:
        try:
            sd = date.fromisoformat(s["game_date"])
        except Exception:
            continue
        if sd < game_date:
            starts.append(s)
    if not starts:
        return {
            "pitcher_k_rate_last3": None,
            "pitcher_era_last3":    None,
            "pitcher_whip_last3":   None,
        }
    last3 = starts[:3]
    outs = sum(int(s["outs_recorded"]) for s in last3)
    ip = outs / 3 if outs > 0 else 1
    # Batters faced isn't in the gameLog response; approximate as
    # outs + hits + walks (ignores HBP / errors — small bias).
    bf_approx = max(
        sum(
            int(s["outs_recorded"])
            + int(s["hits_allowed"])
            + int(s["walks"])
            for s in last3
        ),
        1,
    )
    return {
        "pitcher_k_rate_last3": round(
            sum(int(s["strikeouts"]) for s in last3) / bf_approx, 3
        ),
        "pitcher_era_last3":    round(
            sum(int(s["earned_runs"]) for s in last3) * 9 / ip, 2
        ),
        "pitcher_whip_last3":   round(
            (
                sum(int(s["hits_allowed"]) for s in last3)
                + sum(int(s["walks"]) for s in last3)
            ) / ip, 2
        ),
    }


def get_bullpen_metrics(team: str, game_date: date) -> dict:
    """Best-effort opponent-bullpen aggregates.

    Cleanly splitting starter vs reliever stats from the public statsapi
    endpoints requires per-game role tagging that isn't exposed there.
    For this data-collection sprint we log None for every bullpen metric
    — the migration adds the columns so a future, richer fetch (Statcast
    pitcher_role or a third-party stats API) can backfill without a
    second migration.
    """
    return {
        "opp_bullpen_era_14d":        None,
        "opp_bullpen_k_rate_14d":     None,
        "opp_bullpen_whip_14d":       None,
        "opp_bullpen_innings_last3d": None,
    }


def get_series_context(team: str, opp: str, game_date: date) -> dict:
    """Series game number (1/2/3/4...) and getaway-day flag.

    Series game number = N consecutive same-opponent games ending on
    game_date. Getaway day = the next calendar day has either no game
    for this team OR a game vs a different opponent.
    """
    if not team or not opp:
        return {"series_game_number": None, "is_getaway_day": None}
    team_id = TEAM_NAME_TO_ID.get(team)
    if team_id is None:
        return {"series_game_number": None, "is_getaway_day": None}
    window_start = (game_date - timedelta(days=5)).strftime("%Y-%m-%d")
    window_end   = (game_date + timedelta(days=5)).strftime("%Y-%m-%d")
    try:
        sched = statsapi.schedule(
            start_date=window_start, end_date=window_end, team=team_id
        )
    except Exception:
        return {"series_game_number": None, "is_getaway_day": None}

    by_date: dict[str, str] = {}
    for g in sched or []:
        gd = g.get("game_date")
        away = g.get("away_name") or ""
        home = g.get("home_name") or ""
        if not gd:
            continue
        other = away if home == team else home
        by_date[gd] = other

    n = 0
    cursor = game_date
    while True:
        cs = cursor.strftime("%Y-%m-%d")
        if by_date.get(cs) == opp:
            n += 1
            cursor -= timedelta(days=1)
        else:
            break
    series_game_number = n if n > 0 else None

    tomorrow = (game_date + timedelta(days=1)).strftime("%Y-%m-%d")
    next_opp = by_date.get(tomorrow)
    is_getaway = next_opp is None or next_opp != opp

    return {
        "series_game_number": series_game_number,
        "is_getaway_day":     is_getaway,
    }
