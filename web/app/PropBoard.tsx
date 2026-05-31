"use client";

import { useState } from "react";

// ── types ────────────────────────────────────────────────────────────────────

export type PropType =
  | "strikeouts"
  | "hits_allowed"
  | "walks"
  | "earned_runs"
  | "outs_recorded";

// One pitcher row. Projection is always present; edge fields are optional —
// most pitchers won't have a betting line, and all values are pre-computed by
// the engine (the frontend does ZERO math).
export type Pitcher = {
  name: string;
  projection: number;
  line?: number;
  edge?: number;
  fairOverProb?: number;
  modelOverProb?: number;
  overPrice?: number;
  underPrice?: number;
  bookmaker?: string;
};

export type GameGroup = {
  game_id: number;
  matchup: string;
  pitchers: Pitcher[];
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

// Edge threshold for calling a side a real lean vs. roughly even.
const EDGE_THRESHOLD = 0.1;

// ── edge sub-component ──────────────────────────────────────────────────────
// Pure display. Receives the pre-computed edge + line and picks colors/labels.

function EdgeDetail({ pitcher }: { pitcher: Pitcher }) {
  // No line for this pitcher → render nothing (the common case).
  if (pitcher.edge === undefined || pitcher.line === undefined) {
    return null;
  }

  const edge = pitcher.edge;
  const signed = `${edge >= 0 ? "+" : "−"}${Math.abs(edge).toFixed(2)}`;

  let edgeNode;
  if (edge > EDGE_THRESHOLD) {
    edgeNode = (
      <span className="text-emerald-400">▲ Edge {signed}</span>
    );
  } else if (edge < -EDGE_THRESHOLD) {
    edgeNode = (
      <span className="text-red-400">▼ Edge {signed}</span>
    );
  } else {
    edgeNode = <span className="text-slate-500">~Even</span>;
  }

  return (
    <div className="mt-1 text-xs tabular-nums">
      <span className="text-slate-500">Line {pitcher.line}</span>
      <span className="mx-1.5 text-slate-600">·</span>
      {edgeNode}
    </div>
  );
}

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
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
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

      {/* edge legend */}
      <p className="mb-6 text-xs leading-relaxed text-slate-500">
        Edge = model probability vs. book implied probability.{" "}
        <span className="text-emerald-400">Positive</span> = model favors the
        over. Most pitchers have no line until closer to game time.
      </p>

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
                    className="flex items-start justify-between px-5 py-3"
                  >
                    <div className="min-w-0">
                      <span className="text-slate-100">{p.name}</span>
                      <EdgeDetail pitcher={p} />
                    </div>
                    <span className="ml-3 shrink-0 rounded-md bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-400 tabular-nums">
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
