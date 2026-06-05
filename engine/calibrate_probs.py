"""Isotonic calibration of the model's over-probabilities.

The raw model_over_prob (edge._model_over_prob — Poisson/normal around the
projection) is well-calibrated in aggregate but OVERCONFIDENT at the extremes for
several props. Measured on the live graded history:
    hitter_total_bases     top bucket predicts 0.76, realizes 0.58
    hitter_hits_runs_rbis  top bucket predicts 0.78, realizes 0.40
Those inflated high-confidence probabilities are the fake "edges" the board shows
(model 80%+ vs a sharp market at ~45%) that then miss.

Isotonic regression maps the raw probability to the realized over-rate, pulling
those predictions down to what they actually hit. 5-fold cross-validation on the
live data confirmed it LOWERS out-of-sample Brier for every prop with enough
data (hitter_total_bases -0.015, hitter_hits_runs_rbis -0.065, hitter_hits/rbis/
runs all improve) and -0.009 pooled. Thin props OVERFIT a per-prop fit
(hits_allowed n=90 got worse), so anything under PER_PROP_MIN falls back to a
single pooled calibrator.

Fit IN the pipeline each full run from graded history — no pickle to ship, which
matches the precompute/one-writer architecture (calibrators live only for the run
that computes edges). FULLY DEFENSIVE: any failure (sklearn missing, too little
data, fit error) returns None and edge.compute_edges falls back to the raw
probability — no regression.
"""
from __future__ import annotations

# Below this many graded pairs, a per-prop isotonic fit overfits (validated:
# hits_allowed at n=90 got WORSE out-of-sample) -> use the pooled calibrator.
PER_PROP_MIN = 150
# Need a reasonable overall pool before calibrating at all.
POOLED_MIN = 200


def fit_over_prob_calibrators() -> dict | None:
    """Fit isotonic over-prob calibrators from the graded history.

    Returns {'per_prop': {prop_type: IsotonicRegression}, 'pooled': IsotonicRegression}
    or None when calibration can't / shouldn't run (sklearn missing, too few
    pairs, or any error) — in which case edges use the raw probability.

    Reuses calibration_scorecard.gather() for the (raw_over_prob, realized_over)
    pairs (it recomputes the prob fresh from the stored projection + line via the
    live edge._model_over_prob, then joins the graded outcome).
    """
    try:
        from sklearn.isotonic import IsotonicRegression
        import calibration_scorecard
    except Exception as exc:
        print(f"  over-prob calibration unavailable ({exc}) -- edges use raw probs")
        return None

    try:
        pairs = calibration_scorecard.gather()
    except Exception as exc:
        print(f"  over-prob calibration: gather failed ({exc}) -- raw probs")
        return None
    if not pairs:
        return None

    all_p: list[float] = []
    all_o: list[int] = []
    for ps in pairs.values():
        for p, o in ps:
            all_p.append(p)
            all_o.append(o)
    if len(all_p) < POOLED_MIN:
        print(
            f"  over-prob calibration: only {len(all_p)} graded pairs "
            f"(<{POOLED_MIN}) -- raw probs"
        )
        return None

    def _fit(probs, outs):
        return IsotonicRegression(
            out_of_bounds="clip", y_min=0.0, y_max=1.0
        ).fit(probs, outs)

    try:
        pooled = _fit(all_p, all_o)
        per_prop: dict = {}
        for prop, ps in pairs.items():
            if len(ps) >= PER_PROP_MIN:
                per_prop[prop] = _fit([p for p, _ in ps], [o for _, o in ps])
    except Exception as exc:
        print(f"  over-prob calibration: fit failed ({exc}) -- raw probs")
        return None

    print(
        f"  over-prob calibrators fit: {len(per_prop)} per-prop (n>={PER_PROP_MIN}) "
        f"+ pooled ({len(all_p)} graded pairs)"
    )
    return {"per_prop": per_prop, "pooled": pooled}


def apply(prob: float, prop_type: str | None, calibrators: dict | None) -> float:
    """Map a raw over-prob to its calibrated value; identity when no calibrator.

    Mirrors the inline logic in edge.compute_edges — exposed for the scorecard /
    ad-hoc checks.
    """
    if not calibrators:
        return prob
    cal = calibrators.get("per_prop", {}).get(prop_type) or calibrators.get("pooled")
    if cal is None:
        return prob
    try:
        return float(cal.predict([prob])[0])
    except Exception:
        return prob
