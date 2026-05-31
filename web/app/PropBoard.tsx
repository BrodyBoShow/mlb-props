"use client";

import { useState } from "react";

// ── types ────────────────────────────────────────────────────────────────────

export type PropType =
  | "strikeouts"
  | "hits_allowed"
  | "walks"
  | "earned_runs"
  | "outs_recorded";

export type GameGroup = {
  game_id: number;
  matchup: string;
  pitchers: { name: string; projection: number }[];
};

export type ByProp = Record<PropType, GameGroup[]>;

// ── prop metadata ─────────────────────────────────────────────────────────────

const PROPS: { key: PropType; label: string; unit: string }[] = [
  { key: "strikeouts",    label: "Strikeouts",    unit: "K"    },
  { key: "hits_allowed",  label: "Hits Allowed",  unit: "H"    },
  { key: "walks",         label: "Walks",         unit: "BB"   },
  { key: "earned_runs",   label: "Earned Runs",   unit: "ER"   },
  { key: "outs_recorded", label: "Outs Recorded", unit: "outs" },
];

// ── component ─────────────────────────────────────────────────────────────────

export default function PropBoard({
  date,
  byProp,
}: {
  date: string;
  byProp: ByProp;
}) {
  const [active, setActive] = useState<PropType>("strikeouts");

  const activeMeta = PROPS.find((p) => p.key === active)!;
  const groups = byProp[active] ?? [];

  return (
    <>
      {/* prop selector tabs */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
        {PROPS.map((p) => (
          <button
            key={p.key}
            onClick={() => setActive(p.key)}
            className={[
              "shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              active === p.key
                ? "bg-emerald-500 text-slate-950"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100",
            ].join(" ")}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* game cards */}
      {groups.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          No {activeMeta.label.toLowerCase()} projections for {date}.
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section
              key={g.game_id}
              className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50"
            >
              <div className="border-b border-slate-800 bg-slate-900 px-5 py-3">
                <h2 className="font-semibold text-slate-200">{g.matchup}</h2>
              </div>
              <ul className="divide-y divide-slate-800">
                {g.pitchers.map((p, i) => (
                  <li
                    key={`${g.game_id}-${i}`}
                    className="flex items-center justify-between px-5 py-3"
                  >
                    <span className="text-slate-100">{p.name}</span>
                    <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400 tabular-nums">
                      {p.projection.toFixed(1)} {activeMeta.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
