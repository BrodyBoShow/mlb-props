"use client";

import Link from "next/link";

// Shared date navigation. Used by both PropBoard (live + final slates) and
// FutureSlate (next-3-days preview). Both consumers point the arrows at "/"
// — the home page reads ?date= and switches between PropBoard/FutureSlate
// based on whether projections exist for that date.

const arrowBase =
  "flex h-10 w-10 items-center justify-center rounded-lg text-xl transition-colors select-none";

function formatDateLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export default function DateNav({
  currentDate,
  prevDate,
  nextDate,
}: {
  currentDate: string;
  prevDate: string | null;
  nextDate: string | null;
}) {
  return (
    <div className="mb-5 flex items-center justify-between">
      {prevDate ? (
        <Link
          href={`/?date=${prevDate}`}
          className={`${arrowBase} bg-slate-800 text-slate-200 hover:bg-slate-700`}
          aria-label="Previous day"
        >
          ‹
        </Link>
      ) : (
        <span
          className={`${arrowBase} cursor-not-allowed bg-slate-800/40 text-slate-700`}
          aria-disabled="true"
        >
          ‹
        </span>
      )}

      <span className="text-center text-sm font-semibold text-slate-200">
        {formatDateLong(currentDate)}
      </span>

      {nextDate ? (
        <Link
          href={`/?date=${nextDate}`}
          className={`${arrowBase} bg-slate-800 text-slate-200 hover:bg-slate-700`}
          aria-label="Next day"
        >
          ›
        </Link>
      ) : (
        <span
          className={`${arrowBase} cursor-not-allowed bg-slate-800/40 text-slate-700`}
          aria-disabled="true"
        >
          ›
        </span>
      )}
    </div>
  );
}
