"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FeaturedPlay, FeaturedSection, PropType } from "@/lib/types";
import { parkLabel, windTag } from "@/lib/windTag";
import SharpBadge from "./SharpBadge";

// Display labels for every prop that can appear across the three sections.
const PROP_LABEL: Partial<Record<PropType, string>> = {
  strikeouts:         "STRIKEOUTS",
  hits_allowed:       "HITS ALLOWED",
  outs_recorded:      "OUTS RECORDED",
  hitter_hits:        "HITS",
  hitter_total_bases: "TOTAL BASES",
  hitter_hits_runs_rbis: "HITS+RUNS+RBIS",
  hitter_home_runs:   "HOME RUNS",
};

// Per-section one-line framing so a user knows what each list measures without
// reading the footer. Kept terse to stay clean.
const SECTION_BLURB: Record<string, string> = {
  "PITCHING EDGES": "Model probability vs the book — strongest pitcher leans",
  "HITTING EDGES": "Model probability vs the book — strongest hitter leans",
  "HR MATCHUPS": "Best home-run spots by park, wind & batted-ball quality",
};

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

// ── small building blocks ────────────────────────────────────────────────────

// A compact rounded pill. tone drives the text/background emphasis.
function Chip({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "good" | "muted" | "warn";
  title?: string;
}) {
  const cls =
    tone === "good"
      ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-300 ring-amber-500/20"
        : "bg-slate-800/70 text-slate-400 ring-slate-700/40";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums ring-1 ring-inset ${cls}`}
    >
      {children}
    </span>
  );
}

// Recent-form chip: how often the player landed on THIS lean's side over the
// last ≤10 graded games vs THIS line. The single most persuasive backing on a
// card — "model says under AND he's gone under 8 of 10."
function FormChip({
  hit,
  total,
  lean,
  line,
}: {
  hit: number;
  total: number;
  lean: "over" | "under";
  line: number;
}) {
  const rate = total ? hit / total : 0;
  const tone = rate >= 0.7 ? "good" : rate >= 0.5 ? "muted" : "warn";
  return (
    <Chip
      tone={tone}
      title={`Landed ${lean} in ${hit} of the last ${total} graded games vs ${fmt(line)}`}
    >
      <span className="text-slate-500">L{total}</span>
      {hit}/{total} {lean === "over" ? "▲" : "▼"}
    </Chip>
  );
}

// Honest, tiered confidence from the count of graded games backing this
// player+prop. 8+ reads with quiet emerald confidence; thinner is muted slate.
function sampleTone(n: number): "good" | "muted" {
  return n >= 8 ? "good" : "muted";
}
function sampleText(n: number): string {
  if (n === 0) return "new";
  return `${n} GP`;
}

// 7-day batted-ball quality chip for HR cards when Statcast data is present.
// avgExitVelo mph; sweetSpotPct a 0..1 fraction rendered as a whole percent.
function SweetSpotChip({
  sweetSpotPct,
  avgExitVelo,
}: {
  sweetSpotPct: number;
  avgExitVelo: number;
}) {
  const pct = Math.round(sweetSpotPct * 100);
  // Sweet-spot >= 35% or EV >= 90 reads as a quality contact profile.
  const tone = sweetSpotPct >= 0.35 || avgExitVelo >= 90 ? "good" : "muted";
  return (
    <Chip tone={tone} title="Rolling 7-day batted-ball quality (Statcast)">
      🔥 {avgExitVelo.toFixed(0)} EV · {pct}% sweet
    </Chip>
  );
}

// Insight line: shimmer while the POST is in flight (and a key is expected),
// the AI sentence once it lands, or nothing when there's no key / no insight.
//
// Tap-to-expand is driven by ACTUAL overflow, not a char-count proxy — every
// card measures whether its clamped (2-line) text is being truncated and only
// then shows the "↓ more" toggle.
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
    return <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-slate-800" />;
  }
  if (!text) return null;

  const interactive = overflows || expanded || text.length > 90;

  const paragraph = (
    <p
      ref={pRef}
      className={`text-[11px] leading-relaxed text-slate-400 transition-all duration-200 ${
        expanded ? "" : "line-clamp-2"
      }`}
    >
      {text}
    </p>
  );

  if (!interactive) {
    return <div className="mt-3 border-t border-slate-800/60 pt-2.5">{paragraph}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className="mt-3 block w-full cursor-pointer border-t border-slate-800/60 pt-2.5 text-left"
    >
      {paragraph}
      <span className="mt-1 inline-block text-[9px] font-medium uppercase tracking-wider text-slate-600">
        {expanded ? "↑ less" : "↓ more"}
      </span>
    </button>
  );
}

// ── the card ─────────────────────────────────────────────────────────────────

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

  // Direction accent (edge cards) / park-favorability accent (HR cards).
  const accent = isHR
    ? (play.parkFactor ?? 1) >= 1.04
      ? "bg-emerald-500/60"
      : (play.parkFactor ?? 1) <= 0.96
        ? "bg-red-500/50"
        : "bg-slate-600/60"
    : isOver
      ? "bg-emerald-500"
      : "bg-red-500";

  // De-vig math framed to the LEANED side so the edge is legible.
  const modelLean =
    play.modelOverProb != null
      ? isOver
        ? play.modelOverProb
        : 1 - play.modelOverProb
      : undefined;
  const marketLean =
    play.fairOverProb != null
      ? isOver
        ? play.fairOverProb
        : 1 - play.fairOverProb
      : undefined;

  return (
    <div className="surface relative overflow-hidden rounded-2xl py-3.5 pl-5 pr-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/15">
      {/* direction / park accent */}
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${accent}`} />

      {/* header: name + matchup · prop chip */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-tight text-slate-100">
            {play.playerName}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{play.matchup}</p>
        </div>
        <span className="shrink-0 rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400">
          {PROP_LABEL[play.propType] ?? play.propType}
        </span>
      </div>

      {isHR ? (
        // ── HR matchup: HR proj (hero) + park, then the wind tag ──
        <>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold tabular-nums text-slate-100">
                {fmt(play.projection, 2)}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                HR proj
              </span>
            </div>
            {(() => {
              const pf = play.parkFactor ?? 1.0;
              const { arrow, tone } = parkLabel(pf);
              return (
                <span className="text-[11px] tabular-nums text-slate-400">
                  Park <span className={`font-semibold ${tone}`}>{arrow} {fmt(pf, 2)}</span>
                </span>
              );
            })()}
          </div>
          <div className="mt-2 text-[12px]">
            {(() => {
              const w = windTag({
                homeTeam: play.homeTeam,
                windSpeed: play.windSpeed,
                windDirDeg: play.windDirDeg,
                isDome: play.isDome,
              });
              return (
                <span className={`font-medium ${w.tone}`} title={w.tooltip}>
                  {w.arrow ? `${w.arrow} ` : ""}
                  {w.text}
                </span>
              );
            })()}
          </div>
          {/* quality + sample chips */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {play.sweetSpotPct != null && play.avgExitVelo != null && (
              <SweetSpotChip sweetSpotPct={play.sweetSpotPct} avgExitVelo={play.avgExitVelo} />
            )}
            <Chip tone={sampleTone(play.gradedStarts)} title="Graded games backing this player">
              {sampleText(play.gradedStarts)}
            </Chip>
          </div>
        </>
      ) : (
        // ── Edge play: bet+edge hero, de-vig math, conviction chips ──
        <>
          {/* hero: the bet (side + line) + the edge */}
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="flex items-baseline gap-1.5">
              <span className={`text-base font-bold ${isOver ? "text-emerald-400" : "text-red-400"}`}>
                {isOver ? "OVER" : "UNDER"}
              </span>
              <span className="text-base font-bold tabular-nums text-slate-100">
                {fmt(play.line ?? 0)}
              </span>
            </span>
            <span className="flex items-baseline gap-1">
              <span className="text-base font-bold tabular-nums text-emerald-400">
                +{(play.edge ?? 0).toFixed(2)}
              </span>
              <span
                className="text-[9px] font-semibold uppercase tracking-wider text-slate-500"
                title={play.bookmaker ? `Edge vs ${play.bookmaker}` : undefined}
              >
                edge
              </span>
            </span>
          </div>

          {/* de-vig math: proj + model% vs market% (framed to the leaned side) */}
          <div className="mt-1.5 text-[11px] tabular-nums text-slate-500">
            proj <span className="text-slate-300">{fmt(play.projection)}</span>
            {modelLean != null && marketLean != null && (
              <span title="No-vig probability the model assigns this side vs the de-vigged book line">
                <span className="mx-1.5 text-slate-700">·</span>
                model{" "}
                <span className="font-semibold text-slate-200">{Math.round(modelLean * 100)}%</span>
                <span className="mx-1 text-slate-600">vs</span>
                mkt {Math.round(marketLean * 100)}%
              </span>
            )}
          </div>

          {/* conviction: recent form · sharp agreement · sample */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {play.hitRate && play.line != null && play.lean && (
              <FormChip
                hit={play.hitRate.hit}
                total={play.hitRate.total}
                lean={play.lean}
                line={play.line}
              />
            )}
            {play.sharpAgreement && <SharpBadge sharp={play.sharpAgreement} />}
            <Chip tone={sampleTone(play.gradedStarts)} title="Graded games backing this player+prop">
              {sampleText(play.gradedStarts)}
            </Chip>
          </div>
        </>
      )}

      {/* AI insight (shimmer while loading) — divided from the data above */}
      <InsightLine text={insight} loading={loadingInsight} />
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionsKey]);

  // Hide the whole section only when nothing qualifies anywhere.
  const hasAnyPlay = sections.some((s) => s.plays.length > 0);
  if (!hasAnyPlay) return null;

  const loadingInsights = enabled && insights === null;

  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-100">Featured Plays</h2>
        <span className="text-[10px] uppercase tracking-wider text-slate-600">
          Top edges &amp; matchups
        </span>
      </div>

      {sections.map((section) => (
        <div key={section.label} className="mt-5">
          <div className="flex items-baseline justify-between gap-2 border-b border-slate-800 pb-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-300">
              {section.label}
            </h3>
            <span className="hidden truncate text-[10px] text-slate-600 sm:block">
              {SECTION_BLURB[section.label] ?? ""}
            </span>
          </div>

          {section.plays.length === 0 ? (
            <p className="mt-3 text-xs text-slate-600">No qualifying plays right now.</p>
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

      <p className="mt-5 text-[10px] leading-relaxed text-slate-600">
        Edge = the model&apos;s no-vig probability minus the de-vigged book
        probability. Recent form (L10) and sharp agreement count REAL two-sided
        books only. HR matchups rank by park, wind &amp; batted-ball quality —
        not a book line. Not financial advice.
      </p>
    </section>
  );
}
