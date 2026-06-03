"use client";

import { useEffect, useState } from "react";

// "Showing <date> projections" stale banner — judged from the VIEWER'S local
// calendar day, not Eastern. The slate data itself is ET-keyed (MLB schedules
// are ET), but whether a given slate is "stale" for the person looking at it
// depends on THEIR date: an Arizona user at 9 PM is still on today's slate even
// though it's already tomorrow in ET. The viewer's date is only knowable on the
// client, so this renders nothing on the server / first paint (no hydration
// mismatch) and decides after mount.
function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default function StaleBanner({
  date,
  hasData,
  hasCurrentProjections,
}: {
  date: string | null;
  hasData: boolean; // updatedAt !== null
  hasCurrentProjections: boolean; // a projection_date >= todayET exists (suppressor)
}) {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!date || !hasData || hasCurrentProjections) {
      setStale(false);
      return;
    }
    // Viewer's LOCAL date in YYYY-MM-DD (en-CA gives ISO-style, local tz).
    const browserToday = new Date().toLocaleDateString("en-CA");
    setStale(date < browserToday);
  }, [date, hasData, hasCurrentProjections]);

  if (!stale || !date) return null;
  return (
    <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
      Showing {formatDate(date)} projections — today&apos;s slate updates after 8 AM ET.
    </div>
  );
}
