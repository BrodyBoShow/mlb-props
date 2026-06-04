// Shared display formatters — pure, presentation-only, no model math.
// Consolidated from byte-identical copies that lived in PropBoard.tsx,
// ResultsBoard.tsx, and FutureSlate.tsx.

// Whole number → string; otherwise one decimal. (e.g. 5 → "5", 5.2 → "5.2")
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// "YYYY-MM-DD" → "Wed, Jun 4" (parsed as local midnight so no TZ day-shift).
export function formatShortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
