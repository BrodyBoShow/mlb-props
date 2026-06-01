import { BOOK_DISPLAY } from "@/lib/constants";
import type { SharpAgreement } from "@/lib/types";

/**
 * Sharp-money agreement badge (feature 5).
 *
 * Reads "N/N OVER" or "N/N UNDER": the model is on that side of N of the
 * total qualifying sportsbook lines. The DIRECTION is the de-vigged edge's
 * lean (computed in page.tsx with the same EDGE_THRESHOLD the EdgeDetail
 * arrow uses), so the badge can't contradict the arrow and never appears on
 * ~Even rows. This component only tiers + renders.
 *
 * Tiers:
 *   - full    (agree >= 3 && agree === total): every qualifying real book
 *     corroborates the edge's lean. Emerald + ◆.
 *   - partial (agree >= 2):                     a majority corroborate but
 *     not all. Muted slate.
 *   - none    (agree < 2):                       sharpAgreement is undefined
 *     upstream, so this component isn't rendered.
 */
export default function SharpBadge({ sharp }: { sharp: SharpAgreement | undefined }) {
  if (!sharp || sharp.agree < 2) return null;

  const full = sharp.agree >= 3 && sharp.agree === sharp.total;
  const palette = full
    ? "border-emerald-700/50 bg-emerald-950/40 text-emerald-300"
    : "border-slate-700 bg-slate-900 text-slate-400";

  const dirWord = sharp.direction.toUpperCase();   // "OVER" | "UNDER"
  const bookNames = sharp.books
    .map((b) => BOOK_DISPLAY[b] ?? b)
    .join(", ");
  const scope = full ? `all ${sharp.total}` : `${sharp.agree} of ${sharp.total}`;
  const title =
    `Model is on the ${sharp.direction} side of ${scope} sportsbook ` +
    `line${sharp.total === 1 ? "" : "s"} (${bookNames})`;

  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide tabular-nums ${palette}`}
    >
      {full && <span aria-hidden="true">◆</span>}
      {sharp.agree}/{sharp.total} {dirWord}
    </span>
  );
}
