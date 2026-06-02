"use client";

import { useState } from "react";
import type { WeeklyBucket } from "@/lib/types";

// Weekly Betting Edge hit-rate trend. Hand-rolled (no chart dependency) to stay
// congruent with the rest of /results, which is all Tailwind. One bar per ISO
// week; bar height = hit rate %; dashed reference line at 50%; rate-based color.

const CHART_H = 120; // px

// emerald >=55% (beating the market), slate <45% (under water), amber between
// (the coin-flip / calibrated band).
function barColor(rate: number): string {
  if (rate >= 0.55) return "bg-emerald-600";
  if (rate < 0.45) return "bg-slate-500";
  return "bg-amber-500";
}

// "2026-05-25" → "May 25". Parsed as LOCAL midnight (T00:00:00) so the label
// doesn't shift a day in negative-offset timezones.
function weekLabel(weekKey: string): string {
  return new Date(`${weekKey}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
      <h3 className="text-[10px] uppercase tracking-widest text-slate-400">
        Weekly Trend
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

  // Nothing graded yet → render nothing at all.
  if (!weeklyTrend || weeklyTrend.length === 0) return null;

  // A single bar reads like a glitch — wait for a real trend.
  if (weeklyTrend.length < 2) {
    return (
      <Card>
        <p className="mt-3 text-xs text-slate-500">
          Trend builds as more graded slates accumulate.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mt-4 flex gap-2">
        {/* y axis: 0–100% every 25% */}
        <div
          className="relative flex w-7 shrink-0 flex-col justify-between text-right text-[9px] tabular-nums text-slate-600"
          style={{ height: CHART_H }}
        >
          {["100%", "75%", "50%", "25%", "0%"].map((t) => (
            <span key={t} className="-translate-y-1/2 leading-none">
              {t}
            </span>
          ))}
        </div>

        {/* plot area */}
        <div className="flex-1">
          <div className="relative" style={{ height: CHART_H }}>
            {/* faint gridlines at 25/75 */}
            {[0.25, 0.75].map((g) => (
              <div
                key={g}
                className="absolute inset-x-0 border-t border-slate-800/70"
                style={{ top: CHART_H * (1 - g) }}
              />
            ))}
            {/* 50% reference line — dashed */}
            <div
              className="absolute inset-x-0 border-t border-dashed border-slate-500/70"
              style={{ top: CHART_H * 0.5 }}
            >
              <span className="absolute right-0 -top-2.5 bg-slate-900/50 pl-1 text-[8px] text-slate-500">
                50%
              </span>
            </div>

            {/* bars */}
            <div className="absolute inset-0 flex items-end gap-1.5">
              {weeklyTrend.map((b, i) => (
                <div
                  key={b.week}
                  className="relative flex h-full flex-1 items-end"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className={`w-full rounded-t transition-opacity ${barColor(b.rate)} ${
                      hover === null || hover === i ? "opacity-100" : "opacity-40"
                    }`}
                    style={{ height: `${Math.max(b.rate * 100, 1)}%` }}
                  />
                  {hover === i && (
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-max max-w-[180px] -translate-x-1/2 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] leading-snug text-slate-200 shadow-lg">
                      Week of {weekLabel(b.week)}: {b.correct} correct, {b.wrong}{" "}
                      wrong — {Math.round(b.rate * 100)}% hit rate
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* x axis labels */}
          <div className="mt-1.5 flex gap-1.5">
            {weeklyTrend.map((b) => (
              <div
                key={b.week}
                className="flex-1 text-center text-[9px] tabular-nums text-slate-500"
              >
                {weekLabel(b.week)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
