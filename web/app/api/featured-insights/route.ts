import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { BOOK_DISPLAY } from "@/lib/constants";
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
  oppTeam?: string;     // team the pitcher faces — the owner of oppKRate
  agree?: number;       // sharp-agreement count
  total?: number;
  books?: string[];     // sharp-agreement book keys
  dir?: "over" | "under";
  graded?: number;      // graded games of history backing this play
  homeTeam: string;
  awayTeam: string;
};

// Human, analyst voice — the goal is reads that sound like a sharp texting a
// friend, not a templated stat dump. We give it the real numbers and let it
// phrase them naturally; the variety rules stop every card sounding identical.
const SYSTEM_PROMPT =
  "You're a sharp baseball bettor firing off quick prop reads to a friend who " +
  "knows the game. For each play write 1–2 tight sentences, max ~32 words. " +
  "Work the REAL numbers in naturally — projection vs line, the edge, opponent " +
  "strikeout rate, park factor, how many sharp books agree and which way, how " +
  "much graded history backs it. Sound human and confident, not robotic. " +
  "CRITICAL: any strikeout/K rate given is the OPPONENT lineup's (the team the " +
  "pitcher is facing) — attribute it to that opponent, NEVER to the pitcher's " +
  "own team. " +
  "Hard rules: vary your openings — do NOT start every read with the player's " +
  "name, and never start with 'The model', 'The', or 'Facing'. Lead with the " +
  "single biggest factor for THIS play. No hedging, no filler, no emojis, no " +
  "betting advice language like 'lock' or 'guaranteed'. If the history is thin " +
  "(under 4 graded games) or it's a hitter prop (noisy, lines skew under), keep " +
  "the confidence honest.";

// Map prop_type -> a readable noun for the prompt.
const PROP_NOUN: Record<string, string> = {
  strikeouts:         "strikeouts",
  hits_allowed:       "hits allowed",
  outs_recorded:      "outs recorded",
  hitter_hits:        "hits",
  hitter_total_bases: "total bases",
  hitter_hits_runs_rbis: "hits + runs + RBIs",
  hitter_home_runs:   "home runs",
};

function matchupTeams(matchup: string): { away: string; home: string } {
  if (matchup.includes(" @ ")) {
    const [away, home] = matchup.split(" @ ");
    return { away: away ?? "", home: home ?? "" };
  }
  return { away: "", home: "" };
}

function bookList(books?: string[]): string {
  if (!books || books.length === 0) return "";
  return books.map((b) => BOOK_DISPLAY[b] ?? b).join(", ");
}

function historyNote(graded?: number): string {
  if (graded === undefined) return "";
  if (graded === 0) return "no graded games yet (brand-new sample)";
  if (graded < 4) return `thin history — only ${graded} graded game${graded === 1 ? "" : "s"}`;
  return `${graded} graded games of track record`;
}

// One prompt block per play. HR plays omit edge/lean and lead with park context.
function describePlay(p: PlayCtx, n: number): string {
  const teams = p.homeTeam ? `${p.awayTeam} at ${p.homeTeam}` : "";

  if (p.section === "HR MATCHUPS") {
    const pf = p.parkFactor ?? 1.0;
    const parkDesc =
      pf >= 1.04
        ? `a hitter-friendly park (hit factor ${pf.toFixed(2)})`
        : pf <= 0.96
          ? `a pitcher-suppressing park (hit factor ${pf.toFixed(2)})`
          : `a neutral park (hit factor ${pf.toFixed(2)})`;
    const bits = [
      `${n}. SECTION HR MATCHUPS — ${p.player}, ${teams}`,
      `home-run projection ${p.proj.toFixed(2)} in ${parkDesc}`,
    ];
    const h = historyNote(p.graded);
    if (h) bits.push(h);
    bits.push("lead with the park / power matchup; there is NO betting line or edge here");
    return bits.join("; ") + ".";
  }

  const noun = PROP_NOUN[p.prop] ?? p.prop;
  const lean = p.lean === "over" ? "OVER" : "UNDER";
  const bits = [
    `${n}. SECTION ${p.section} — ${p.player}, ${teams}`,
    `${noun}: model projects ${p.proj?.toFixed(1)} against a ${p.line?.toFixed(1)} line, ` +
      `an ${lean} lean (model-vs-market edge ${(p.edge ?? 0).toFixed(2)}, where ~0.12+ is strong)`,
  ];
  if (p.oppKRate !== undefined) {
    // Name the OPPONENT so the LLM attributes the K-rate to the right team — it
    // was previously naming the pitcher's OWN team (e.g. "the Reds' 21% K-rate"
    // for a Reds pitcher facing the Royals). oppKRate is always the opponent's.
    const lineup = p.oppTeam ? `the ${p.oppTeam} lineup` : "the opposing lineup";
    bits.push(`${lineup} (the team ${p.player} is facing) strikes out ${(p.oppKRate * 100).toFixed(0)}% of the time`);
  }
  if (p.agree && p.total) {
    const names = bookList(p.books);
    const where = p.dir ?? (p.lean as string);
    bits.push(
      `${p.agree} of ${p.total} sharp books${names ? ` (${names})` : ""} sit on the ${where}`,
    );
  }
  const h = historyNote(p.graded);
  if (h) bits.push(h);
  if (p.section === "HITTING EDGES") {
    bits.push("hitter prop — noisy, lines skew under, so frame the edge honestly");
  }
  return bits.join("; ") + ".";
}

// The actual Anthropic call, cached by (the contexts) for 30 min. unstable_cache
// keys on the serialized args, so identical play sets reuse the cached insights
// and a new slate (new args) regenerates. Returns a key->sentence map.
const generateInsights = unstable_cache(
  async (ctxs: PlayCtx[]): Promise<Record<string, string>> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || ctxs.length === 0) return {};

    const userText =
      "Write a one- to two-sentence read for each numbered play below. Return " +
      "exactly one line per play, prefixed with its number (e.g. '1. ...') and " +
      "nothing else — no headers, no blank lines. Each read ~32 words max.\n\n" +
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
          max_tokens: Math.min(110 * ctxs.length, 2048),
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
        oppTeam: p.oppTeam,
        agree: p.sharpAgreement?.agree,
        total: p.sharpAgreement?.total,
        books: p.sharpAgreement?.books,
        dir: p.sharpAgreement?.direction,
        graded: p.gradedStarts,
        homeTeam: home,
        awayTeam: away,
      });
    }
  }

  const insights = await generateInsights(ctxs);
  return NextResponse.json({ enabled: true, insights });
}
