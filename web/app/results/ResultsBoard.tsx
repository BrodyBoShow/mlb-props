"use client";

import Link from "next/link";
import { useState } from "react";

// ── types ─────────────────────────────────────────────────────────────────────

export type PlayerResult = {
  playerId: number;
  name: string;
  playerType: "pitcher" | "hitter";
  projection: number;
  actual: number;
  diff: number;       // actual - projection (pre-computed server-side)
  hit: boolean;       // actual >= projection (pre-computed server-side)
};

export type GameResult = {
  gameId: number;
  matchup: string;
  players: PlayerResult[];
};

// ── date nav ──────────────────────────────────────────────────────────────────

function formatDateLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

const arrowBase =
  "flex h-10 w-10 items-center justify-center rounded-lg text-xl transition-colors select-none";

function DateNav({
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
          href={`/results?date=${prevDate}`}
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
          href={`/results?date=${nextDate}`}
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

// ── summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ players }: { players: PlayerResult[] }) {
  if (players.length === 0) return null;
  const hits = players.filter((p) => p.hit).length;
  const pct = Math.round((hits / players.length) * 100);
  const colorClass =
    pct >= 60 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400";

  return (
    <div className={`mb-5 text-sm font-medium ${colorClass}`}>
      {hits} of {players.length} projections hit ({pct}%)
    </div>
  );
}

// ── player row ────────────────────────────────────────────────────────────────

function PlayerRow({ p }: { p: PlayerResult }) {
  const diffSign = p.diff >= 0 ? "+" : "−";
  const diffStr = `${diffSign}${Math.abs(p.diff).toFixed(1)}`;
  const hitColor = p.hit ? "text-emerald-400" : "text-red-400";

  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3">
      <span className="min-w-0 truncate text-slate-100">{p.name}</span>
      <div className="flex shrink-0 items-center gap-2 tabular-nums">
        {/* projection badge */}
        <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400">
          {p.projection.toFixed(1)}
        </span>
        {/* actual */}
        <span className={`text-sm font-semibold ${hitColor}`}>
          {p.actual.toFixed(1)}
        </span>
        {/* diff */}
        <span className={`w-12 text-right text-xs ${hitColor}`}>{diffStr}</span>
      </div>
    </li>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function ResultsBoard({
  date,
  prevDate,
  nextDate,
  games,
}: {
  date: string;
  prevDate: string | null;
  nextDate: string | null;
  games: GameResult[];
}) {
  type Tab = "pitchers" | "hitters";
  const [tab, setTab] = useState<Tab>("pitchers");

  // Map tab label → playerType value for filtering.
  const typeFilter: PlayerResult["playerType"] = tab === "pitchers" ? "pitcher" : "hitter";

  // Flatten all players for the summary bar (filtered by tab).
  const allPlayers = games.flatMap((g) =>
    g.players.filter((p) => p.playerType === typeFilter)
  );

  return (
    <>
      <DateNav currentDate={date} prevDate={prevDate} nextDate={nextDate} />

      {/* tabs */}
      <div className="mb-4 flex gap-2">
        {(["pitchers", "hitters"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "rounded-lg px-4 py-2 text-sm font-medium capitalize transition-colors",
              tab === t
                ? "bg-emerald-500 text-slate-950"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
            ].join(" ")}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* summary bar */}
      <SummaryBar players={allPlayers} />

      {/* column labels */}
      <div className="mb-2 flex items-center justify-between px-5 text-xs text-slate-500">
        <span>Player</span>
        <div className="flex gap-2 tabular-nums">
          <span className="w-14 text-center">Proj</span>
          <span className="w-10 text-center">Actual</span>
          <span className="w-12 text-right">Diff</span>
        </div>
      </div>

      {/* game sections */}
      {games.every((g) => g.players.filter((p) => p.playerType === typeFilter).length === 0) ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No {tab} results for {date}.
        </div>
      ) : (
        <div className="space-y-5">
          {games.map((g) => {
            const rows = g.players.filter((p) => p.playerType === typeFilter);
            if (rows.length === 0) return null;
            return (
              <section
                key={g.gameId}
                className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50"
              >
                <div className="border-b border-slate-800 bg-slate-900 px-5 py-3">
                  <h2 className="font-semibold text-slate-200">{g.matchup}</h2>
                </div>
                <ul className="divide-y divide-slate-800">
                  {rows.map((p) => (
                    <PlayerRow key={p.playerId} p={p} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
