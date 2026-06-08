"use client";

import { useMemo, useState } from "react";
import type { WeeklyBucket } from "@/lib/types";

// Betting Edge hit-rate trend, rendered as a CUMULATIVE hit-rate LINE (not bars).
// A running correct/(correct+wrong) line reads as a trajectory — "is the model
// above water and holding?" — and one noisy week can't dominate it the way a
// giant bar did. Hand-rolled SVG (no chart dependency), congruent with the rest
// of /results. Dashed 50% reference = break-even.

const W = 320; // virtual viewBox width (stretched to the container)
const H = 120; // px plot height

function lineColor(rate: number): string {
  if (rate >= 0.55) return "#34d399"; // emerald-400
  if (rate < 0.45) return "#94a3b8"; // slate-400
  return "#fbbf24"; // amber-400
}

// "2026-05-25" → "May 25" (parsed at LOCAL midnight so it never shifts a day).
function weekLabel(weekKey: string): string {
  return new Date(`${weekKey}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-xl surface p-5">
      <h3 className="text-[10px] uppercase tracking-widest text-slate-400">
        Hit-rate trend
      </h3>
      {children}
    </div>
  );
}

export default function ResultsTrendChart({
  weeklyTrend,
}: {
  weeklyTrend: WeeklyBucket[];
}) {
  const [hover, setHover] = useState<number | null>(null);

  // Running cumulative hit rate after each week — the line we plot.
  const pts = useMemo(() => {
    let cc = 0;
    let cw = 0;
    return weeklyTrend.map((b) => {
      cc += b.correct;
      cw += b.wrong;
      return {
        week: b.week,
        weekRate: b.rate,
        cum: cc + cw > 0 ? cc / (cc + cw) : 0,
        correct: b.correct,
        wrong: b.wrong,
      };
    });
  }, [weeklyTrend]);

  if (!weeklyTrend || weeklyTrend.length === 0) return null;

  if (weeklyTrend.length < 2) {
    const only = pts[0];
    return (
      <Card>
        <p className="mt-2 text-sm text-slate-300">
          <span className="tabular-nums font-semibold" style={{ color: lineColor(only.cum) }}>
            {Math.round(only.cum * 100)}%
          </span>{" "}
          <span className="text-slate-500">
            ({only.correct + only.wrong} graded · week of {weekLabel(only.week)})
          </span>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          The trend line fills in as more weeks of graded slates accumulate.
        </p>
      </Card>
    );
  }

  const n = pts.length;
  const last = pts[n - 1];
  const color = lineColor(last.cum);
  const totalGraded = pts.reduce((s, p) => s + p.correct + p.wrong, 0);
  const PAD = 6;
  const xFor = (i: number) => (n === 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD));
  const yFor = (r: number) => PAD + (1 - r) * (H - 2 * PAD);
  const linePoints = pts.map((p, i) => `${xFor(i)},${yFor(p.cum)}`).join(" ");

  return (
    <Card>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums" style={{ color }}>
          {Math.round(last.cum * 100)}%
        </span>
        <span className="text-[11px] text-slate-500">
          cumulative over {n} weeks · {totalGraded} graded plays
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        {/* y axis */}
        <div
          className="flex w-7 shrink-0 flex-col justify-between text-right text-[9px] tabular-nums text-slate-600"
          style={{ height: H }}
        >
          {["100%", "50%", "0%"].map((t) => (
            <span key={t} className="leading-none">{t}</span>
          ))}
        </div>

        {/* plot */}
        <div className="relative flex-1" style={{ height: H }}>
          <svg
            width="100%"
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="overflow-visible"
          >
            {/* 50% break-even reference */}
            <line
              x1={0} y1={H / 2} x2={W} y2={H / 2}
              stroke="#64748b" strokeWidth={1} strokeDasharray="4 4" strokeOpacity={0.6}
              vectorEffect="non-scaling-stroke"
            />
            {/* the cumulative hit-rate line */}
            <polyline
              points={linePoints}
              fill="none" stroke={color} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* points */}
            {pts.map((p, i) => (
              <circle
                key={p.week}
                cx={xFor(i)} cy={yFor(p.cum)} r={hover === i ? 4 : 2.5}
                fill={color}
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer" }}
              />
            ))}
          </svg>

          {hover !== null && (
            <div
              className="pointer-events-none absolute z-10 w-max max-w-[200px] -translate-x-1/2 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] leading-snug text-slate-200 shadow-lg"
              style={{ left: `${(xFor(hover) / W) * 100}%`, top: -4 }}
            >
              Week of {weekLabel(pts[hover].week)}: {pts[hover].correct} correct,{" "}
              {pts[hover].wrong} wrong · {Math.round(pts[hover].weekRate * 100)}% that week
            </div>
          )}
        </div>
      </div>

      {/* x labels */}
      <div className="mt-1.5 flex pl-9">
        {pts.map((p) => (
          <div key={p.week} className="flex-1 text-center text-[9px] tabular-nums text-slate-500">
            {weekLabel(p.week)}
          </div>
        ))}
      </div>
    </Card>
  );
}
