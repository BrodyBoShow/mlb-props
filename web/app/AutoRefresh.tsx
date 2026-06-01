"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Soft-refresh the page on an interval so a new cron run appears on its own.
// router.refresh() re-runs the (force-dynamic) server component — getSlate
// re-fetches projections/lines/edges and re-renders Server Components — while
// PRESERVING client React state (the selected prop tab, the live box-score /
// game-status hooks). The URL is untouched, so the selected ?date= persists.
//
// Honesty: this only triggers a re-fetch; the "Last updated" timestamp still
// reflects the real max(projections.updated_at, lines.fetched_at). When a new
// run has landed, that timestamp advances and the relative counter resets to
// "just now"; when nothing changed, the displayed time is unchanged.
//
// 2.5 min interval — slower than the 60s live-overlay polls (those handle
// in-game stats); this is for picking up new cron writes. Paused while the
// tab is hidden, with one catch-up refresh on regaining focus.
const REFRESH_MS = 150_000;

export default function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id === null) id = setInterval(() => router.refresh(), REFRESH_MS);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh();   // catch up immediately on focus
        start();
      } else {
        stop();             // no pointless background fetches while hidden
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  return null;
}
