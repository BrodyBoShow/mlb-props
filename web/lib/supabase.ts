import { createClient } from "@supabase/supabase-js";

// Read-only client for the frontend. Uses the public anon key, which can only
// SELECT rows that an RLS policy allows (see db/policies.sql). All writes happen
// off-site in the scheduled engine job — never here.
//
// Created lazily so `next build` doesn't require env vars to be present.
export function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Copy web/.env.local.example to web/.env.local and fill them in.",
    );
  }

  // Pass a custom fetch that forces `cache: 'no-store'` so Next.js never
  // caches Supabase responses — the page must always reflect the latest slate.
  return createClient(url, anonKey, {
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}

// Page size for the paginator below. Supabase / PostgREST caps every response
// at 1000 rows server-side; .limit() does NOT override this. The Range header
// (exposed via .range(from, to)) is the only mechanism PostgREST honors for
// reading past the cap.
const PAGE = 1000;

// Generic paginator over any supabase-js select chain. The caller passes a
// `build` function that receives (from, to) and applies them via .range(),
// returning the standard { data, error } shape. We loop in 1000-row chunks
// until the server returns a short page (less than PAGE rows).
//
// Previously inlined in both web/app/page.tsx and web/app/results/page.tsx;
// hoisted here so a future page can paginate Supabase reads with one import.
// PostgREST 400s the ENTIRE select when ANY named column doesn't exist (code
// 42703) — it does NOT silently skip the unknown column. So naming a column
// whose migration hasn't been applied yet wipes the whole read and can blank a
// page. This probes `table` and returns the subset of `desired` columns that
// actually exist, dropping any not-yet-migrated column (mirrors the engine's
// PGRST204 strip-and-retry). A pending migration then degrades to "that one
// column is absent" instead of taking the page down. `probeOnly` columns are
// included in the probe (they're known to exist, e.g. player_id) but never
// returned. On any non-missing-column error the full `desired` set is returned
// so the real query behaves exactly as it would have without the probe.
export async function resolveExistingColumns(
  supabase: ReturnType<typeof getSupabaseClient>,
  table: string,
  desired: string[],
  probeOnly: string[] = ["player_id"],
): Promise<string[]> {
  let cols = [...desired];
  for (let attempt = 0; attempt <= desired.length; attempt++) {
    if (cols.length === 0) break;
    const { error } = await supabase
      .from(table)
      .select([...probeOnly, ...cols].join(", "))
      .limit(1);
    if (!error) return cols;
    const msg = (error as { message?: string })?.message ?? String(error);
    const missing = msg.match(/(\w+) does not exist/)?.[1];
    if (!missing || !cols.includes(missing)) {
      console.log(`[supabase] resolveExistingColumns(${table}): unhandled error, using full set — ${msg}`);
      break;
    }
    console.log(`[supabase] ${table}.${missing} not migrated yet — excluded from read`);
    cols = cols.filter((c) => c !== missing);
  }
  return cols;
}

export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  label = "paginate",
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < 50; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await build(from, to);
    if (error) {
      console.log(`[supabase] paginate ${label} page=${page} error=${String(error)}`);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}
