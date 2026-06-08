import Link from "next/link";
import { unstable_cache } from "next/cache";
import { fetchAllPages, getSupabaseClient, resolveExistingColumns } from "@/lib/supabase";
import { ALL_PROP_TYPES, EDGE_THRESHOLD, FEATURED_MIN_LINE, FEATURED_PROJ_CAP, FEATURED_PROJ_FLOOR, HITTER_MIN_GAMES_TRACKED, HR_MIN_GAMES_TRACKED, PARK_FACTORS_HITS, REAL_BOOKS, SHARP_MIN_LINE } from "@/lib/constants";
import { hrComposite } from "@/lib/hrComposite";
import type { ByProp, FeaturedPlay, FeaturedSection, GameGroup, PropType, Trends, TrendWindow } from "@/lib/types";
import PropBoard from "./PropBoard";
import FutureSlate, { type FutureGame } from "./FutureSlate";
import LiveUpdated from "./LiveUpdated";
import AutoRefresh from "./AutoRefresh";
import StaleBanner from "./StaleBanner";

// ── Featured-play filter constants ───────────────────────────────────────────
// Tight filters — featuring a marginal play on the top of the home page is
// worse than featuring nothing. See the per-filter comments at the build
// site below for the reasoning on each threshold.

// Real two-sided sportsbooks only. DFS apps (PrizePicks, Underdog, Sleeper,
// Betr) don't post symmetric over/under markets, so the de-vig math behind
// the `edge` field doesn't apply to them and any "edge" we'd surface would
// be against an artificial baseline. The featured section requires a real
// book to anchor the claim.
// Books that can anchor a featured edge. Sharp two-sided books de-vig to a real
// market fair; 'consensus' is edge.py's de-vigged average of DraftKings/FanDuel
// two-sided lines (a real edge, just synthetic — used so the hitting section has
// non-fantasy candidates to diversify with); 'prizepicks' is included so DFS-only
// props (HFS/PFS/1st-inning) — which edge.py scores against a PrizePicks-fair
// (~0.5) — can be featured. (REAL_BOOKS in @/lib/constants stays sharp-only: the
// board still renders a prizepicks/consensus edge muted, never a colored edge.)
const FEATURED_BOOKS: ReadonlySet<string> = new Set([
  "pinnacle", "draftkings", "fanduel", "bet365", "caesars", "consensus", "prizepicks",
]);

// Rank weights so the strongest TRUSTWORTHY edge leads. A sharp two-sided book
// (1.0) > a de-vigged consensus of DK/FD (0.9, synthetic) > a soft DFS pick'em
// (0.85). Applied to ORDERING only — the gate uses the raw |edge|, and the
// displayed edge is unchanged.
const BOOK_RANK_WEIGHT = (book?: string): number =>
  book === "prizepicks" ? DFS_RANK_DISCOUNT : book === "consensus" ? 0.9 : 1;

// Max plays of the SAME prop type a section may show, so a section is never
// 3-of-a-kind (e.g. 3 hitter-fantasy unders). The 3rd slot goes to the next
// best DIFFERENT prop; if none qualifies, the section shows fewer than 3.
const FEATURED_MAX_PER_PROP = 2;

// Pick up to `n` plays from a ranked list: at most `maxPerProp` of any one prop,
// and each PLAYER at most once (no card showing the same guy on two props).
function pickDiverse(plays: FeaturedPlay[], n: number, maxPerProp: number): FeaturedPlay[] {
  const out: FeaturedPlay[] = [];
  const counts: Record<string, number> = {};
  const seenPlayers = new Set<number>();
  for (const p of plays) {
    if (out.length >= n) break;
    if (seenPlayers.has(p.playerId)) continue;
    if ((counts[p.propType] ?? 0) >= maxPerProp) continue;
    out.push(p);
    counts[p.propType] = (counts[p.propType] ?? 0) + 1;
    seenPlayers.add(p.playerId);
  }
  return out;
}

// Section 1 (PITCHING EDGES) props — EVERY pitcher prop with a real or DFS line,
// ranked by |edge|, top-3. Expansion (2026-06-05): added walks, earned_runs, the
// PrizePicks fantasy score, and both 1st-inning markets so any pitcher prop with
// a meaningful edge can headline — not just strikeouts/hits/outs. The per-prop
// floor (FEATURED_MIN_LINE) + cap (FEATURED_PROJ_CAP) + |edge|>=0.12 gate quality.
const FEATURED_PITCHER_PROPS: ReadonlySet<PropType> = new Set([
  "strikeouts", "hits_allowed", "outs_recorded", "walks", "earned_runs",
  "pitcher_fantasy_score",
  "pitcher_first_inning_pitches", "pitcher_first_inning_strikeouts",
]);

// Section 2 (HITTING EDGES) props — hitter props with a real or DFS line, top-3.
// Adds hitter_fantasy_score (PrizePicks DFS) to the existing hits/TB/HRR. We
// OMIT hitter_rbis / hitter_runs (consensus 0.5-line base-rate noise, documented)
// and hitter_home_runs (its own composite HR MATCHUPS section).
const FEATURED_HITTER_PROPS: ReadonlySet<PropType> = new Set([
  "hitter_hits", "hitter_total_bases", "hitter_hits_runs_rbis",
  "hitter_fantasy_score",
]);

// Edge threshold is set ABOVE the regular display threshold (0.10) so we
// don't promote borderline calls. 0.12 = a clear vote for one side after
// vig is removed.
const FEATURED_MIN_EDGE = 0.12;

// Upper bound — a de-vigged edge this large is a broken thin-sample projection,
// not a real market edge (the market isn't off by 40%+ after vig). Skip it.
const FEATURED_MAX_EDGE = 0.4;

// DFS (PrizePicks) edges are measured vs a soft ~50/50 pick'em line, not a
// de-vigged efficient sharp market, so a DFS edge of magnitude X is a weaker
// signal than a sharp edge of the same X. We still gate on the RAW |edge|
// (>= FEATURED_MIN_EDGE) — DFS props qualify on their own merit — but RANK them
// at a small discount so an equal sharp edge sorts ahead and DFS plays never
// bury the more-reliable sharp ones in the top-3. Display value is unchanged.
const DFS_RANK_DISCOUNT = 0.85;

// |projection - line| floor. The model can be technically "leaning over"
// while sitting 0.05 away from the line — that's not a meaningful call,
// it's noise. 0.3 keeps featured plays to ones where the projection is
// visibly off the line.
const FEATURED_MIN_LEAN = 0.3;

// FEATURED_PROJ_CAP (per-prop projection sanity ceiling) now lives in
// @/lib/constants as the single source of truth — shared with the /results
// Featured-Plays hit-rate so the board and results agree on which plays count.

// Featured plays + the sharp badge both use the shared MIN_LINE map (the same
// thresholds /results uses) so alt lines never inflate a featured edge or a
// sharp count. Imported from @/lib/constants — single source of truth.

// Hit-rate trends (L5/L10/L15/SZN vs the line) — the props.cash-style panel,
// shown ONLY in the focused single-prop card. Covers pitcher AND hitter main
// props (fantasy props omitted — they're a computed total, not a single graded
// column). Same graded actuals the spark dots use; this just computes windows
// from them. Pure display — no projection/edge/model involvement.
const TREND_ACTUAL_COL: Partial<Record<PropType, string>> = {
  strikeouts:             "actual_strikeouts",
  hits_allowed:           "actual_hits_allowed",
  outs_recorded:          "actual_outs_recorded",
  pitcher_first_inning_pitches: "actual_first_inning_pitches",
  pitcher_first_inning_strikeouts: "actual_first_inning_strikeouts",
  walks:                  "actual_walks",
  earned_runs:            "actual_earned_runs",
  hitter_hits:            "actual_hits",
  hitter_total_bases:     "actual_total_bases",
  hitter_hits_runs_rbis:  "actual_hits_runs_rbis",
  hitter_rbis:            "actual_rbis",
  hitter_runs:            "actual_runs",
  hitter_home_runs:       "actual_home_runs",
};

// Always read fresh from the DB at request time — the cron updates rows
// throughout the day. No caching of stale projections.
export const dynamic = "force-dynamic";

// Simple guard for URL ?date= param — must be YYYY-MM-DD.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shape of a projection row with its joined player + game.
type ProjectionRow = {
  game_id: number;
  player_id: number;
  prop_type: string;
  projection: number;
  confidence: number | null;
  players: { full_name: string | null } | null;
  // start_time is the first-pitch UTC timestamp from the games table — used
  // to order the cards chronologically so the slate matches MLB's schedule
  // page. Nullable for slots statsapi reported as TBD.
  games: { home_team: string; away_team: string; start_time: string | null } | null;
};

// Shape of an edge row from the edges table. All values are pre-computed by
// the engine — the frontend never does any of this math.
type EdgeRow = {
  player_id: number;
  prop_type: string;
  bookmaker: string;
  line: number;
  fair_over_prob: number | null;
  model_over_prob: number | null;
  edge: number | null;
  over_price: number | null;
  under_price: number | null;
};

type SlateResult = {
  date: string | null;
  updatedAt: string | null;
  prevDate: string | null;
  nextDate: string | null;
  byProp: ByProp;
  futureGames: FutureGame[] | null;
  featuredSections: FeaturedSection[];
  // True when at least one projection_date in the DB is >= today (ET).
  // Used by the page component to suppress the "stale" banner when the
  // user is intentionally browsing a past date but current data exists.
  hasCurrentProjections: boolean;
};

// Empty result used when there's no data to show.
const emptyResult = (date: string | null = null): SlateResult => ({
  date,
  updatedAt: null,
  prevDate: null,
  nextDate: null,
  byProp: Object.fromEntries(
    ALL_PROP_TYPES.map((p) => [p, []])
  ) as unknown as ByProp,
  futureGames: null,
  featuredSections: [],
  hasCurrentProjections: false,
});

async function getSlate(dateOverride?: string): Promise<SlateResult> {
  const supabase = getSupabaseClient();
  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });

  // Resolve the date to display. Two queries (run in parallel):
  //   1. Earliest projection_date >= today ET — the user's "now" slate.
  //      Doubles as the hasCurrentProjections probe.
  //   2. Latest projection_date overall — fallback when there's no current
  //      data (e.g. early morning before today's cron has produced rows).
  // Explicit dateOverride (› / ‹ navigation) always wins — we render that
  // date exactly, never redirect.
  const [{ data: futureData }, { data: latestData }] = await Promise.all([
    supabase
      .from("projections")
      .select("projection_date")
      .gte("projection_date", todayET)
      .order("projection_date", { ascending: true })
      .limit(1),
    supabase
      .from("projections")
      .select("projection_date")
      .order("projection_date", { ascending: false })
      .limit(1),
  ]);

  const todayOrFutureDate =
    (futureData?.[0]?.projection_date as string | undefined) ?? null;
  const latestAnyDate =
    (latestData?.[0]?.projection_date as string | undefined) ?? null;
  const hasCurrentProjections = todayOrFutureDate !== null;

  let selectedDate: string;
  if (dateOverride) {
    selectedDate = dateOverride;
  } else {
    const resolved = todayOrFutureDate ?? latestAnyDate;
    if (!resolved) return emptyResult();
    selectedDate = resolved;
  }

  // Paginate projections + edges past Supabase's 1000-row server cap via the
  // shared fetchAllPages helper in @/lib/supabase.
  //
  // Seven parallel reads: projections (paginated), edges (paginated),
  // projections.updated_at, lines.fetched_at, prev-projection,
  // next-projection, next-game. nextDate is the first of next-projection or
  // next-game so the › arrow works on future dates that don't yet have
  // projections (the future-preview slate). updatedAt takes the MAX of
  // projections.updated_at and lines.fetched_at so refresh-only runs (which
  // only touch lines) still bump the "Last updated" timestamp.
  const [
    projData,
    edgeData,
    { data: updatedAtData },
    { data: lineUpdatedData },
    { data: prevData },
    { data: nextProjData },
    { data: nextGameData },
  ] = await Promise.all([
    fetchAllPages<ProjectionRow>(
      (from, to) =>
        supabase
          .from("projections")
          .select(
            "game_id, player_id, prop_type, projection, confidence, players(full_name), games(home_team, away_team, start_time)",
          )
          .eq("projection_date", selectedDate)
          .in("prop_type", ALL_PROP_TYPES)
          .order("projection", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{
            data: ProjectionRow[] | null;
            error: unknown;
          }>,
      "home-projections",
    ),

    fetchAllPages<EdgeRow>(
      (from, to) =>
        supabase
          .from("edges")
          .select(
            "player_id, prop_type, bookmaker, line, fair_over_prob, model_over_prob, edge, over_price, under_price",
          )
          .eq("game_date", selectedDate)
          .range(from, to) as unknown as PromiseLike<{
            data: EdgeRow[] | null;
            error: unknown;
          }>,
      "home-edges",
    ),

    // Most-recently-written projection row for this slate. Refresh-only
    // cron runs (which skip the baseline + XGBoost path) do NOT touch
    // projections.updated_at, so by itself this can lag behind reality.
    supabase
      .from("projections")
      .select("updated_at")
      .eq("projection_date", selectedDate)
      .order("updated_at", { ascending: false })
      .limit(1),

    // Most-recently-fetched line row for this slate. Refresh runs DO bump
    // this, so combining the two via MAX gives a true "last touched" time.
    supabase
      .from("lines")
      .select("fetched_at")
      .eq("game_date", selectedDate)
      .order("fetched_at", { ascending: false })
      .limit(1),

    // Closest available date before selectedDate (for the ‹ arrow). Stays
    // on the projections table — going BACK from a future-preview date
    // should land on the most recent date with real projections.
    supabase
      .from("projections")
      .select("projection_date")
      .lt("projection_date", selectedDate)
      .order("projection_date", { ascending: false })
      .limit(1),

    // Closest available projection date after selectedDate (preferred for ›).
    supabase
      .from("projections")
      .select("projection_date")
      .gt("projection_date", selectedDate)
      .order("projection_date", { ascending: true })
      .limit(1),

    // Closest available game date after selectedDate (› fallback so a user
    // on the last projection date can still page into the future previews).
    supabase
      .from("games")
      .select("game_date")
      .gt("game_date", selectedDate)
      .order("game_date", { ascending: true })
      .limit(1),
  ]);

  const rows = projData;
  console.log(
    `[home-diag] fetched (paginated): projections=${rows.length} edges=${edgeData.length}`,
  );

  // Take the MAX of projections.updated_at and lines.fetched_at so the
  // displayed "Last updated" reflects whichever side was touched most
  // recently. Refresh-only runs bump lines.fetched_at but not
  // projections.updated_at; full runs bump both. Plain ISO-8601 string
  // comparison is correct here since Supabase returns both in UTC ISO.
  const projUpdatedAt =
    (updatedAtData?.[0]?.updated_at as string | undefined) ?? null;
  const lineUpdatedAt =
    (lineUpdatedData?.[0]?.fetched_at as string | undefined) ?? null;
  const updatedAt =
    projUpdatedAt && lineUpdatedAt
      ? projUpdatedAt > lineUpdatedAt
        ? projUpdatedAt
        : lineUpdatedAt
      : (projUpdatedAt ?? lineUpdatedAt);
  const prevDate = prevData?.[0]?.projection_date ?? null;
  const nextDate =
    nextProjData?.[0]?.projection_date ??
    nextGameData?.[0]?.game_date ??
    null;

  // No projections for this date → check if it's a future-preview slate
  // (games + probable starters populated by engine._run_future_previews
  // ahead of the projection run). Render the FutureSlate component if so.
  if (rows.length === 0) {
    const { data: futureGameRows } = await supabase
      .from("games")
      .select(
        "game_id, game_date, home_team, away_team, start_time, " +
          "home_starter:players!games_home_starter_id_fkey(full_name), " +
          "away_starter:players!games_away_starter_id_fkey(full_name)",
      )
      .eq("game_date", selectedDate)
      .order("start_time", { ascending: true });

    return {
      date: selectedDate,
      updatedAt: null,
      prevDate,
      nextDate,
      byProp: Object.fromEntries(
        ALL_PROP_TYPES.map((p) => [p, []]),
      ) as unknown as ByProp,
      futureGames: (futureGameRows as FutureGame[] | null) ?? null,
      featuredSections: [],
      hasCurrentProjections,
    };
  }

  // Index edges by (player_id, prop_type) for an O(1) join.
  const edgeRows = edgeData;
  const edgeByKey = new Map<string, EdgeRow>();
  for (const e of edgeRows) {
    edgeByKey.set(`${e.player_id}|${e.prop_type}`, e);
  }

  // ── Recent-form (L5 spark dots) ─────────────────────────────────────────
  // ONE bulk read of every slate pitcher's recent graded games, newest-first.
  // Paginated via fetchAllPages because the lesson of the 1000-row cap is not
  // one we relearn — ~30 pitchers × up to ~15 games is one page today but the
  // paginator costs nothing to be safe. Pitcher ids are collected from the
  // strikeouts rows (every projected pitcher has a strikeouts projection).
  type RecentGameRow = {
    player_id: number;
    game_date: string;
    [col: string]: number | string | null;
  };
  // Every slate player (pitchers AND hitters) so the trends panel covers hitter
  // props too.
  const allPlayerIds = [...new Set(rows.map((r) => r.player_id))];
  const recentByPlayer = new Map<number, RecentGameRow[]>();
  if (allPlayerIds.length > 0) {
    // Resolve which trend actual_* columns exist (drops a not-yet-migrated one
    // so a pending migration can't 42703 the whole read — same guard /results uses).
    const trendCols = await resolveExistingColumns(
      supabase,
      "player_game_logs",
      [...new Set(Object.values(TREND_ACTUAL_COL))],
    );
    const recentSelect = "player_id, game_date, " + trendCols.join(", ");
    const recentGames = await fetchAllPages<RecentGameRow>(
      (from, to) =>
        supabase
          .from("player_game_logs")
          .select(recentSelect)
          .in("player_id", allPlayerIds)
          .order("game_date", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{
            data: RecentGameRow[] | null;
            error: unknown;
          }>,
      "recent-form",
    );
    // Global desc order preserves per-player desc order, so just bucket in
    // encounter order — each player's array stays newest→oldest.
    for (const g of recentGames) {
      const arr = recentByPlayer.get(g.player_id);
      if (arr) arr.push(g);
      else recentByPlayer.set(g.player_id, [g]);
    }
  }

  // ── hit-rate trends (props.cash-style L5/L10/L15/SZN + Diff + Streak) ─────
  // For one (player, prop) vs tonight's line, from the graded actuals fetched
  // above: each window's over-rate, the recent-avg-minus-line gap, and
  // the current over/under streak. Pure display — undefined when there's no
  // line, no trend column for the prop (fantasy), or no graded history.
  function trendsFor(
    playerId: number,
    propType: PropType,
    line: number | undefined,
  ): Trends | undefined {
    if (line === undefined || line === null) return undefined;
    const col = TREND_ACTUAL_COL[propType];
    if (!col) return undefined;
    const games = recentByPlayer.get(playerId);
    if (!games || games.length === 0) return undefined;

    // Actuals newest→oldest (skip games without a value for this prop).
    const vals: number[] = [];
    for (const g of games) {
      const v = g[col];
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (Number.isFinite(n)) vals.push(n);
    }
    if (vals.length === 0) return undefined;

    const windowStat = (k: number): TrendWindow | undefined => {
      const slice = vals.slice(0, k);
      if (slice.length === 0) return undefined;
      const over = slice.filter((v) => v > line).length;
      return { pct: over / slice.length, over, total: slice.length };
    };

    const l10 = vals.slice(0, 10);
    const diff = l10.length
      ? l10.reduce((a, b) => a + b, 0) / l10.length - line
      : undefined;

    // Streak: consecutive most-recent games all over (+) or all under (−).
    let streak = 0;
    if (vals[0] !== line) {
      const over = vals[0] > line;
      for (const v of vals) {
        if (over ? v > line : v < line) streak += over ? 1 : -1;
        else break;
      }
    }

    return {
      l5: windowStat(5),
      l10: windowStat(10),
      l15: windowStat(15),
      szn: windowStat(vals.length),
      diff,
      streak: streak || undefined,
    };
  }

  // ── opposing-lineup K rate (feature 4) ──────────────────────────────────
  // opp_k_rate lives ONLY on strikeouts projection rows. We fetch it in an
  // ISOLATED query rather than adding the column to the main projections
  // select — because PostgREST 400s when you select a column that doesn't
  // exist, and we must not let the pre-migration window break the whole
  // board. If the column isn't there yet, this query errors, oppKByPlayer
  // stays empty, and the context line simply doesn't render. Keyed by
  // player_id (opp_k_rate is the same for a pitcher across props).
  const oppKByPlayer = new Map<number, number>();
  {
    const { data: oppRows, error: oppErr } = await supabase
      .from("projections")
      .select("player_id, opp_k_rate")
      .eq("projection_date", selectedDate)
      .eq("prop_type", "strikeouts");
    if (oppErr) {
      console.log(
        `[home-diag] opp_k_rate fetch skipped (${String(oppErr)}) — ` +
          `apply db/migrations/add_opp_k_rate.sql to enable the context line`,
      );
    } else {
      for (const r of (oppRows ?? []) as Array<{ player_id: number; opp_k_rate: number | null }>) {
        if (r.opp_k_rate !== null && r.opp_k_rate !== undefined) {
          oppKByPlayer.set(r.player_id, r.opp_k_rate);
        }
      }
    }
  }

  // ── PrizePicks DFS lines (soft-book value, ALL props) ───────────────────
  // PrizePicks is a soft DFS book the model beats far more often than the sharp
  // two-sided books — so its line is the highest-value thing to surface where a
  // prop has no de-vigged sharp edge. edge.py never carries DFS books, so the
  // board reads the PP line directly here and shows it (with the model's lean
  // vs that line — the same proj-vs-line signal /results grades on) wherever a
  // prop lacks a sharp/consensus edge row (the line fallback `e?.line ??
  // ppLineByKey` keeps the de-vigged sharp line whenever one exists). Fetches
  // EVERY PrizePicks prop, not just fantasy/1st-inning, so the board reflects
  // the full soft-book slate instead of a flat projection. ISOLATED +
  // failure-tolerant: on any error the map stays empty and the board just shows
  // fewer lines — never broken. Volume ~500 rows, under the 1000-row cap.
  const ppLineByKey = new Map<string, number>();
  {
    const { data: ppRows, error: ppErr } = await supabase
      .from("lines")
      .select("player_id, prop_type, line")
      .eq("game_date", selectedDate)
      .eq("bookmaker", "prizepicks");
    if (ppErr) {
      console.log(
        `[home-diag] prizepicks DFS lines fetch skipped (${String(ppErr)})`,
      );
    } else {
      for (const r of (ppRows ?? []) as Array<{
        player_id: number;
        prop_type: string;
        line: number | null;
      }>) {
        if (r.line !== null && r.line !== undefined) {
          ppLineByKey.set(`${r.player_id}|${r.prop_type}`, Number(r.line));
        }
      }
    }
  }

  // ── HR-card wind (display-only) ─────────────────────────────────────────
  // Today's game-time wind, persisted to the games table by the engine. Read
  // in an ISOLATED, failure-tolerant query (NOT joined into the main games
  // select, which would 400 the whole board if the columns don't exist yet).
  // On any error (pre-migration) the map stays empty and the HR card falls
  // back to the static park label. ~15 rows, no pagination needed.
  const windByGame = new Map<
    number,
    { windSpeed: number | null; windDirDeg: number | null; isDome: boolean | null }
  >();
  {
    const { data: windRows, error: windErr } = await supabase
      .from("games")
      .select("game_id, wind_speed_mph, wind_dir_deg, is_dome")
      .eq("game_date", selectedDate);
    if (windErr) {
      console.log(
        `[home-diag] game wind fetch skipped (${String(windErr)}) — ` +
          `apply db/migrations/add_game_weather.sql to enable the HR wind tag`,
      );
    } else {
      for (const r of (windRows ?? []) as Array<{
        game_id: number;
        wind_speed_mph: number | null;
        wind_dir_deg: number | null;
        is_dome: boolean | null;
      }>) {
        windByGame.set(r.game_id, {
          windSpeed: r.wind_speed_mph,
          windDirDeg: r.wind_dir_deg,
          isDome: r.is_dome,
        });
      }
    }
  }

  // Game-level NRFI/YRFI read. The first_inning_runs projection (P(YRFI), 0-1)
  // is keyed on the home-starter carrier, so we map it to the GAME by game_id
  // and render it as a game-header tag. ISOLATED + failure-tolerant (new
  // prop_type); on any error the tag simply doesn't render. ~15 rows.
  const nrfiByGame = new Map<number, number>();
  {
    const { data: nrfiRows, error: nrfiErr } = await supabase
      .from("projections")
      .select("game_id, projection")
      .eq("projection_date", selectedDate)
      .eq("prop_type", "first_inning_runs");
    if (nrfiErr) {
      console.log(`[home-diag] NRFI (first_inning_runs) fetch skipped (${String(nrfiErr)})`);
    } else {
      for (const r of (nrfiRows ?? []) as Array<{ game_id: number; projection: number }>) {
        nrfiByGame.set(r.game_id, r.projection);
      }
    }
  }

  // ── HR-card sweet-spot (display-only) ───────────────────────────────────
  // Rolling 7-day Statcast batted-ball quality, set ONLY on hitter_home_runs
  // projection rows by the engine. ISOLATED + failure-tolerant for the same
  // pre-migration reason as opp_k_rate above. One prop on one date is well
  // under the 1000-row cap. Empty map → the HR card keeps "N games tracked".
  const sweetByPlayer = new Map<
    number,
    { sweetSpotPct: number | null; avgExitVelo: number | null }
  >();
  {
    const { data: sweetRows, error: sweetErr } = await supabase
      .from("projections")
      .select("player_id, sweet_spot_pct, avg_exit_velo")
      .eq("projection_date", selectedDate)
      .eq("prop_type", "hitter_home_runs");
    if (sweetErr) {
      console.log(
        `[home-diag] sweet-spot fetch skipped (${String(sweetErr)}) — ` +
          `apply db/migrations/add_sweet_spot.sql to enable the HR footer`,
      );
    } else {
      for (const r of (sweetRows ?? []) as Array<{
        player_id: number;
        sweet_spot_pct: number | null;
        avg_exit_velo: number | null;
      }>) {
        if (r.sweet_spot_pct !== null && r.sweet_spot_pct !== undefined) {
          sweetByPlayer.set(r.player_id, {
            sweetSpotPct: r.sweet_spot_pct,
            avgExitVelo: r.avg_exit_velo,
          });
        }
      }
    }
  }

  // ── HR-composite opp-SP HR/9 (ranking-only) ─────────────────────────────
  // Opposing starter's HR/9 (last 5 starts), set ONLY on hitter_home_runs rows
  // by the engine. ISOLATED + failure-tolerant (a SEPARATE query from sweet-spot
  // so a missing column pre-migration can't blank the footer too). Empty map →
  // the composite degrades that term to neutral.
  const oppHr9ByPlayer = new Map<number, number>();
  {
    const { data: hr9Rows, error: hr9Err } = await supabase
      .from("projections")
      .select("player_id, opp_sp_hr9")
      .eq("projection_date", selectedDate)
      .eq("prop_type", "hitter_home_runs");
    if (hr9Err) {
      console.log(
        `[home-diag] opp-SP HR/9 fetch skipped (${String(hr9Err)}) — ` +
          `apply db/migrations/add_opp_sp_hr9.sql to enable the composite term`,
      );
    } else {
      for (const r of (hr9Rows ?? []) as Array<{
        player_id: number;
        opp_sp_hr9: number | null;
      }>) {
        if (r.opp_sp_hr9 !== null && r.opp_sp_hr9 !== undefined) {
          oppHr9ByPlayer.set(r.player_id, r.opp_sp_hr9);
        }
      }
    }
  }

  // ── sharp-money agreement (feature 5) ───────────────────────────────────
  // The frontend's main reads only fetch the EDGES baseline line (one book
  // per prop) — not per-book lines. So we add ONE isolated, paginated query
  // for REAL_BOOKS lines on the slate date. fetchAllPages is failure-tolerant
  // (logs + returns partial on any error), so a transient failure can't blank
  // the board — the badge just won't render. The lines table + these columns
  // already exist, so no migration risk here.
  type SharpLineRow = {
    player_id: number;
    prop_type: string;
    bookmaker: string;
    line: number;
  };
  const sharpLines = await fetchAllPages<SharpLineRow>(
    (from, to) =>
      supabase
        .from("lines")
        .select("player_id, prop_type, bookmaker, line")
        .eq("game_date", selectedDate)
        .in("bookmaker", REAL_BOOKS as string[])
        .range(from, to) as unknown as PromiseLike<{
          data: SharpLineRow[] | null;
          error: unknown;
        }>,
    "sharp-lines",
  );

  // Index: `${player_id}|${prop_type}` -> Map<bookmaker, line>. The lines
  // table has a unique (player_id, prop_type, bookmaker, game_date) key so
  // there's exactly one line per real book per prop — no alt-line double
  // count. We still keep-first defensively.
  const sharpByKey = new Map<string, Map<string, number>>();
  for (const r of sharpLines) {
    if (r.line === null || r.line === undefined) continue;
    const key = `${r.player_id}|${r.prop_type}`;
    let books = sharpByKey.get(key);
    if (!books) {
      books = new Map<string, number>();
      sharpByKey.set(key, books);
    }
    if (!books.has(r.bookmaker)) books.set(r.bookmaker, Number(r.line));
  }

  // Count how many real books corroborate the EDGE's lean for one (player,
  // prop). The badge's DIRECTION comes from the de-vigged edge — the exact
  // same value + EDGE_THRESHOLD the EdgeDetail arrow uses — NOT from raw
  // proj-vs-line. This makes the badge agree with the edge arrow by
  // construction (they can't point opposite ways) and never fire on ~Even
  // rows. Steps:
  //   1. No projection / no edge / ~Even edge (|edge| <= EDGE_THRESHOLD) →
  //      no badge. The edge is authoritative for direction.
  //   2. Gate real books to main-market lines (>= SHARP_MIN_LINE; covers
  //      every pitcher prop the badge renders on, walks/earned_runs included.
  //      MIN_LINE untouched so /results + Featured Plays are unchanged).
  //   3. corroborate = books with the projection on the edge's side
  //      (edge over → proj > book line; edge under → proj < book line).
  //   4. total = qualifying real books. Return only when corroborate >= 2;
  //      the UI tiers full (>=3 && ===total) vs partial (>=2).
  function computeSharp(
    playerId: number,
    propType: PropType,
    projection: number | undefined,
    edge: number | undefined | null,
  ): import("@/lib/types").SharpAgreement | undefined {
    if (projection === undefined || projection === null) return undefined;
    if (edge === undefined || edge === null) return undefined;

    // Direction + ~Even gate from the edge (authoritative).
    let direction: "over" | "under";
    if (edge > EDGE_THRESHOLD) direction = "over";
    else if (edge < -EDGE_THRESHOLD) direction = "under";
    else return undefined;   // ~Even → no badge

    const allBooks = sharpByKey.get(`${playerId}|${propType}`);
    if (!allBooks) return undefined;

    // Drop alt lines below the prop's main-market floor (if it has one).
    const floor = SHARP_MIN_LINE[propType];
    const books = new Map<string, number>();
    for (const [book, line] of allBooks) {
      if (floor !== undefined && line < floor) continue;
      books.set(book, line);
    }
    if (books.size < 2) return undefined;   // need 2+ qualifying real books

    // Corroborating books: projection sits on the edge's side of the line.
    const corroborating: string[] = [];
    for (const [book, line] of books) {
      const onSide = direction === "over" ? projection > line : projection < line;
      if (onSide) corroborating.push(book);
    }
    if (corroborating.length < 2) return undefined;

    return {
      agree: corroborating.length,
      total: books.size,
      direction,
      books: corroborating,
    };
  }

  // Group by prop_type → game_id → players. Pure presentation — no math.
  // After grouping we sort each prop's games chronologically by start_time so
  // the slate order matches MLB's schedule page and stays identical across
  // every tab. Games with no start_time (TBD slots) sort to the end.
  const startTimeFor = (g: GameGroup): number =>
    g.startTime ? new Date(g.startTime).getTime() : Number.POSITIVE_INFINITY;

  const byProp = Object.fromEntries(
    ALL_PROP_TYPES.map((propType) => {
      const byGame = new Map<number, GameGroup>();
      for (const r of rows) {
        if (r.prop_type !== propType) continue;
        if (!byGame.has(r.game_id)) {
          const w = windByGame.get(r.game_id);
          byGame.set(r.game_id, {
            game_id: r.game_id,
            matchup: r.games
              ? `${r.games.away_team} @ ${r.games.home_team}`
              : `Game ${r.game_id}`,
            startTime: r.games?.start_time ?? null,
            // Today's wind (display-only) for the game-header + total-bases tags.
            windSpeed: w?.windSpeed ?? null,
            windDirDeg: w?.windDirDeg ?? null,
            isDome: w?.isDome ?? null,
            // Game-level NRFI/YRFI read (P(YRFI)) for the game-header tag.
            firstInningRuns: nrfiByGame.get(r.game_id),
            pitchers: [],
          });
        }

        const e = edgeByKey.get(`${r.player_id}|${r.prop_type}`);
        byGame.get(r.game_id)!.pitchers.push({
          player_id: r.player_id,
          name: r.players?.full_name ?? "Unknown player",
          projection: r.projection,
          // NULL until enough graded starts accumulate; undefined = render nothing.
          confidence: r.confidence ?? undefined,
          // Optional edge fields — undefined when this player has no line.
          // Fantasy props carry no edge row (PrizePicks-only), so fall back to
          // the directly-fetched PP line so the fantasy tabs still show "Line X".
          line: e?.line ?? ppLineByKey.get(`${r.player_id}|${r.prop_type}`),
          edge: e?.edge ?? undefined,
          fairOverProb: e?.fair_over_prob ?? undefined,
          modelOverProb: e?.model_over_prob ?? undefined,
          overPrice: e?.over_price ?? undefined,
          underPrice: e?.under_price ?? undefined,
          bookmaker: e?.bookmaker,
          // Hit-rate trends (L5/L10/L15/SZN + Diff + Streak) vs the line, for the
          // focused-card panel. Covers pitcher + hitter props; undefined for
          // fantasy / no line / no history.
          trends: trendsFor(r.player_id, propType, e?.line),
          // Tonight's opposing-lineup context. Attached to every prop's row
          // but only rendered on the Strikeouts tab. undefined when opp_k_rate
          // isn't available (pre-migration or no model run for this pitcher).
          oppContext: oppKByPlayer.has(r.player_id)
            ? { kRate: oppKByPlayer.get(r.player_id)!, lhh: null, rhh: null }
            : undefined,
          // Multi-book sharp agreement for THIS prop (feature 5). Direction
          // comes from the (signed) edge — same value EdgeDetail uses — so
          // the badge agrees with the arrow and never fires on ~Even rows.
          sharpAgreement: computeSharp(r.player_id, propType, r.projection, e?.edge),
        });
      }
      const sorted = [...byGame.values()].sort(
        (a, b) => startTimeFor(a) - startTimeFor(b)
      );
      return [propType, sorted];
    })
  ) as unknown as ByProp;

  // ── Featured Plays ────────────────────────────────────────────────────────
  // Build from the already-fetched edgeData + a (player_id, prop_type) index
  // over the projection rows so we have player names + matchup strings
  // without another DB round-trip.
  //
  // edge.edge in the DB is the model's over-probability minus the de-vigged
  // fair over-probability — positive means the model is more bullish on the
  // over than the book is. A featured under-lean is mathematically the same
  // signal flipped: |edge| past the threshold, with the projection sitting
  // below the line. We absolute-value the displayed edge so the card always
  // reads as a positive "edge against the line" regardless of direction.
  const projIndex = new Map<string, ProjectionRow>();
  for (const r of rows) {
    projIndex.set(`${r.player_id}|${r.prop_type}`, r);
  }

  // Per-game starters + teams — ISOLATED, failure-tolerant read of already-stored
  // data. Used to (1) name the OPPONENT a pitcher faces (so the AI insight
  // attributes the opposing lineup's K-rate to the right team, not the pitcher's
  // own), and (2) find each hitter's opposing SP for the HR composite platoon
  // term. On error the map stays empty and both degrade gracefully.
  const gameInfoById = new Map<
    number,
    { homeTeam: string; awayTeam: string; homeStarter: number | null; awayStarter: number | null }
  >();
  {
    const { data, error } = await supabase
      .from("games")
      .select("game_id, home_team, away_team, home_starter_id, away_starter_id")
      .eq("game_date", selectedDate);
    if (error) {
      console.log(`[home-diag] game-starters fetch skipped (${String(error)})`);
    } else {
      for (const r of (data ?? []) as Array<{
        game_id: number;
        home_team: string;
        away_team: string;
        home_starter_id: number | null;
        away_starter_id: number | null;
      }>) {
        gameInfoById.set(r.game_id, {
          homeTeam: r.home_team,
          awayTeam: r.away_team,
          homeStarter: r.home_starter_id,
          awayStarter: r.away_starter_id,
        });
      }
    }
  }

  // Build one EDGE section (pitching or hitting) from edgeData for the given
  // prop set. Same qualification as the original Featured Plays, just scoped
  // to the section's props, sorted by abs(edge) desc and capped at 3.
  const buildEdgePlays = (propSet: ReadonlySet<PropType>): FeaturedPlay[] =>
    edgeData
      .map((e): FeaturedPlay | null => {
        if (!FEATURED_BOOKS.has(e.bookmaker)) return null;
        const propType = e.prop_type as PropType;
        if (!propSet.has(propType)) return null;
        const edge = e.edge;
        if (edge === null || edge === undefined) return null;
        const absEdge = Math.abs(edge);
        if (absEdge < FEATURED_MIN_EDGE) return null;
        // Ceiling: a de-vigged edge above ~0.40 is not a real market
        // mispricing — it's a broken thin-sample projection (e.g. a 2.0
        // hits-allowed proj vs a 5.5 line reads a fake -0.55). The market is
        // rarely off by 40%+ after vig; skip these instead of headlining them.
        if (absEdge > FEATURED_MAX_EDGE) return null;
        // Featured-Plays-specific floor (NOT the shared MIN_LINE). MIN_LINE has
        // no hitter_hits/hitter_total_bases entry, so using it dropped every
        // hitter play here; FEATURED_MIN_LINE adds the hitter main-market floors
        // while keeping the pitcher floors identical (PITCHING EDGES unchanged).
        const lineMin = FEATURED_MIN_LINE[propType];
        if (lineMin === undefined || e.line < lineMin) return null;

        const proj = projIndex.get(`${e.player_id}|${e.prop_type}`);
        if (!proj) return null;
        // A play with no resolvable player name is a data-issue row (e.g. an
        // unnamed pitcher batting) — never feature it.
        const playerName = proj.players?.full_name;
        if (!playerName) return null;
        // A 0.0 (or negative) projection is a no-data sentinel, not a forecast —
        // it fakes a huge under-edge vs any line (e.g. a 0.0 walks / earned-runs
        // proj for a pitcher with no recent data). Never feature it.
        if (proj.projection <= 0) return null;
        if (Math.abs(proj.projection - e.line) < FEATURED_MIN_LEAN) return null;
        // Sanity ceiling: drop implausible (thin/spiky baseline) projections so
        // a fake 4.0-TB edge can't headline the section.
        const cap = FEATURED_PROJ_CAP[propType];
        if (cap !== undefined && proj.projection > cap) return null;
        // Projection floor — drops broken thin-sample LOW projections (e.g. a
        // 7.0 first-inning-pitches proj) that fake a huge under-edge.
        const projFloor = FEATURED_PROJ_FLOOR[propType];
        if (projFloor !== undefined && proj.projection < projFloor) return null;

        // Lean = the EDGE's direction (the de-vigged signal), not raw
        // proj-vs-line. They usually agree, but when they don't — the model
        // projects above the line yet is LESS bullish than the market (a
        // negative edge) — showing "OVER" next to an under-edge is a
        // contradiction. Require agreement and take the edge's side, so the
        // card's bet direction always matches its edge.
        const projLean: "over" | "under" = proj.projection > e.line ? "over" : "under";
        const lean: "over" | "under" = edge > 0 ? "over" : "under";
        if (projLean !== lean) return null;

        // Recent-form backing (props.cash-style): how often the player landed on
        // THIS lean's side over the last ≤10 graded games vs THIS line. From the
        // season-backfilled trends; the count is framed to the lean direction.
        const l10 = trendsFor(e.player_id, propType, e.line)?.l10;
        const hitRate = l10
          ? { hit: lean === "over" ? l10.over : l10.total - l10.over, total: l10.total }
          : undefined;
        const matchup = proj.games
          ? `${proj.games.away_team} @ ${proj.games.home_team}`
          : `Game ${proj.game_id}`;
        const parkFactor = proj.games
          ? PARK_FACTORS_HITS[proj.games.home_team] ?? 1.0
          : undefined;

        // Opponent the pitcher faces — the featured player IS the game's starter,
        // so the opponent is the OTHER team. Used to attribute the opposing
        // lineup's K-rate to the correct team in the AI insight (the bug: the LLM
        // was naming the pitcher's OWN team). undefined when the starter id isn't
        // resolved → the insight falls back to "the opposing lineup".
        const gi = gameInfoById.get(proj.game_id);
        const oppTeam = gi
          ? e.player_id === gi.homeStarter
            ? gi.awayTeam
            : e.player_id === gi.awayStarter
              ? gi.homeTeam
              : undefined
          : undefined;

        return {
          playerId: e.player_id,
          playerName,
          propType,
          projection: proj.projection,
          line: e.line,
          edge: absEdge,
          bookmaker: e.bookmaker,
          lean,
          gameId: proj.game_id,
          matchup,
          gradedStarts: 0, // enriched below in ONE query across all sections
          sharpAgreement: computeSharp(e.player_id, propType, proj.projection, e.edge),
          // De-vig transparency — surfaced on the card as "model X% vs market Y%".
          modelOverProb: e.model_over_prob ?? undefined,
          fairOverProb: e.fair_over_prob ?? undefined,
          hitRate,
          parkFactor,
          // opp K rate lives only on strikeouts rows (pitching context).
          oppKRate: oppKByPlayer.get(e.player_id),
          // The team this pitcher faces — names the K-rate's owner in the insight.
          oppTeam,
        };
      })
      .filter((p): p is FeaturedPlay => p !== null)
      // Rank by edge, weighted by book trust (sharp > consensus > DFS) so a more
      // reliable edge sorts ahead. Gate already used the RAW |edge|; this only
      // orders them.
      .sort((a, b) => BOOK_RANK_WEIGHT(b.bookmaker) * (b.edge ?? 0) - BOOK_RANK_WEIGHT(a.bookmaker) * (a.edge ?? 0));
  // NOTE: no longer sliced here — callers slice to top-3 AFTER any min-sample
  // gate so a thin-history outlier can't consume a top-3 slot.

  const pitchingPlays = pickDiverse(buildEdgePlays(FEATURED_PITCHER_PROPS), 3, FEATURED_MAX_PER_PROP);

  // HITTING EDGES: gate out thin-history hitters BEFORE the top-3 cut. A hitter
  // with ~0 graded games gets a baseline projection that just echoes one recent
  // game (e.g. Gleyber Torres 4.0 TB off a single big game), which inflates the
  // edge (+0.54) and headlines the section ahead of established hitters with sane
  // 2.1–2.7 projections. Require >= HITTER_MIN_GAMES_TRACKED graded games
  // (counted via actual_total_bases — non-null on every graded hitter row, so it
  // proxies hits AND total bases). Mirrors the HR min-sample guard, incl. the
  // graceful-degrade-on-error (a broken query must never empty the section).
  const hittingCandidates = buildEdgePlays(FEATURED_HITTER_PROPS);
  const hitterGradedByPlayer = new Map<number, number>();
  let hitterGateAvailable = false;
  {
    const hitIds = [...new Set(hittingCandidates.map((p) => p.playerId))];
    if (hitIds.length > 0) {
      let ok = true;
      for (let page = 0; page < 50; page++) {
        const { data, error } = await supabase
          .from("player_game_logs")
          .select("player_id, actual_total_bases")
          .in("player_id", hitIds)
          .range(page * 1000, page * 1000 + 999);
        if (error) {
          console.log(
            `[home-diag] hitter min-sample gate disabled — graded-count fetch failed (${String(error)})`,
          );
          ok = false;
          break;
        }
        const batch = (data ?? []) as Array<{ player_id: number; actual_total_bases: number | null }>;
        for (const r of batch) {
          if (r.actual_total_bases !== null && r.actual_total_bases !== undefined) {
            hitterGradedByPlayer.set(r.player_id, (hitterGradedByPlayer.get(r.player_id) ?? 0) + 1);
          }
        }
        if (batch.length < 1000) break;
      }
      hitterGateAvailable = ok;
    }
  }
  const hittingPlays = pickDiverse(
    hitterGateAvailable
      ? hittingCandidates.filter(
          (p) => (hitterGradedByPlayer.get(p.playerId) ?? 0) >= HITTER_MIN_GAMES_TRACKED,
        )
      : hittingCandidates,
    3,
    FEATURED_MAX_PER_PROP,
  );

  // ── Section 3: HR MATCHUPS (matchup-ranked, not edge-based) ──────────────
  // Rank tonight's projected hitters by park-adjusted HR projection:
  //   score = hitter_home_runs_projection × park_factor_hits(home_team)
  // No book line / edge required — this section is pure context. home_team is
  // parsed from the matchup string ("Away @ Home"), same as the park tag.
  // ── platoon inputs for the HR composite (SELECTION only, not display) ─────
  // gameInfoById (built above) gives per-game starters; handById is an ISOLATED,
  // failure-tolerant read of per-player bats/throws/team. On error the map stays
  // empty and the composite's platoon term degrades to neutral — the ranking
  // still uses power + wind + park. Pre-existing schema (no migration gating).
  const handById = new Map<number, { bats: string | null; throws: string | null; team: string | null }>();
  {
    const hitterIds = (byProp["hitter_home_runs"] ?? []).flatMap((g) =>
      g.pitchers.map((h) => h.player_id),
    );
    const starterIds = [...gameInfoById.values()].flatMap((g) => [g.homeStarter, g.awayStarter]);
    const ids = [...new Set([...hitterIds, ...starterIds].filter((x): x is number => x != null))];
    if (ids.length > 0) {
      const { data, error } = await supabase
        .from("players")
        .select("player_id, bats, throws, team")
        .in("player_id", ids);
      if (error) {
        console.log(`[home-diag] HR composite: player-hand fetch skipped (${String(error)})`);
      } else {
        for (const r of (data ?? []) as Array<{
          player_id: number;
          bats: string | null;
          throws: string | null;
          team: string | null;
        }>) {
          handById.set(r.player_id, { bats: r.bats, throws: r.throws, team: r.team });
        }
      }
    }
  }

  const hrPlays: FeaturedPlay[] = [];
  for (const g of byProp["hitter_home_runs"] ?? []) {
    const homeTeam = g.matchup.includes(" @ ") ? g.matchup.split(" @ ")[1] : "";
    const parkFactor = PARK_FACTORS_HITS[homeTeam] ?? 1.0;
    const wind = windByGame.get(g.game_id);
    const gi = gameInfoById.get(g.game_id);
    for (const h of g.pitchers) {
      if (h.projection <= 0.05) continue; // drop no-hopers
      const sweet = sweetByPlayer.get(h.player_id);

      // Opposing SP throwing hand: the hitter faces the OTHER side's starter.
      // Side is resolved from the hitter's team vs the game's home/away team;
      // unknown side or missing starter → oppThrows null → platoon neutral.
      const hitter = handById.get(h.player_id);
      let oppThrows: string | null = null;
      if (gi && hitter?.team) {
        const side =
          hitter.team === gi.homeTeam ? "home" : hitter.team === gi.awayTeam ? "away" : null;
        if (side) {
          const oppStarter = side === "home" ? gi.awayStarter : gi.homeStarter;
          oppThrows = oppStarter != null ? handById.get(oppStarter)?.throws ?? null : null;
        }
      }

      // Composite RANKING score (selection only). Displayed projection unchanged.
      const comp = hrComposite({
        projection: h.projection,
        homeTeam,
        windSpeed: wind?.windSpeed ?? null,
        windDirDeg: wind?.windDirDeg ?? null,
        isDome: wind?.isDome ?? null,
        sweetSpotPct: sweet?.sweetSpotPct ?? null,
        avgExitVelo: sweet?.avgExitVelo ?? null,
        hitterBats: hitter?.bats ?? null,
        oppPitcherThrows: oppThrows,
        oppSpHr9: oppHr9ByPlayer.get(h.player_id) ?? null,
      });

      hrPlays.push({
        playerId: h.player_id,
        playerName: h.name,
        propType: "hitter_home_runs",
        projection: h.projection, // UNCHANGED display value
        gameId: g.game_id,
        matchup: g.matchup,
        gradedStarts: 0,
        parkFactor,
        hrScore: comp.score, // composite drives selection/sort only
        // Wind tag context (display-only). homeTeam → PARK_ORIENTATION lookup.
        homeTeam,
        windSpeed: wind?.windSpeed ?? null,
        windDirDeg: wind?.windDirDeg ?? null,
        isDome: wind?.isDome ?? null,
        // Sweet-spot footer context (display-only).
        sweetSpotPct: sweet?.sweetSpotPct ?? null,
        avgExitVelo: sweet?.avgExitVelo ?? null,
      });
    }
  }
  // ── min-sample guard: exclude thin-history hitters from the curated top-3 ──
  // The composite MULTIPLIES the HR projection, and a hitter with ~1 recent game
  // gets baseline-projected to ~1.0 HR — dominating the score and crowding out
  // established hitters. Gate on graded games (the SAME signal as the card's
  // "N GAMES TRACKED" footer: player_game_logs rows with a non-null
  // actual_home_runs). Below HR_MIN_GAMES_TRACKED a hitter still appears on the
  // normal HR prop tab — just not in the curated top-3. Manually paginated (so a
  // deep graded history never gets 1000-cap-truncated → under-counted → wrongly
  // excluded). On query FAILURE the gate disables (degrades to the prior
  // composite-only top-3) — a broken query must never empty the section.
  const hrGradedByPlayer = new Map<number, number>();
  let hrGateAvailable = false;
  {
    const hrIds = [...new Set(hrPlays.map((p) => p.playerId))];
    if (hrIds.length > 0) {
      let ok = true;
      for (let page = 0; page < 50; page++) {
        const { data, error } = await supabase
          .from("player_game_logs")
          .select("player_id, actual_home_runs")
          .in("player_id", hrIds)
          .range(page * 1000, page * 1000 + 999);
        if (error) {
          console.log(
            `[home-diag] HR min-sample gate disabled — graded-count fetch failed (${String(error)})`,
          );
          ok = false;
          break;
        }
        const batch = (data ?? []) as Array<{ player_id: number; actual_home_runs: number | null }>;
        for (const r of batch) {
          if (r.actual_home_runs !== null && r.actual_home_runs !== undefined) {
            hrGradedByPlayer.set(r.player_id, (hrGradedByPlayer.get(r.player_id) ?? 0) + 1);
          }
        }
        if (batch.length < 1000) break;
      }
      hrGateAvailable = ok;
    }
  }
  const hrMatchups = (
    hrGateAvailable
      ? hrPlays.filter((p) => (hrGradedByPlayer.get(p.playerId) ?? 0) >= HR_MIN_GAMES_TRACKED)
      : hrPlays
  )
    // Same plausibility ceiling as the edge sections: a thin/spiky baseline can
    // echo one big game into a ~1.0 HR projection that dominates the composite.
    .filter((p) => p.projection <= (FEATURED_PROJ_CAP.hitter_home_runs ?? Infinity))
    .sort((a, b) => (b.hrScore ?? 0) - (a.hrScore ?? 0))
    .slice(0, 3);

  // ── graded-start counts across all three sections ───────────────────────
  // player_game_logs has NO prop_type column — actuals live as columns on one
  // row per (player_id, game_id). A "graded game" for a prop is a row where
  // that prop's actual column is non-null. Map each featured prop (pitcher AND
  // hitter) to its actual column, fetch them for the (≤9) featured players in
  // ONE query, and count non-null per player+prop. Volume is tiny.
  const FEATURED_ACTUAL_COL: Partial<Record<PropType, string>> = {
    strikeouts:         "actual_strikeouts",
    hits_allowed:       "actual_hits_allowed",
    outs_recorded:      "actual_outs_recorded",
    walks:              "actual_walks",
    earned_runs:        "actual_earned_runs",
    pitcher_fantasy_score: "actual_pitcher_fantasy_score",
    pitcher_first_inning_pitches:    "actual_first_inning_pitches",
    pitcher_first_inning_strikeouts: "actual_first_inning_strikeouts",
    hitter_hits:        "actual_hits",
    hitter_total_bases: "actual_total_bases",
    hitter_hits_runs_rbis: "actual_hits_runs_rbis",
    hitter_home_runs:   "actual_home_runs",
    hitter_fantasy_score:  "actual_hitter_fantasy_score",
  };
  const allFeaturedPlays = [...pitchingPlays, ...hittingPlays, ...hrMatchups];
  const featuredPlayerIds = [...new Set(allFeaturedPlays.map((p) => p.playerId))];
  if (featuredPlayerIds.length > 0) {
    // Drop any not-yet-migrated actual_* column so a pending migration can't
    // 42703 the whole graded-counts read (which would zero every featured
    // play's history). Mirrors /results.
    const actualCols = await resolveExistingColumns(
      supabase,
      "player_game_logs",
      [...new Set(Object.values(FEATURED_ACTUAL_COL))],
    );
    const cols = ["player_id", ...actualCols].join(", ");
    const { data: gradeRows } = await supabase
      .from("player_game_logs")
      .select(cols)
      .in("player_id", featuredPlayerIds);

    const gradedCounts: Record<string, number> = {};
    for (const row of (gradeRows ?? []) as unknown as Array<Record<string, unknown>>) {
      const pid = row.player_id;
      for (const [prop, col] of Object.entries(FEATURED_ACTUAL_COL)) {
        if (row[col] !== null && row[col] !== undefined) {
          const key = `${pid}|${prop}`;
          gradedCounts[key] = (gradedCounts[key] ?? 0) + 1;
        }
      }
    }
    for (const p of allFeaturedPlays) {
      p.gradedStarts = gradedCounts[`${p.playerId}|${p.propType}`] ?? 0;
    }
  }

  const featuredSections: FeaturedSection[] = [
    { label: "PITCHING EDGES", plays: pitchingPlays },
    { label: "HITTING EDGES",  plays: hittingPlays },
    { label: "HR MATCHUPS",    plays: hrMatchups },
  ];

  return {
    date: selectedDate,
    updatedAt,
    prevDate,
    nextDate,
    byProp,
    futureGames: null,
    featuredSections,
    hasCurrentProjections,
  };
}

// (formatDate moved into web/app/StaleBanner.tsx — its only consumer was the
// stale banner, now client-rendered in the viewer's local timezone.)

// (formatUpdatedAt removed — the "Last updated" line is now client-rendered in
// the viewer's local timezone by web/app/LiveUpdated.tsx, so a non-ET viewer
// sees a time that matches their wall clock + the relative counter.)

// The whole slate computation (projections + edges + the ~17k-row season trend
// scan + sharp lines) is cached for 3 minutes, SHARED across all visitors and
// keyed by date. The cron only writes a few times a day, so 3-min staleness is
// invisible, but it turns every repeat visit + every AutoRefresh from a full
// 20-query fan-out into a cache hit. Live in-game stats are a separate real-time
// client poll, unaffected.
const getSlateCached = unstable_cache(getSlate, ["slate-data-v2"], {
  revalidate: 180,
});

export default async function Home({
  searchParams,
}: {
  searchParams?: { date?: string };
}) {
  const rawDate = searchParams?.date;
  const dateOverride =
    rawDate && DATE_RE.test(rawDate) ? rawDate : undefined;

  const {
    date,
    updatedAt,
    prevDate,
    nextDate,
    byProp,
    futureGames,
    featuredSections,
    hasCurrentProjections,
  } = await getSlateCached(dateOverride);

  // Stale banner now lives in the client <StaleBanner>, which judges "stale"
  // from the VIEWER'S local date (not Eastern) — so a late-evening West-Coast /
  // Arizona user isn't told their current slate is yesterday's. The slate data
  // itself stays ET-keyed (MLB schedules are ET). hasCurrentProjections still
  // suppresses the banner when newer data exists.

  // hasAny: at least one prop type has at least one game. If every prop list
  // is empty we're on a future-preview date even though we have a `date`.
  const hasAny =
    date !== null &&
    Object.values(byProp).some((games) => games.length > 0);

  return (
    <main className="mx-auto max-w-7xl px-4 py-10">
      {/* Soft-refreshes the server component on an interval (tab-aware) so a
          new cron run appears without a manual reload. Renders nothing. */}
      <AutoRefresh />
      <header className="mb-8">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3">
            {/* logo mark — ascending bars = edges trending up */}
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-glow">
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5 text-slate-950"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="3" y="13" width="4" height="8" rx="1.2" />
                <rect x="10" y="8" width="4" height="13" rx="1.2" />
                <rect x="17" y="3" width="4" height="18" rx="1.2" />
              </svg>
            </span>
            <div className="leading-tight">
              <h1 className="font-display text-2xl font-bold tracking-tight text-slate-50">
                MLB<span className="text-emerald-400">Props</span>
              </h1>
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Calibrated projections · honest edges
              </p>
            </div>
          </Link>
          <nav className="text-sm font-medium">
            <Link
              href="/results"
              className="rounded-lg px-3 py-1.5 text-slate-300 transition-colors hover:bg-slate-800/70 hover:text-slate-100"
            >
              Results
            </Link>
          </nav>
        </div>
        {/* "Last updated" — client-rendered in the viewer's local timezone. */}
        {updatedAt && (
          <div className="mt-3">
            <LiveUpdated iso={updatedAt} />
          </div>
        )}
      </header>

      <StaleBanner
        date={date}
        hasData={updatedAt !== null}
        hasCurrentProjections={hasCurrentProjections}
      />

      {hasAny ? (
        <PropBoard
          date={date!}
          prevDate={prevDate}
          nextDate={nextDate}
          byProp={byProp}
          featuredSections={featuredSections}
        />
      ) : date && futureGames !== null ? (
        <FutureSlate
          date={date}
          prevDate={prevDate}
          nextDate={nextDate}
          games={futureGames}
        />
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
          Nothing to show. Once the engine runs, today&apos;s projections appear
          here.
        </div>
      )}

      <footer className="mt-10 text-center text-xs text-slate-600">
        Projections are statistical estimates, not guarantees.
      </footer>
    </main>
  );
}
