import { BOOK_DISPLAY } from "@/lib/constants";
import type { SharpAgreement } from "@/lib/types";

/**
 * Sharp-money agreement badge (feature 5).
 *
 * Flags when multiple REAL two-sided sportsbooks all sit on the side the
 * model favors — independent multi-book consensus, distinct from the edge
 * number. The data (agree/total) is computed server-side in page.tsx from
 * per-book lines; this component only tiers + renders.
 *
 * Tiers:
 *   - full    (agree >= 3 && agree === total): all real books with a line
 *     agree with the model's lean. Emerald.
 *   - partial (agree >= 2):                     a clear majority agree but
 *     not unanimous. Muted slate.
 *   - none    (agree < 2):                       no badge — sharpAgreement is
 *     undefined upstream, so this component isn't rendered.
 */
export default function SharpBadge({ sharp }: { sharp: SharpAgreement | undefined }) {
  if (!sharp || sharp.agree < 2) return null;

  const full = sharp.agree >= 3 && sharp.agree === sharp.total;
  const palette = full
    ? "border-emerald-700/50 bg-emerald-950/40 text-emerald-300"
    : "border-slate-700 bg-slate-900 text-slate-400";

  const bookNames = sharp.books
    .map((b) => BOOK_DISPLAY[b] ?? b)
    .join(", ");
  const title =
    `${sharp.agree} of ${sharp.total} sharp books (${bookNames}) sit on the ` +
    `${sharp.direction} side the model favors`;

  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide tabular-nums ${palette}`}
    >
      {full && <span aria-hidden="true">◆</span>}
      Sharp {sharp.agree}/{sharp.total}
    </span>
  );
}
