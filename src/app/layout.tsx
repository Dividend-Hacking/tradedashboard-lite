/**
 * Root Layout
 *
 * Forces dark mode via the `dark` class on <html> and sets
 * the page title to "Trade Dashboard". Loads Geist fonts
 * for clean monospace/sans-serif rendering.
 *
 * Reads the active mode (Cloud/Local) from ~/.tradedashboard/config.json
 * and wraps the tree in a ModeProvider so client components can pick it
 * up via useMode(). The current mode is also surfaced as a small badge
 * in the nav bar so the user can see at a glance which backend is in
 * use without going to Settings.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import AlertBanner from "@/components/alerts/alert-banner";
import { ModeProvider } from "@/components/mode-provider";
import { readMode } from "@/lib/mode";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trade Dashboard",
  description: "MNQ futures trade performance dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { mode } = await readMode();

  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ModeProvider mode={mode}>
          {/* Navigation bar */}
          <nav className="border-b border-[#1e1e2a] bg-[#111118]">
            <div className="px-4 md:px-8 flex items-center h-[52px] gap-6">
              <span className="text-sm font-bold text-[#e4e4e7]">Trade Dashboard</span>
              <div className="flex items-center gap-1">
                <Link
                  href="/"
                  className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
                >
                  Dashboard
                </Link>
                <Link
                  href="/replay"
                  className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
                >
                  Practice
                </Link>
                <Link
                  href="/trade"
                  className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
                >
                  Live
                </Link>
                <Link
                  href="/auto"
                  className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
                >
                  Auto
                </Link>
                <Link
                  href="/pipeline"
                  className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
                >
                  Pipeline
                </Link>
              </div>
              {/* Mode badge + Settings link, pushed to the right. The badge is
                  purely informational: in local mode it's tinted so the user
                  can spot at a glance that they're not pointing at production
                  Supabase. */}
              <div className="ml-auto flex items-center gap-3">
                <Link
                  href="/settings"
                  className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
                >
                  Settings
                </Link>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${
                    mode === "local"
                      ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                      : "bg-[#1e1e2a] text-[#71717a] border border-[#27272a]"
                  }`}
                  title={mode === "local" ? "Trading data is local SQLite" : "Trading data is Supabase"}
                >
                  {mode === "local" ? "Local" : "Cloud"}
                </span>
              </div>
            </div>
          </nav>
          {children}
          {/* Global price-cross alert banner. Mounted here so it shows
              regardless of which page the user is on. Driven by the
              module-level event bus in hooks/use-alert-notifications. */}
          <AlertBanner />
        </ModeProvider>
      </body>
    </html>
  );
}
