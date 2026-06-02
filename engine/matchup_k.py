"""Deterministic matchup-expected-K baseline — SHADOW MODE.

Computes expected strikeouts for a start from PRE-GAME info only:

    expected_Ks = Σ over the 9 posted batters of
        P(K | pitcher stuff, batter K%, handedness) × expected_PAs(slot)

This is PRIOR KNOWLEDGE — a hand-built causal calculation. It does NOT train,
so it cannot overfit. But its hand-set priors CAN be wrong, which is exactly
why it runs in SHADOW (computed + logged, never the live projection) until its
calibration is validated against actuals (a separate future step).

Pure math: no DB, no API. The caller (engine/main.py:_run_matchup_shadow)
gathers the inputs (posted lineup, per-batter K%, pitcher stuff) and passes
them in. The per-PA core is intentionally PROP-AGNOSTIC so it later generalizes
to outs_recorded / hits_allowed via per-PA contact / BIP rates.

DESIGN NOTES
- EDGE DESIGN: a matchup calc that replicates the consensus is a great
  projection and a zero-edge bet. We deliberately LEAN on the fast inputs the
  market is slow on — recent whiff/CSW (W_STUFF_CSW below) and today's posted
  lineup — so the baseline can legitimately DIVERGE where edges live (a recent
  stuff spike, a platoon-stacked lineup, a lazy back-of-rotation number).
- NO DOUBLE-COUNT: this already contains a pitcher-stuff term. At flip-time it
  becomes the PRIMARY strikeout baseline with the rolling-average baseline
  DEMOTED to a light recency regularizer — NOT a co-equal 50/50 blend. In
  shadow mode it is computed STANDALONE and blended into nothing.
"""

from constants import LEAGUE_AVG_K_PCT

# ─── priors (hand-set; shadow until validated) ───────────────────────────────

# League batter strikeout rate per PA — the shrinkage target and the log5 anchor.
LEAGUE_K_PCT = LEAGUE_AVG_K_PCT  # 0.22

# ⚠ THE PRIOR MOST LIKELY MISCALIBRATED EARLY. Small-sample regression: add this
# many PA of league-average K% as a Bayesian prior to each batter's observed K
# rate. A 12-PA / 5-K hitter is NOT a 42% K bat — with this prior they regress
# to (5 + 0.22*50) / (12 + 50) = 0.258, much closer to league. A LARGER value
# regresses harder (safer / more conservative). This is the single constant to
# revisit first once enough graded starts exist to validate calibration.
K_PCT_REGRESSION_PA = 50.0

# CSW% → K%/PA rough linear map (league CSW ~0.27 → league K ~0.22). CSW% is a
# faster, more stable "stuff" signal than past K count, so the pitcher term
# leans on it (see W_STUFF_CSW). Slope is a documented prior, not a fit.
LEAGUE_CSW_PCT = 0.27
CSW_TO_K_SLOPE = 0.9

# Pitcher-stuff blend: weight the FAST whiff/CSW-implied K% MORE than the slower
# recent-K%/PA, deliberately (EDGE DESIGN), so the baseline can diverge from a
# slow market prior where the edge lives. Weights need not sum to 1 (normalized).
W_STUFF_CSW = 0.6      # weight on CSW-implied K%
W_STUFF_RECENT = 0.4   # weight on recent K%/PA

# Platoon: same-handed matchups (RHB vs RHP, LHB vs LHP) strike out modestly
# more. Applied as a BOUNDED multiplicative nudge using ONLY handedness — per-
# batter platoon splits aren't reliably available pre-game, and a bounded league
# factor keeps a thin split from swinging the estimate. Switch hitters always
# bat opposite the pitcher → ~neutral.
PLATOON_SAME_HAND = 1.06   # +6% K vs same hand
PLATOON_OPP_HAND = 0.96    # −4% K vs opposite hand
PLATOON_SWITCH = 1.0       # switch hitter → neutral

# Expected PAs per lineup SLOT for a full 9-inning lineup (top-heavy; the order
# turns over so slot 1 comes up more than slot 9). Scaled DOWN to the batters
# this pitcher is actually expected to face (he leaves after ~5-6 IP).
SLOT_PA_CURVE = [4.30, 4.18, 4.06, 3.94, 3.82, 3.70, 3.58, 3.46, 3.34]  # sum ≈ 34.4
BF_PER_INNING = 4.3        # batters faced per inning (~3 outs + baserunners)
DEFAULT_EXPECTED_IP = 5.5  # fallback when the pitcher's typical IP is unknown

# Sane bounds so a degenerate input can't produce an absurd per-PA K prob.
_MIN_K_PCT = 0.05
_MAX_K_PCT = 0.55


# ─── per-PA core (prop-agnostic) ─────────────────────────────────────────────

def regress_k_pct(strikeouts: float, plate_appearances: float) -> float:
    """Shrink an observed K rate toward league with a PA-count prior."""
    return (strikeouts + LEAGUE_K_PCT * K_PCT_REGRESSION_PA) / (
        (plate_appearances or 0.0) + K_PCT_REGRESSION_PA
    )


def log5(batter_rate: float, pitcher_rate: float, league_rate: float = LEAGUE_K_PCT) -> float:
    """Bill James log5: combine a batter rate and a pitcher rate vs the league
    rate into a matchup rate. Prop-agnostic (works for K%, BIP%, etc.)."""
    league_rate = min(max(league_rate, 1e-6), 1 - 1e-6)
    num = (batter_rate * pitcher_rate) / league_rate
    den = num + ((1 - batter_rate) * (1 - pitcher_rate)) / (1 - league_rate)
    return num / den if den > 0 else batter_rate


def platoon_factor(batter_hand: str | None, pitcher_hand: str | None) -> float:
    """Bounded handedness nudge. 1.0 when either hand is unknown (degrades
    gracefully — the pitcher's throws can be None for thin probables)."""
    if not batter_hand or not pitcher_hand:
        return 1.0
    if batter_hand == "S":
        return PLATOON_SWITCH
    return PLATOON_SAME_HAND if batter_hand == pitcher_hand else PLATOON_OPP_HAND


def pitcher_k_per_pa(recent_k_per_pa: float | None, csw_pct: float | None) -> float:
    """Pitcher's expected K%/PA — a recency blend that LEANS on CSW% (fast,
    stable stuff) over the slower recent K count. Falls back to league when no
    input is available."""
    parts: list[float] = []
    weights: list[float] = []
    if csw_pct is not None:
        csw_implied = LEAGUE_K_PCT + (csw_pct - LEAGUE_CSW_PCT) * CSW_TO_K_SLOPE
        parts.append(min(max(csw_implied, _MIN_K_PCT), _MAX_K_PCT))
        weights.append(W_STUFF_CSW)
    if recent_k_per_pa is not None:
        parts.append(min(max(recent_k_per_pa, _MIN_K_PCT), _MAX_K_PCT))
        weights.append(W_STUFF_RECENT)
    if not parts:
        return LEAGUE_K_PCT
    return sum(p * w for p, w in zip(parts, weights)) / sum(weights)


def expected_pas_by_slot(expected_ip: float | None) -> list[float]:
    """Scale the full-game slot curve DOWN to the batters this pitcher faces."""
    ip = expected_ip if (expected_ip and expected_ip > 0) else DEFAULT_EXPECTED_IP
    expected_bf = max(1.0, ip) * BF_PER_INNING
    scale = expected_bf / sum(SLOT_PA_CURVE)
    return [c * scale for c in SLOT_PA_CURVE]


# ─── matchup assembly ────────────────────────────────────────────────────────

def matchup_breakdown(
    pitcher_csw_pct: float | None,
    recent_k_per_pa: float | None,
    pitcher_hand: str | None,
    expected_ip: float | None,
    lineup: list[dict],
) -> list[dict] | None:
    """Per-batter breakdown (for the diagnostic / hand-check). `lineup` is a
    list of dicts: {slot:1-9, strikeouts, plate_appearances, bats}. Returns None
    when fewer than 9 valid slots are present (lineup not fully posted)."""
    p_k = pitcher_k_per_pa(recent_k_per_pa, pitcher_csw_pct)
    pas = expected_pas_by_slot(expected_ip)
    rows: list[dict] = []
    for b in lineup:
        try:
            slot = int(b.get("slot", 0))
        except (TypeError, ValueError):
            continue
        if not (1 <= slot <= 9):
            continue
        bk = regress_k_pct(
            float(b.get("strikeouts", 0) or 0),
            float(b.get("plate_appearances", 0) or 0),
        )
        pf = platoon_factor(b.get("bats"), pitcher_hand)
        per_pa = min(max(log5(bk, p_k) * pf, _MIN_K_PCT), _MAX_K_PCT)
        exp_pa = pas[slot - 1]
        rows.append({
            "slot": slot,
            "batter_k_regressed": round(bk, 3),
            "platoon_factor": pf,
            "per_pa_k": round(per_pa, 3),
            "expected_pas": round(exp_pa, 2),
            "exp_k": per_pa * exp_pa,
        })
    if len({r["slot"] for r in rows}) < 9:
        return None
    return rows


def compute_matchup_expected_k(
    pitcher_csw_pct: float | None,
    recent_k_per_pa: float | None,
    pitcher_hand: str | None,
    expected_ip: float | None,
    lineup: list[dict],
) -> float | None:
    """Expected strikeouts for the start, or None if the lineup isn't fully
    posted. SHADOW MODE — the caller logs this, never displays it."""
    detail = matchup_breakdown(
        pitcher_csw_pct, recent_k_per_pa, pitcher_hand, expected_ip, lineup
    )
    if detail is None:
        return None
    return round(sum(r["exp_k"] for r in detail), 2)
