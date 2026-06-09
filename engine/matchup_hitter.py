"""Deterministic batter-vs-pitcher matchup projection — SHADOW / VALIDATION.

Symmetric to engine/matchup_k.py, but for HITTER props. Builds ONE per-PA
outcome distribution for a batter facing a specific pitcher via Bill James
log5, scales it by the batter's expected plate appearances (lineup slot),
splits those PAs between the opposing STARTER and the bullpen, and reads
total_bases / hits / home_runs off the distribution analytically.

Pure math: no DB, no API. The caller gathers the batter's per-PA outcome
COUNTS + PA, the opposing pitcher's allowed COUNTS + PA, handedness, lineup
slot, the starter's expected batters-faced, and the park factor, and passes
them in.

HONESTY (do not oversell): a hitter's single game is ~4 PA of binomial noise.
This does NOT move the point projection much — it nudges the over/under
probability a few honest points. Runs in SHADOW + offline validation
(engine/validate_matchup_hitter.py) until it beats the stabilized talent
baseline (baseline._stabilized_projection) on the held-out test set, PER PROP.
HR is expected to show ~0 single-game signal and likely never flips.

DESIGN
- The per-PA core is prop-agnostic: one 8-way categorical (OUT / 1B / 2B / 3B /
  HR / BB / HBP / K). Every hitter prop is read off this one distribution.
- Stage 1 = opposing-starter matchup only. Each PA the batter is expected to
  take vs the STARTER uses the log5 matchup rate; the remaining PAs (vs the
  bullpen) fall back to the batter's own regressed rate (= log5 vs a league
  pitcher), so the starter's influence is naturally bounded to ~2-3 PAs and we
  don't overstate it. Bullpen-quality + the times-through-order ramp are a
  later stage (they multiply the bullpen/starter terms here).
- Reuses matchup_k.log5 — the exact same odds-ratio combiner validated for K.
"""

from matchup_k import log5

# ─── league per-PA outcome rates (the log5 anchor + shrink target) ───────────
# 2024-25 MLB averages, per plate appearance. Sum of non-OUT ≈ 0.526; the OUT
# bucket (balls-in-play outs + K-not-counted-here, sacs, etc.) is the remainder.
LEAGUE_PA_RATES: dict[str, float] = {
    "K":   0.220,
    "BB":  0.083,
    "HBP": 0.011,
    "HR":  0.030,
    "3B":  0.004,
    "2B":  0.043,
    "1B":  0.135,
}
_CONTACT = ("1B", "2B", "3B", "HR")          # outcomes park/platoon act on
_OUTCOMES = ("K", "BB", "HBP", "HR", "3B", "2B", "1B")

# ─── per-outcome stabilization (PA at which the rate is ~half-reliable) ───────
# Russell Carleton / sabermetric stabilization points. Discipline stats (K, BB,
# HR) stabilize fast and earn per-batter weight; XBH (2B/3B) stabilize so slowly
# they stay essentially league (regress hard). This is regress_k_pct generalized
# with a per-stat constant instead of one shared K_PCT_REGRESSION_PA.
STABILIZE_PA: dict[str, float] = {
    "K":   60.0,
    "BB":  120.0,
    "HBP": 240.0,
    "HR":  170.0,
    "1B":  290.0,
    "2B":  1610.0,
    "3B":  1610.0,
}

# Hitter platoon: batters hit modestly BETTER vs the opposite hand (the reverse
# of the pitcher-K platoon). Bounded, handedness-only, applied to CONTACT rates
# only (never K/BB). Switch hitters always bat opposite → ~neutral.
HITTER_PLATOON_OPP = 1.03    # +3% contact vs opposite hand
HITTER_PLATOON_SAME = 0.98   # -2% contact vs same hand
HITTER_PLATOON_SWITCH = 1.0

# Expected PAs per lineup SLOT over a full 9-inning game (top-of-order turns
# over more). League-average full-game PA-per-slot; sums ≈ 38.2 ≈ a team's
# game PA total. UNLIKE matchup_k's curve this is NOT scaled to a pitcher's IP —
# a confirmed starter bats the whole game.
HITTER_SLOT_PA = [4.65, 4.55, 4.45, 4.35, 4.25, 4.15, 4.05, 3.95, 3.85]
DEFAULT_SLOT = 5             # fallback when the batting slot is unknown
BF_PER_INNING = 4.3
DEFAULT_STARTER_BF = 24.0    # ~5.5 IP fallback when a starter's workload is unknown

# Sane per-PA bounds so a degenerate input can't produce an absurd rate.
_MIN_RATE = 1e-4
_MAX_CONTACT = 0.70


# ─── per-PA core ─────────────────────────────────────────────────────────────

def regress_rate(count: float, pa: float, league_rate: float, m: float) -> float:
    """Shrink an observed per-PA rate toward league with a stabilization prior:
    (count + league*m) / (pa + m). Same shape as matchup_k.regress_k_pct."""
    return (float(count or 0.0) + league_rate * m) / ((float(pa or 0.0)) + m)


def regressed_pa_rates(counts: dict, pa: float) -> dict[str, float]:
    """Regress every observed outcome count to a stable per-PA rate."""
    return {
        e: regress_rate(counts.get(e, 0.0), pa, LEAGUE_PA_RATES[e], STABILIZE_PA[e])
        for e in _OUTCOMES
    }


def platoon_contact_factor(batter_hand: str | None, pitcher_hand: str | None) -> float:
    """Bounded handedness nudge on CONTACT outcomes. 1.0 when either is unknown."""
    if not batter_hand or not pitcher_hand:
        return 1.0
    if batter_hand == "S":
        return HITTER_PLATOON_SWITCH
    return HITTER_PLATOON_SAME if batter_hand == pitcher_hand else HITTER_PLATOON_OPP


def matchup_pa_dist(
    batter_rates: dict[str, float],
    pitcher_rates: dict[str, float],
    batter_hand: str | None = None,
    pitcher_hand: str | None = None,
    park_factor: float = 1.0,
) -> dict[str, float]:
    """Combine batter × pitcher per-PA rates via log5, apply platoon + park to
    contact, and return a proper 8-way distribution (the 7 outcomes + OUT)."""
    pf = platoon_contact_factor(batter_hand, pitcher_hand)
    dist: dict[str, float] = {}
    for e in _OUTCOMES:
        r = log5(batter_rates[e], pitcher_rates[e], LEAGUE_PA_RATES[e])
        if e in _CONTACT:
            r = r * pf * (park_factor if park_factor else 1.0)
            r = min(max(r, _MIN_RATE), _MAX_CONTACT)
        else:
            r = min(max(r, _MIN_RATE), 0.60)
        dist[e] = r
    non_out = sum(dist.values())
    if non_out >= 1.0:                         # degenerate: renormalize onto a tiny OUT
        scale = 0.999 / non_out
        for e in _OUTCOMES:
            dist[e] *= scale
        non_out = sum(dist.values())
    dist["OUT"] = max(1.0 - non_out, 0.0)
    return dist


def _per_pa_expectations(dist: dict[str, float]) -> dict[str, float]:
    """Expected total bases / hit prob / HR prob for a SINGLE PA from a dist."""
    tb = 1 * dist["1B"] + 2 * dist["2B"] + 3 * dist["3B"] + 4 * dist["HR"]
    hit = dist["1B"] + dist["2B"] + dist["3B"] + dist["HR"]
    return {"tb": tb, "hit": hit, "hr": dist["HR"]}


def expected_total_pas(slot: int) -> float:
    if not (1 <= slot <= 9):
        slot = DEFAULT_SLOT
    return HITTER_SLOT_PA[slot - 1]


def expected_starter_pas(slot: int, starter_bf: float | None, total_pa: float) -> float:
    """How many of the batter's PAs come vs the STARTER (times-through-order):
    the t-th PA vs the starter happens when starter_bf >= slot + 9*(t-1).
    Capped at the batter's expected total PAs."""
    bf = starter_bf if (starter_bf and starter_bf > 0) else DEFAULT_STARTER_BF
    if not (1 <= slot <= 9):
        slot = DEFAULT_SLOT
    count = 0
    for t in range(1, 5):                       # at most 4 trips through the order
        if bf >= slot + 9 * (t - 1):
            count += 1
    return min(float(count), total_pa)


# ─── projection ──────────────────────────────────────────────────────────────

def compute_matchup_hitter(
    batter_counts: dict,
    batter_pa: float,
    starter_counts: dict,
    starter_pa: float,
    batter_hand: str | None,
    pitcher_hand: str | None,
    slot: int,
    starter_bf: float | None,
    park_factor: float = 1.0,
) -> dict[str, float]:
    """Project a hitter's game from the opposing-starter matchup.

    Returns {total_bases, hits, home_runs, p_hit, p_hr} — point projections for
    the count props plus the >=1 probabilities. Bullpen PAs use the batter's own
    regressed rate (= log5 vs a league pitcher), so the starter only drives the
    ~2-3 PAs he's expected to face this batter for.
    """
    b = regressed_pa_rates(batter_counts, batter_pa)
    p = regressed_pa_rates(starter_counts, starter_pa)

    starter_dist = matchup_pa_dist(b, p, batter_hand, pitcher_hand, park_factor)
    bullpen_dist = matchup_pa_dist(b, LEAGUE_PA_RATES, batter_hand, None, park_factor)

    total_pa = expected_total_pas(slot)
    sp = expected_starter_pas(slot, starter_bf, total_pa)
    bp = max(total_pa - sp, 0.0)

    es = _per_pa_expectations(starter_dist)
    eb = _per_pa_expectations(bullpen_dist)

    tb = sp * es["tb"] + bp * eb["tb"]
    hits = sp * es["hit"] + bp * eb["hit"]
    hr = sp * es["hr"] + bp * eb["hr"]
    # P(>=1) over the split PAs (independent-PA approximation; fractional PAs ok)
    p_hit = 1.0 - (1.0 - es["hit"]) ** sp * (1.0 - eb["hit"]) ** bp
    p_hr = 1.0 - (1.0 - es["hr"]) ** sp * (1.0 - eb["hr"]) ** bp

    return {
        "total_bases": round(tb, 3),
        "hits": round(hits, 3),
        "home_runs": round(hr, 3),
        "p_hit": round(p_hit, 4),
        "p_hr": round(p_hr, 4),
    }
