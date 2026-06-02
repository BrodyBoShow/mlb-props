"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeaturedPlay, FeaturedSection, PropType } from "@/lib/types";
import { getParkBearing } from "@/lib/constants";
import SharpBadge from "./SharpBadge";

// Display labels for every prop that can appear across the three sections.
const PROP_LABEL: Partial<Record<PropType, string>> = {
  strikeouts:         "STRIKEOUTS",
  hits_allowed:       "HITS ALLOWED",
  outs_recorded:      "OUTS RECORDED",
  hitter_hits:        "HITS",
  hitter_total_bases: "TOTAL BASES",
  hitter_home_runs:   "HOME RUNS",
};

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

// Park label + arrow derived from the hit park factor (same thresholds as the
// ParkTag on the prop board: >=1.04 hitter-friendly, <=0.96 pitcher-friendly).
function parkLabel(factor: number): { text: string; arrow: string; tone: string } {
  if (factor >= 1.04) return { text: "Hitter-friendly", arrow: "↑", tone: "text-emerald-400" };
  if (factor <= 0.96) return { text: "Pitcher-friendly", arrow: "↓", tone: "text-sky-400" };
  return { text: "Neutral", arrow: "·", tone: "text-slate-400" };
}

type WindTagResult = { text: string; arrow: string; tone: string; tooltip?: string };

// Field-relative wind tag for an HR card (display-only). Turns the stored
// wind into an Out / In / Cross label vs the park's home-plate→CF bearing,
// degrading cleanly when the data isn't usable:
//   - dome game            → "Dome · neutral"
//   - no wind OR no bearing → static park label (current behavior)
//   - wind < 5 mph         → park label + "· calm"
//   - else                 → directional wind tag (green out / red in / slate cross)
//
// windDirDeg is OWM's METEOROLOGICAL direction (the way the wind blows FROM),
// so we add 180 to get the blowing-TOWARD bearing before comparing to CF.
function windTag(play: FeaturedPlay): WindTagResult {
  const pf = play.parkFactor ?? 1.0;
  const pl = parkLabel(pf);
  const staticTag: WindTagResult = { text: `${pl.text} park`, arrow: "", tone: pl.tone };

  if (play.isDome) return { text: "Dome · neutral", arrow: "", tone: "text-slate-400" };

  const bearing = play.homeTeam ? getParkBearing(play.homeTeam) : null;
  const speed = play.windSpeed;
  if (speed == null || bearing == null || play.windDirDeg == null) return staticTag;
  if (speed < 5) return { ...staticTag, text: `${pl.text} park · calm` };

  const windToward = (play.windDirDeg + 180) % 360;       // direction wind blows TOWARD
  const rel = ((windToward - bearing + 540) % 360) - 180; // normalize to (-180, 180]
  const abs = Math.abs(rel);
  const mph = Math.round(speed);
  const tip =
    `Wind ${mph} mph from ${Math.round(play.windDirDeg)}° · ` +
    `CF bearing ${bearing}° · field-relative ${Math.round(rel)}°`;

  // |rel| small → blowing out toward CF (tailwind, helps HR); |rel| near 180 →
  // blowing in from CF (headwind); in between → crossing. rel>0 leans to the
  // RF side, rel<0 to the LF side (facing CF, right hand points clockwise).
  if (abs <= 45) {
    const side = rel < -15 ? "LF" : rel > 15 ? "RF" : "CF";
    return { text: `${mph} mph Out to ${side}`, arrow: "↑", tone: "text-emerald-400", tooltip: tip };
  }
  if (abs >= 135) {
    return { text: `${mph} mph In from CF`, arrow: "↓", tone: "text-red-400", tooltip: tip };
  }
  const side = rel > 0 ? "RF" : "LF";
  return { text: `${mph} mph Cross to ${side}`, arrow: "→", tone: "text-slate-400", tooltip: tip };
}

// 7-day batted-ball quality footer for HR cards (replaces the graded-history
// line when Statcast data is present). avgExitVelo mph; sweetSpotPct a 0..1
// fraction rendered as a whole percent.
function SweetSpotLine({
  sweetSpotPct,
  avgExitVelo,
}: {
  sweetSpotPct: number;
  avgExitVelo: number;
}) {
  const pct = Math.round(sweetSpotPct * 100);
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className="text-[10px] leading-none">🔥</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-400 tabular-nums">
        7-day: {avgExitVelo.toFixed(1)} avg EV · {pct}% sweet-spot
      </span>
    </div>
  );
}

// Honest, tiered confidence framing from the count of graded games backing this
// player+prop. Thin samples read "limited history" in muted slate; 8+ reads with
// quiet emerald confidence. Never inflated.
function confidenceLabel(n: number): {
  text: string;
  tone: "strong" | "moderate" | "limited";
} {
  if (n >= 8) return { text: `${n} games tracked`, tone: "strong" };
  if (n >= 4) return { text: `${n} games tracked`, tone: "moderate" };
  return {
    text: n === 0 ? "New — limited history" : `${n} game${n === 1 ? "" : "s"} tracked`,
    tone: "limited",
  };
}

function ConfidenceLine({ count }: { count: number }) {
  const { text, tone } = confidenceLabel(count);
  const textColor =
    tone === "strong" ? "text-emerald-400/70" : tone === "moderate" ? "text-slate-400" : "text-slate-500";
  const dotColor =
    tone === "strong" ? "bg-emerald-500" : tone === "moderate" ? "bg-slate-400" : "bg-slate-600";
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
      <span className={`text-[10px] uppercase tracking-wide ${textColor}`}>{text}</span>
    </div>
  );
}

// Insight line: shimmer while the POST is in flight (and a key is expected),
// the AI sentence once it lands, or nothing when there's no key / no insight.
//
// Tap-to-expand is driven by ACTUAL overflow, not a char-count proxy — every
// card measures whether its clamped (2-line) text is being truncated and only
// then shows the "↓ more" toggle. That keeps the behavior identical across
// cards: a read that genuinely fits in two lines is static with no toggle; one
// that's cut off gets the toggle, regardless of exact length.
function InsightLine({
  text,
  loading,
}: {
  text: string | undefined;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  // Detect whether the clamped (2-line) insight is being truncated, so only
  // overflowing reads get the "↓ more" toggle. With `line-clamp-2` the element
  // is `overflow:hidden`, so scrollHeight reports the full content height while
  // clientHeight is the clamped height — a positive difference means it's cut
  // off. Skip re-measuring while expanded (clamp removed → heights equal, which
  // would falsely reset the flag). ResizeObserver re-checks on width changes.
  useEffect(() => {
    const el = pRef.current;
    if (!el) return;
    const measure = () => {
      if (!expanded) setOverflows(el.scrollHeight - el.clientHeight > 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  if (loading) {
    return <div className="mt-2 h-3 w-full animate-pulse rounded bg-slate-800" />;
  }
  if (!text) return null;

  // Show the toggle when the insight overflows two lines. The scrollHeight
  // measurement above is PRECISE but browser-dependent (some browsers report
  // scrollHeight as the clamped height under -webkit-line-clamp, so it reads
  // no overflow). A deterministic length fallback guarantees the toggle for the
  // long AI reads (~100–200 chars, which always wrap past two lines on these
  // narrow cards) regardless of the browser's scrollHeight quirk. Short
  // one-line insights (< ~90 chars) correctly stay static.
  const interactive = overflows || expanded || text.length > 90;

  const paragraph = (
    <p
      ref={pRef}
      className={`text-[11px] italic leading-snug text-slate-400 transition-all duration-200 ${
        expanded ? "" : "line-clamp-2"
      }`}
    >
      {text}
    </p>
  );

  // Fits in two lines → plain, non-interactive line (no toggle).
  if (!interactive) {
    return <div className="mt-2">{paragraph}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className="mt-2 block w-full cursor-pointer text-left"
    >
      {paragraph}
      <span className="mt-0.5 inline-block text-[9px] uppercase tracking-wide text-slate-500">
        {expanded ? "↑ less" : "↓ more"}
      </span>
    </button>
  );
}

function FeaturedPlayCard({
  play,
  insight,
  loadingInsight,
}: {
  play: FeaturedPlay;
  insight: string | undefined;
  loadingInsight: boolean;
}) {
  const isHR = play.edge === undefined; // HR-matchup plays carry no edge/line
  const isOver = play.lean === "over";

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
      {/* Line 1: player name + prop label */}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate font-semibold text-slate-100">{play.playerName}</p>
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {PROP_LABEL[play.propType] ?? play.propType}
        </span>
      </div>

      {/* Line 2: matchup */}
      <p className="mt-0.5 truncate text-[11px] text-slate-500">{play.matchup}</p>

      <div className="my-3 border-t border-slate-800" />

      {isHR ? (
        // ── HR matchup: park + projection, then the park label (no edge) ──
        <>
          <div className="text-sm tabular-nums text-slate-300">
            {(() => {
              const pf = play.parkFactor ?? 1.0;
              const { arrow, tone } = parkLabel(pf);
              return (
                <>
                  Park <span className={`font-medium ${tone}`}>{arrow} {fmt(pf, 2)}</span>
                  <span className="mx-2 text-slate-600">·</span>
                  Proj <span className="font-medium text-slate-100">{fmt(play.projection, 2)} HR</span>
                </>
              );
            })()}
          </div>
          <div className="mt-2 text-sm">
            {(() => {
              const w = windTag(play);
              return (
                <span className={`font-semibold ${w.tone}`} title={w.tooltip}>
                  {w.arrow ? `${w.arrow} ` : ""}
                  {w.text}
                </span>
              );
            })()}
          </div>
        </>
      ) : (
        // ── Edge play: proj/line, then lean + edge, then sharp badge ──
        <>
          <div className="text-sm tabular-nums text-slate-300">
            Proj <span className="font-medium text-slate-100">{fmt(play.projection)}</span>
            <span className="mx-2 text-slate-600">·</span>
            Line <span className="font-medium text-slate-100">{fmt(play.line ?? 0)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between text-sm tabular-nums">
            <span className={`font-semibold ${isOver ? "text-emerald-400" : "text-red-400"}`}>
              {isOver ? "▲ OVER" : "▼ UNDER"}
            </span>
            <span
              className="font-semibold text-emerald-400"
              title={play.bookmaker ? `vs ${play.bookmaker}` : undefined}
            >
              Edge +{(play.edge ?? 0).toFixed(2)}
            </span>
          </div>
          {play.sharpAgreement && (
            <div className="mt-2 flex justify-end">
              <SharpBadge sharp={play.sharpAgreement} />
            </div>
          )}
        </>
      )}

      {/* Line 6: AI insight (shimmer while loading) */}
      <InsightLine text={insight} loading={loadingInsight} />

      {/* Bottom: HR cards show the 7-day batted-ball quality footer when
          Statcast data is present (>= 5 batted balls); otherwise — and for all
          edge cards — the graded-history confidence line. */}
      {isHR && play.sweetSpotPct != null && play.avgExitVelo != null ? (
        <SweetSpotLine sweetSpotPct={play.sweetSpotPct} avgExitVelo={play.avgExitVelo} />
      ) : (
        <ConfidenceLine count={play.gradedStarts} />
      )}
    </div>
  );
}

export default function FeaturedPlays({ sections }: { sections: FeaturedSection[] }) {
  // insights: null while the POST is in flight; a map (possibly empty) once it
  // resolves. enabled=false means no ANTHROPIC_API_KEY (skip the shimmer).
  const [insights, setInsights] = useState<Record<string, string> | null>(null);
  const [enabled, setEnabled] = useState(true);

  // Stable signature of the current play set — only refetch when the plays
  // actually change, not on every soft-refresh re-render.
  const sectionsKey = useMemo(
    () =>
      sections
        .flatMap((s) => s.plays.map((p) => `${p.playerId}|${p.propType}|${p.projection}|${p.line ?? ""}`))
        .join(","),
    [sections],
  );

  useEffect(() => {
    if (!sectionsKey) return;
    let cancelled = false;
    setInsights(null); // reset to loading on a new play set
    (async () => {
      try {
        const res = await fetch("/api/featured-insights", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sections }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setEnabled(data?.enabled !== false);
        setInsights((data?.insights as Record<string, string>) ?? {});
      } catch {
        if (cancelled) return;
        setEnabled(false);
        setInsights({});
      }
    })();
    return () => {
      cancelled = true;
    };
    // sections is captured fresh whenever sectionsKey changes; depping on the
    // object identity too would refetch on every soft-refresh (cheap, but the
    // route is cached, so we key on the stable signature instead).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionsKey]);

  // Hide the whole section only when nothing qualifies anywhere.
  const hasAnyPlay = sections.some((s) => s.plays.length > 0);
  if (!hasAnyPlay) return null;

  const loadingInsights = enabled && insights === null;

  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-slate-100">Featured Plays</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Top edges &amp; matchups · AI-summarized
      </p>

      {sections.map((section) => (
        <div key={section.label} className="mt-5 border-t border-slate-800 pt-3">
          <h3 className="text-[10px] uppercase tracking-widest text-slate-400">
            {section.label}
          </h3>

          {section.plays.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">No qualifying plays</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {section.plays.map((play) => (
                <FeaturedPlayCard
                  key={`${play.gameId}-${play.playerId}-${play.propType}`}
                  play={play}
                  insight={insights?.[`${play.playerId}|${play.propType}`]}
                  loadingInsight={loadingInsights}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      <p className="mt-4 text-[10px] text-slate-600">
        Edge = model probability minus de-vigged book probability. HR matchups
        rank by park-adjusted projection, not a book line. Not financial advice.
      </p>
    </section>
  );
}
