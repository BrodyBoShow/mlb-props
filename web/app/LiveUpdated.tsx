"use client";

import { useEffect, useState } from "react";

// Relative "updated Nm ago" label from a real ISO timestamp. Honest: it only
// counts UP from the actual max(projections.updated_at, lines.fetched_at) the
// server rendered — it never advances to "now" or claims data is fresher than
// it is. The absolute timestamp beside it stays the authoritative signal.
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

export default function LiveUpdated({ iso }: { iso: string }) {
  // null on the server + first paint so SSR and first client render match
  // (avoids a hydration mismatch on the time-dependent string). The effect
  // fills it in immediately after mount, then re-ticks every 30s.
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setLabel(relativeLabel(iso));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [iso]);

  if (label === null) return null;

  return (
    <span className="ml-1.5 inline-flex items-center gap-1.5 text-slate-500">
      <span className="text-slate-600">·</span>
      {/* pulsing live dot — same animate-ping pattern as the LIVE game chip */}
      <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      {label}
    </span>
  );
}
