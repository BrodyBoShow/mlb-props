import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MLB Props",
  description: "Today's MLB pitcher and hitter prop projections.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
