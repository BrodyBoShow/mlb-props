"""Weather lookup for MLB venues at game time.

Pure fetch layer — talks to OpenWeatherMap, returns a dict of weather
features shaped for grade.py. Domes short-circuit to a neutral indoor
baseline (72°F / 0 mph wind) so the weather columns stay non-null for
indoor venues; the is_dome flag captures the distinction.

Graceful degradation:
- OPENWEATHER_API_KEY missing  -> all-None dict, one-line note logged once
- HTTP / parse error           -> all-None dict (per-call, no module disable)
- Venue not in VENUE_COORDS    -> all-None dict + warning log

No third-party SDK; uses the same `requests` library already imported
elsewhere in the engine. The OWM "forecast" endpoint is free up to 1000
calls/day on the public tier, more than enough for ~15 games × 6 cron
runs/day = 90 calls.
"""

import os
from datetime import date, datetime, timedelta, timezone

import requests

from constants import IS_DOME, VENUE_COORDS
from schemas import WeatherFields

_OWM_URL = "https://api.openweathermap.org/data/2.5/forecast"
_MISSING_KEY_NOTED = False


def _dome_weather() -> WeatherFields:
    """Neutral indoor baseline for dome / closed-roof venues."""
    return {
        "temperature_f":     72.0,
        "wind_speed_mph":    0.0,
        "wind_dir":          None,
        "wind_dir_deg":      None,
        "precipitation_pct": 0.0,
        "is_dome":           True,
    }


def _empty_weather(is_dome: bool = False) -> WeatherFields:
    """Used when there's no API key or the call failed. is_dome is still
    populated since we know it from the home team string alone."""
    return {
        "temperature_f":     None,
        "wind_speed_mph":    None,
        "wind_dir":          None,
        "wind_dir_deg":      None,
        "precipitation_pct": None,
        "is_dome":           is_dome,
    }


def _wind_compass(deg: float | int | None) -> str | None:
    """Compass abbreviation from degrees. None if input is None."""
    if deg is None:
        return None
    try:
        d = float(deg) % 360
    except (TypeError, ValueError):
        return None
    dirs = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
    return dirs[int((d + 11.25) / 22.5) % 16]


def _kelvin_to_f(k: float) -> float:
    return round((k - 273.15) * 9 / 5 + 32, 1)


def get_game_weather(
    home_team: str,
    game_time_utc: datetime | None,
) -> WeatherFields:
    """Forecast for `home_team`'s venue at `game_time_utc`.

    Returns {temperature_f, wind_speed_mph, wind_dir, precipitation_pct,
    is_dome}. Wind_dir is the compass abbreviation; precipitation_pct is
    0..100 (OWM "pop" * 100). Any field that can't be resolved comes back
    as None — the column stays NULL in player_game_logs.
    """
    is_dome = home_team in IS_DOME
    if is_dome:
        return _dome_weather()

    coords = VENUE_COORDS.get(home_team)
    if coords is None:
        print(f"  weather: venue coords missing for '{home_team}' — logged as NULL")
        return _empty_weather(is_dome=False)

    key = os.environ.get("OPENWEATHER_API_KEY")
    if not key:
        global _MISSING_KEY_NOTED
        if not _MISSING_KEY_NOTED:
            print(
                "  weather: OPENWEATHER_API_KEY not set — weather columns "
                "will log NULL until the key is added"
            )
            _MISSING_KEY_NOTED = True
        return _empty_weather(is_dome=False)

    lat, lon = coords
    try:
        resp = requests.get(
            _OWM_URL,
            params={"lat": lat, "lon": lon, "appid": key},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"  weather fetch failed for {home_team}: {exc}")
        return _empty_weather(is_dome=False)

    # OWM's free /forecast endpoint returns 3-hour buckets. Pick the bucket
    # whose dt is closest to game_time_utc; if game_time is missing, use
    # the first bucket (next available forecast).
    buckets = data.get("list") or []
    if not buckets:
        return _empty_weather(is_dome=False)

    if game_time_utc is None:
        chosen = buckets[0]
    else:
        target = game_time_utc.replace(tzinfo=timezone.utc).timestamp()
        chosen = min(
            buckets,
            key=lambda b: abs(float(b.get("dt", 0)) - target),
        )

    main = chosen.get("main") or {}
    wind = chosen.get("wind") or {}
    temp_k = main.get("temp")
    # OWM wind.deg is the METEOROLOGICAL direction the wind blows FROM, in
    # degrees (0=N, 90=E). We store the raw value as wind_dir_deg; the frontend
    # converts FROM→toward (+180) for the field-relative HR wind tag. wind_dir
    # (compass abbr) is derived from the same FROM degrees, so the two agree.
    wind_deg = wind.get("deg")
    return {
        "temperature_f":     _kelvin_to_f(temp_k) if temp_k is not None else None,
        "wind_speed_mph":    round(float(wind.get("speed", 0)) * 2.23694, 1)
                              if wind.get("speed") is not None else None,
        "wind_dir":          _wind_compass(wind_deg),
        "wind_dir_deg":      round(float(wind_deg), 0) if wind_deg is not None else None,
        "precipitation_pct": round(float(chosen.get("pop", 0)) * 100, 0),
        "is_dome":           False,
    }
