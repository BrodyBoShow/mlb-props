import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Custom type system (set via next/font in layout.tsx). Having a real
        // typeface — not the default system stack — is the single biggest signal
        // that a site was designed rather than generated.
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "sans-serif"],
      },
      boxShadow: {
        // Soft elevation tuned for dark surfaces (depth via shadow + a faint
        // top highlight, the "lit from above in a dark room" look).
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
        glow: "0 0 0 1px rgba(16,185,129,0.15), 0 8px 30px -8px rgba(16,185,129,0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
