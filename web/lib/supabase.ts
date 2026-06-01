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
