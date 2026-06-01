"use client";

import type { FeaturedPlay, PropType } from "@/lib/types";

// Display names for the three pitcher props that can qualify as a featured
// play. The filter in page.tsx restricts to these, so we only need labels
// for them — no need to import the larger PROP_LABELS table.
const PROP_LABEL: Partial<Record<PropType, string>> = {
  strikeouts:    "STRIKEOUTS",
  hits_allowed:  "HITS ALLOWED",
  outs_recorded: "OUTS RECORDED",
};

// Capitalized display names for the books that can qualify. Keep in sync
// with FEATURED_BOOKS in web/app/page.tsx — if a new sportsbook is added
// to that allowlist, add it here too.
const BOOK_LABEL: Record<string, string> = {
  pinnacle:   "Pinnacle",
  draftkings: "DraftKings",
  fanduel:    "FanDuel",
  bet365:     "Bet365",
  caesars:    "Caesars",
};

function fmtNumber(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function fmtEdge(edge: number): string {
  // Featured plays only show positive edges, but the sign is explicit to
  // mirror the EdgeDetail formatting on the regular prop cards.
  return `+${edge.toFixed(2)}`;
}

// Honest, tiered confidence framing from the count of graded starts backing
// this pitcher+prop. We deliberately do NOT inflate or hide thin samples —
// a 1-start play reads "limited history" in muted slate so the user weighs
// it accordingly, while an 8+-start play reads with quiet emerald confidence.
function confidenceLabel(n: number): {
  text: string;
  tone: "strong" | "moderate" | "limited";
} {
  if (n >= 8) return { text: `${n} starts tracked`, tone: "strong" };
  if (n >= 4) return { text: `${n} starts tracked`, tone: "moderate" };
  return {
    text: n === 0 ? "New — limited history" : `${n} start${n === 1 ? "" : "s"} tracked`,
    tone: "limited",
  };
}

function FeaturedPlayCard({ play }: { play: FeaturedPlay }) {
  const isOver = play.lean === "over";
  const arrow = isOver ? "▲" : "▼";
  const leanColor = isOver ? "text-emerald-400" : "text-red-400";
  const leanLabel = isOver ? "OVER" : "UNDER";

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
      {/* header row: player name + prop label */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-100">
            {play.playerName}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {play.matchup}
          </p>
        </div>
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {PROP_LABEL[play.propType] ?? play.propType}
        </span>
      </div>

      {/* divider — matches the slate-800 separators on game cards */}
      <div className="my-3 border-t border-slate-800" />

      {/* numeric row: proj + line, then lean + edge */}
      <div className="flex items-baseline justify-between text-sm tabular-nums">
        <span className="text-slate-300">
          Proj <span className="font-medium text-slate-100">{fmtNumber(play.projection)}</span>
          <span className="mx-2 text-slate-600">·</span>
          Line <span className="font-medium text-slate-100">{fmtNumber(play.line)}</span>
        </span>
      </div>
      <div className="mt-2 flex items-baseline justify-between text-sm tabular-nums">
        <span className={`font-semibold ${leanColor}`}>
          {arrow} {leanLabel}
        </span>
        <span className="font-semibold text-emerald-400">
          Edge {fmtEdge(play.edge)}
        </span>
      </div>

      {/* book attribution */}
      <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">
        Book: {BOOK_LABEL[play.bookmaker] ?? play.bookmaker}
      </p>

      {/* confidence — how much graded history backs this play */}
      <ConfidenceLine count={play.gradedStarts} />
    </div>
  );
}

function ConfidenceLine({ count }: { count: number }) {
  const { text, tone } = confidenceLabel(count);
  const textColor =
    tone === "strong"
      ? "text-emerald-400/70"
      : tone === "moderate"
        ? "text-slate-400"
        : "text-slate-500";
  const dotColor =
    tone === "strong"
      ? "bg-emerald-500"
      : tone === "moderate"
        ? "bg-slate-400"
        : "bg-slate-600";

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
      <span className={`text-[10px] uppercase tracking-wide ${textColor}`}>
        {text}
      </span>
    </div>
  );
}

export default function FeaturedPlays({ plays }: { plays: FeaturedPlay[] }) {
  // Stay hidden unless there are at least 3 qualifying plays. The spec
  // requires this so a thin day doesn't promote marginal data to top of
  // page — page.tsx slices to 5 max, so the visible range is 3..5.
  if (plays.length < 3) return null;

  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-slate-100">Featured Plays</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Highest-edge plays · main market lines only · model vs de-vigged book
        probability
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plays.map((play) => (
          <FeaturedPlayCard
            key={`${play.gameId}-${play.playerId}-${play.propType}`}
            play={play}
          />
        ))}
      </div>

      <p className="mt-3 text-[10px] text-slate-600">
        Edge = model probability minus de-vigged book probability. Positive =
        model favors the over vs what the book implies. Not financial advice.
      </p>
    </section>
  );
}
