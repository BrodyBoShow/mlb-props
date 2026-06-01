"use client";

import { useEffect, useState } from "react";

// Relative "updated Nm ago" label from a real ISO timestamp. Honest: it only
// counts UP from the actual max(projections.updated_at, lines.fetched_at) the
// server passed — it never advances to "now" or claims data is fresher than
// it is.
function relativeLabel(iso: string): string {
  const then = new Date(iso).getTime();
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `updated ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `updated ${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `updated ${d}d ago`;
}

// Absolute time in the USER'S LOCAL timezone (no explicit timeZone → the
// browser's). This is why the whole line is client-rendered: the server
// (UTC on Vercel) can't know the viewer's zone, and hardcoding ET made
// "5:39 PM EDT" disagree with a Pacific user's 4:41 PM wall clock + the
// relative counter. timeZoneName:"short" keeps it labeled (e.g. "PDT").
function absoluteLocal(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

// Renders the entire "Last updated: <local time> · <relative>" line.
// Client-only so the absolute time is in the viewer's timezone and stays
// consistent with the relative counter. Both recompute every 30s.
export default function LiveUpdated({ iso }: { iso: string }) {
  // null on the server + first paint so SSR and first client render match
  // (the formatted strings are timezone/clock-dependent — computing them only
  // after mount avoids a hydration mismatch). Filled in immediately by the
  // effect, then re-ticked every 30s.
  const [view, setView] = useState<{ abs: string; rel: string } | null>(null);

  useEffect(() => {
    const tick = () => setView({ abs: absoluteLocal(iso), rel: relativeLabel(iso) });
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [iso]);

  if (view === null) {
    return <p className="mt-0.5 text-sm text-slate-400">Last updated…</p>;
  }

  return (
    <p className="mt-0.5 text-sm text-slate-400">
      Last updated: {view.abs}
      <span className="ml-1.5 inline-flex items-center gap-1.5 text-slate-500">
        <span className="text-slate-600">·</span>
        {/* pulsing live dot — same animate-ping pattern as the LIVE game chip */}
        <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        {view.rel}
      </span>
    </p>
  );
}
