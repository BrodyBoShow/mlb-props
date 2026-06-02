import Link from "next/link";
import { fetchAllPages, getSupabaseClient } from "@/lib/supabase";
import { ALL_PROP_TYPES, EDGE_THRESHOLD, FEATURED_MIN_LINE, HR_MIN_GAMES_TRACKED, PARK_FACTORS_HITS, REAL_BOOKS, SHARP_MIN_LINE } from "@/lib/constants";
import { hrComposite } from "@/lib/hrComposite";
import type { ByProp, FeaturedPlay, FeaturedSection, FormDot, GameGroup, PropType } from "@/lib/types";
import PropBoard from "./PropBoard";
import FutureSlate, { type FutureGame } from "./FutureSlate";
import LiveUpdated from "./LiveUpdated";
import AutoRefresh from "./AutoRefresh";

// ── Featured-play filter constants ───────────────────────────────────────────
// Tight filters — featuring a marginal play on the top of the home page is
// worse than featuring nothing. See the per-filter comments at the build
// site below for the reasoning on each threshold.

// Real two-sided sportsbooks only. DFS apps (PrizePicks, Underdog, Sleeper,
// Betr) don't post symmetric over/under markets, so the de-vig math behind
// the `edge` field doesn't apply to them and any "edge" we'd surface would
// be against an artificial baseline. The featured section requires a real
// book to anchor the claim.
const FEATURED_BOOKS: ReadonlySet<string> = new Set([
  "pinnacle", "draftkings", "fanduel", "bet365", "caesars",
]);

// Section 1 (PITCHING EDGES) props. Clean pitcher props only — we exclude
// walks/earned_runs (thin two-sided coverage, fragile de-vig) and the
// PrizePicks-only fantasy score (no two-sided baseline).
const FEATURED_PITCHER_PROPS: ReadonlySet<PropType> = new Set([
  "strikeouts", "hits_allowed", "outs_recorded",
]);

// Section 2 (HITTING EDGES) props. Hitter props can carry a systemic under-lean
// bias (the Model Tracker surfaces this); the AI insight is written to be honest
// about the signal rather than filtering these out — the user wants them shown.
const FEATURED_HITTER_PROPS: ReadonlySet<PropType> = new Set([
  "hitter_hits", "hitter_total_bases",
]);

// Edge threshold is set ABOVE the regular display threshold (0.10) so we
// don't promote borderline calls. 0.12 = a clear vote for one side after
// vig is removed.
const FEATURED_MIN_EDGE = 0.12;

// |projection - line| floor. The model can be technically "leaning over"
// while sitting 0.05 away from the line — that's not a meaningful call,
// it's noise. 0.3 keeps featured plays to ones where the projection is
// visibly off the line.
const FEATURED_MIN_LEAN = 0.3;

// Featured plays + the sharp badge both use the shared MIN_LINE map (the same
// thresholds /results uses) so alt lines never inflate a featured edge or a
// sharp count. Imported from @/lib/constants — single source of truth.

// ── Recent-form spark dots ───────────────────────────────────────────────────
// Maps each pitcher prop that gets an L5 spark row to its actual column in
// player_game_logs. Verified live (2026-06): all five are 60/60 non-null on
// graded pitcher rows, so all five get spark rows. Hitter / fantasy props are
// absent here, so sparkFor returns undefined for them (no spark on those tabs).
// player_game_logs has NO prop_type column and the per-game `projection`
// column was dropped earlier — so the dots compare each graded ACTUAL against
// tonight's book LINE (the market's expectation), not a historical projection.
const SPARK_ACTUAL_COL: Partial<Record<PropType, string>> = {
  strikeouts:    "actual_strikeouts",
  hits_allowed:  "actual_hits_allowed",
  outs_recorded: "actual_outs_recorded",
  walks:         "actual_walks",
  earned_runs:   "actual_earned_runs",
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
  const pitcherIds = [
    ...new Set(rows.filter((r) => r.prop_type === "strikeouts").map((r) => r.player_id)),
  ];
  const recentByPlayer = new Map<number, RecentGameRow[]>();
  if (pitcherIds.length > 0) {
    const recentGames = await fetchAllPages<RecentGameRow>(
      (from, to) =>
        supabase
          .from("player_game_logs")
          .select(
            "player_id, game_date, actual_strikeouts, actual_hits_allowed, " +
              "actual_outs_recorded, actual_walks, actual_earned_runs",
          )
          .in("player_id", pitcherIds)
          .eq("player_type", "pitcher")
          .order("game_date", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{
            data: RecentGameRow[] | null;
            error: unknown;
          }>,
      "recent-pitcher-form",
    );
    // Global desc order preserves per-player desc order, so just bucket in
    // encounter order — each player's array stays newest→oldest.
    for (const g of recentGames) {
      const arr = recentByPlayer.get(g.player_id);
      if (arr) arr.push(g);
      else recentByPlayer.set(g.player_id, [g]);
    }
  }

  // Compute the L5 dots for one (pitcher, prop): each of the last ≤5 graded
  // actuals vs tonight's line, oldest→newest. undefined when there's no
  // current line (nothing to compare against), no actual column for the prop
  // (hitter/fantasy), or no graded history.
  function sparkFor(
    playerId: number,
    propType: PropType,
    line: number | undefined,
  ): FormDot[] | undefined {
    if (line === undefined || line === null) return undefined;
    const col = SPARK_ACTUAL_COL[propType];
    if (!col) return undefined;
    const games = recentByPlayer.get(playerId);
    if (!games || games.length === 0) return undefined;

    const dots: FormDot[] = [];   // newest→oldest while collecting
    for (const g of games) {
      const v = g[col];
      if (v === null || v === undefined) continue;
      const actual = Number(v);
      if (!Number.isFinite(actual)) continue;
      dots.push(actual > line ? "over" : actual < line ? "under" : "push");
      if (dots.length >= 5) break;
    }
    if (dots.length === 0) return undefined;
    return dots.reverse();   // oldest→newest for left-to-right display
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

  // ── PrizePicks fantasy-score lines (line-only display) ──────────────────
  // The two fantasy_score props are PrizePicks-only (PRIZEPICKS_ONLY_PROPS
  // enforced at ingest) and the edges table never carries them — edge.py
  // excludes DFS books from seeding a de-vig baseline, so a PP-only prop never
  // produces an edge row. The other prop tabs read their line off the edges
  // join; the fantasy tabs have no edge, so we fetch the PP line directly here
  // and surface it (with the model's lean vs that line) the same way every
  // other tab shows "Line X · lean". ISOLATED + failure-tolerant: on any error
  // the map stays empty and the fantasy tabs just don't show a line — never a
  // broken board. Volume is tiny (~125 rows for a full slate), well under the
  // 1000-row cap, so no pagination needed.
  const ppLineByKey = new Map<string, number>();
  {
    const { data: ppRows, error: ppErr } = await supabase
      .from("lines")
      .select("player_id, prop_type, line")
      .eq("game_date", selectedDate)
      .eq("bookmaker", "prizepicks")
      .in("prop_type", ["pitcher_fantasy_score", "hitter_fantasy_score"]);
    if (ppErr) {
      console.log(
        `[home-diag] prizepicks fantasy lines fetch skipped (${String(ppErr)})`,
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
          byGame.set(r.game_id, {
            game_id: r.game_id,
            matchup: r.games
              ? `${r.games.away_team} @ ${r.games.home_team}`
              : `Game ${r.game_id}`,
            startTime: r.games?.start_time ?? null,
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
          // L5 recent-form dots for THIS prop vs this prop's current line.
          // undefined on hitter/fantasy tabs and when there's no line/history.
          recentForm: sparkFor(r.player_id, propType, e?.line),
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
        // Featured-Plays-specific floor (NOT the shared MIN_LINE). MIN_LINE has
        // no hitter_hits/hitter_total_bases entry, so using it dropped every
        // hitter play here; FEATURED_MIN_LINE adds the hitter main-market floors
        // while keeping the pitcher floors identical (PITCHING EDGES unchanged).
        const lineMin = FEATURED_MIN_LINE[propType];
        if (lineMin === undefined || e.line < lineMin) return null;

        const proj = projIndex.get(`${e.player_id}|${e.prop_type}`);
        if (!proj) return null;
        if (Math.abs(proj.projection - e.line) < FEATURED_MIN_LEAN) return null;

        const lean: "over" | "under" =
          proj.projection > e.line ? "over" : "under";
        const matchup = proj.games
          ? `${proj.games.away_team} @ ${proj.games.home_team}`
          : `Game ${proj.game_id}`;
        const parkFactor = proj.games
          ? PARK_FACTORS_HITS[proj.games.home_team] ?? 1.0
          : undefined;

        return {
          playerId: e.player_id,
          playerName: proj.players?.full_name ?? "Unknown player",
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
          parkFactor,
          // opp K rate lives only on strikeouts rows (pitching context).
          oppKRate: oppKByPlayer.get(e.player_id),
        };
      })
      .filter((p): p is FeaturedPlay => p !== null)
      .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
      .slice(0, 3);

  const pitchingPlays = buildEdgePlays(FEATURED_PITCHER_PROPS);
  const hittingPlays = buildEdgePlays(FEATURED_HITTER_PROPS);

  // ── Section 3: HR MATCHUPS (matchup-ranked, not edge-based) ──────────────
  // Rank tonight's projected hitters by park-adjusted HR projection:
  //   score = hitter_home_runs_projection × park_factor_hits(home_team)
  // No book line / edge required — this section is pure context. home_team is
  // parsed from the matchup string ("Away @ Home"), same as the park tag.
  // ── platoon inputs for the HR composite (SELECTION only, not display) ─────
  // Two ISOLATED, failure-tolerant reads of already-stored data (no new external
  // fetch): per-game starters (to find each hitter's opposing SP) and per-player
  // bats/throws/team. On any error the maps stay empty and the composite's
  // platoon term degrades to neutral — the ranking still uses power + wind +
  // park. The columns are pre-existing schema (no migration gating).
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
      console.log(`[home-diag] HR composite: game-starters fetch skipped (${String(error)})`);
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
    hitter_hits:        "actual_hits",
    hitter_total_bases: "actual_total_bases",
    hitter_home_runs:   "actual_home_runs",
  };
  const allFeaturedPlays = [...pitchingPlays, ...hittingPlays, ...hrMatchups];
  const featuredPlayerIds = [...new Set(allFeaturedPlays.map((p) => p.playerId))];
  if (featuredPlayerIds.length > 0) {
    const cols = [
      "player_id",
      ...new Set(Object.values(FEATURED_ACTUAL_COL)),
    ].join(", ");
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

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// (formatUpdatedAt removed — the "Last updated" line is now client-rendered in
// the viewer's local timezone by web/app/LiveUpdated.tsx, so a non-ET viewer
// sees a time that matches their wall clock + the relative counter.)

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
  } = await getSlate(dateOverride);

  // Stale banner: ONLY when the displayed date is before today AND today
  // (or later) has no projections in the DB. When the user is browsing a
  // past date but current data exists, suppress the banner — that's
  // intentional navigation, not a freshness problem.
  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const isStale =
    date !== null &&
    updatedAt !== null &&
    date < todayET &&
    !hasCurrentProjections;

  // hasAny: at least one prop type has at least one game. If every prop list
  // is empty we're on a future-preview date even though we have a `date`.
  const hasAny =
    date !== null &&
    Object.values(byProp).some((games) => games.length > 0);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {/* Soft-refreshes the server component on an interval (tab-aware) so a
          new cron run appears without a manual reload. Renders nothing. */}
      <AutoRefresh />
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MLB Props</h1>
          <p className="mt-1 text-sm text-slate-400">
            Pitchers &amp; hitters
          </p>
          {/* Full "Last updated" line — client-rendered in the viewer's
              local timezone (not hardcoded ET) so it matches their wall
              clock and the relative counter. Honest: same real updatedAt
              instant, just localized + a count-up counter. */}
          {updatedAt && <LiveUpdated iso={updatedAt} />}
        </div>
        <Link
          href="/results"
          className="mt-1 text-sm text-slate-400 transition-colors hover:text-slate-200"
        >
          Results →
        </Link>
      </header>

      {isStale && (
        <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          Showing {formatDate(date!)} projections — today&apos;s slate updates after 8 AM ET.
        </div>
      )}

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
