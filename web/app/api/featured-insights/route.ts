import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import type { FeaturedSection } from "@/lib/types";

// Runs on the Node runtime (uses process.env + fetch to Anthropic).
export const runtime = "nodejs";

// One play's context flattened for the LLM. Built server-side from the posted
// sections so the prompt only carries what the insight needs.
type PlayCtx = {
  key: string;          // `${playerId}|${propType}` — how the client merges back
  section: string;      // "PITCHING EDGES" | "HITTING EDGES" | "HR MATCHUPS"
  player: string;
  prop: string;
  proj: number;
  line?: number;
  edge?: number;
  lean?: "over" | "under";
  parkFactor?: number;
  oppKRate?: number;
  agree?: number;       // sharp-agreement count
  total?: number;
  homeTeam: string;
  awayTeam: string;
};

const SYSTEM_PROMPT =
  "You write one-sentence baseball prop insights. Be specific, punchy, " +
  "under 20 words. No filler. Don't start with 'The model' or 'The'. " +
  "Lead with the key matchup factor.";

// Map prop_type -> a readable noun for the prompt.
const PROP_NOUN: Record<string, string> = {
  strikeouts:         "strikeouts",
  hits_allowed:       "hits allowed",
  outs_recorded:      "outs recorded",
  hitter_hits:        "hits",
  hitter_total_bases: "total bases",
  hitter_home_runs:   "home runs",
};

function matchupTeams(matchup: string): { away: string; home: string } {
  if (matchup.includes(" @ ")) {
    const [away, home] = matchup.split(" @ ");
    return { away: away ?? "", home: home ?? "" };
  }
  return { away: "", home: "" };
}

// One prompt line per play. HR plays omit edge/lean and lead with park context.
function describePlay(p: PlayCtx, n: number): string {
  if (p.section === "HR MATCHUPS") {
    const pf = p.parkFactor !== undefined ? p.parkFactor.toFixed(2) : "1.00";
    const venue = p.homeTeam ? `${p.homeTeam} ballpark` : "the ballpark";
    return (
      `${n}. [HR MATCHUP] ${p.player} (${p.awayTeam} @ ${p.homeTeam}), ` +
      `projected ${p.proj.toFixed(2)} HR, ${venue} hit park factor ${pf}. ` +
      `Lead with park + matchup; do not mention an edge or a betting line.`
    );
  }
  const noun = PROP_NOUN[p.prop] ?? p.prop;
  const lean = p.lean === "over" ? "OVER" : "UNDER";
  const parts = [
    `${n}. [${p.section}] ${p.player} (${p.awayTeam} @ ${p.homeTeam}), ` +
      `${noun}: projected ${p.proj.toFixed(1)} vs line ${p.line?.toFixed(1)}, ` +
      `model leans ${lean} (edge ${p.edge?.toFixed(2)})`,
  ];
  if (p.oppKRate !== undefined) {
    parts.push(`opponent lineup K rate ${(p.oppKRate * 100).toFixed(0)}%`);
  }
  if (p.agree && p.total) {
    parts.push(`${p.agree}/${p.total} sharp books agree`);
  }
  return parts.join(", ") + ".";
}

// The actual Anthropic call, cached by (the contexts) for 30 min. unstable_cache
// keys on the serialized args, so identical play sets reuse the cached insights
// and a new slate (new args) regenerates. Returns a key->sentence map.
const generateInsights = unstable_cache(
  async (ctxs: PlayCtx[]): Promise<Record<string, string>> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || ctxs.length === 0) return {};

    const userText =
      "Write one insight sentence for each numbered play below. Return " +
      "exactly one line per play, prefixed with its number (e.g. '1. ...'). " +
      "Keep each under 20 words.\n\n" +
      ctxs.map((p, i) => describePlay(p, i + 1)).join("\n");

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: Math.min(60 * ctxs.length, 1024),
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userText }],
        }),
      });
      if (!res.ok) {
        console.error(`[featured-insights] Anthropic ${res.status}: ${await res.text()}`);
        return {};
      }
      const data = await res.json();
      const text: string =
        data?.content?.map((b: { text?: string }) => b.text ?? "").join("") ?? "";

      // Parse numbered lines back to plays by index.
      const out: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+)[.):]\s*(.+)$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10) - 1;
        const ctx = ctxs[idx];
        if (ctx) out[ctx.key] = m[2].trim();
      }
      return out;
    } catch (err) {
      console.error("[featured-insights] fetch failed:", err);
      return {};
    }
  },
  ["featured-insights"],
  { revalidate: 60 * 30 }, // 30 min — refreshes when the play set changes
);

export async function POST(req: Request) {
  let sections: FeaturedSection[] = [];
  try {
    const body = await req.json();
    sections = Array.isArray(body?.sections) ? body.sections : [];
  } catch {
    return NextResponse.json({ enabled: false, insights: {} });
  }

  // No key → render the cards with no insight line (and tell the client so it
  // skips the loading shimmer).
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ enabled: false, insights: {} });
  }

  // Flatten the posted sections into compact LLM contexts.
  const ctxs: PlayCtx[] = [];
  for (const section of sections) {
    for (const p of section.plays ?? []) {
      const { away, home } = matchupTeams(p.matchup ?? "");
      ctxs.push({
        key: `${p.playerId}|${p.propType}`,
        section: section.label,
        player: p.playerName,
        prop: p.propType,
        proj: p.projection,
        line: p.line,
        edge: p.edge,
        lean: p.lean,
        parkFactor: p.parkFactor,
        oppKRate: p.oppKRate,
        agree: p.sharpAgreement?.agree,
        total: p.sharpAgreement?.total,
        homeTeam: home,
        awayTeam: away,
      });
    }
  }

  const insights = await generateInsights(ctxs);
  return NextResponse.json({ enabled: true, insights });
}
