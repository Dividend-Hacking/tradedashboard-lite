/**
 * Root Layout
 *
 * Forces dark mode via the `dark` class on <html> and sets
 * the page title to "Trade Dashboard". Loads Geist fonts
 * for clean monospace/sans-serif rendering.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import AlertBanner from "@/components/alerts/alert-banner";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
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
                href="/assistant"
                className="px-3 py-1.5 rounded text-sm text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
              >
                Assistant
              </Link>
            </div>
          </div>
        </nav>
        {children}
        {/* Global price-cross alert banner. Mounted here so it shows
            regardless of which page the user is on. Driven by the
            module-level event bus in hooks/use-alert-notifications. */}
        <AlertBanner />
      </body>
    </html>
  );
}
