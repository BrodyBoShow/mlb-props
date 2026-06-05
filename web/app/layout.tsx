import "./globals.css";
import type { Metadata } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";

// Custom type system — Manrope (friendly, geometric body) + Space Grotesk
// (distinctive analytical display). Replaces the default system stack, which is
// the #1 "AI-generated" tell.
const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "MLB Props — Calibrated MLB prop projections & edges",
  description:
    "Calibrated, transparently-graded MLB pitcher & hitter prop projections and betting edges — measured against the closing line.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body className="min-h-screen font-sans text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
