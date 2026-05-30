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
