"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * One nav definition drives both surfaces: the desktop sidebar and the compact
 * header nav that replaces it below `lg`. There is deliberately a SINGLE entry
 * point to each destination -- an earlier version also carried a gradient
 * "Administrator guide" pill in the header, which meant two competing buttons
 * for the same page.
 */
const NAV = [
  {
    href: "/",
    label: "Map & Search",
    shortLabel: "Map",
    match: (p: string) => p === "/" || p.startsWith("/school"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" stroke="currentColor" className="w-[18px] h-[18px]">
        <path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: "/admin-guide",
    label: "Administrator Guide",
    shortLabel: "Guide",
    match: (p: string) => p.startsWith("/admin-guide"),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" stroke="currentColor" className="w-[18px] h-[18px]">
        <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25a8.988 8.988 0 0 0-3-.512c-2.305 0-4.408.867-6 2.292m0-14.25v14.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const PAGE_LABELS: [(p: string) => boolean, string][] = [
  [(p) => p === "/", "Overview"],
  [(p) => p.startsWith("/school/"), "School detail"],
  [(p) => p.startsWith("/admin-guide"), "Administrator Guide"],
];

function currentLabel(pathname: string) {
  return PAGE_LABELS.find(([match]) => match(pathname))?.[1] ?? "Overview";
}

function BrandMark() {
  return (
    <span className="grid place-items-center w-9 h-9 rounded-xl gradient-accent shrink-0">
      <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" stroke="white" className="w-5 h-5">
        <path d="M12 3 3 8l9 5 9-5-9-5Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 8v8l9 5 9-5V8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar (>= lg) */}
      <aside className="hidden lg:flex lg:w-64 lg:shrink-0 lg:flex-col lg:sticky lg:top-0 lg:h-screen border-r border-white/10 px-4 py-6">
        <Link href="/" className="flex items-center gap-2.5 px-2 mb-8">
          <BrandMark />
          <span className="leading-tight">
            <span className="block text-sm font-semibold text-white">ClassFit NYC</span>
            <span className="block text-[11px] text-white/40">Mandate compliance explorer</span>
          </span>
        </Link>

        <nav aria-label="Main" className="flex flex-col gap-1">
          <div className="px-3 mb-1 text-[11px] font-medium uppercase tracking-wider text-white/35">
            Main menu
          </div>
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  active
                    ? "bg-white/10 text-white"
                    : "text-white/55 hover:text-white hover:bg-white/5"
                }`}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-violet-400"
                  />
                )}
                <span className={active ? "text-violet-300" : "text-white/40"}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto pt-6">
          <div className="panel px-4 py-4">
            <p className="text-xs font-medium text-white/80">Data vintage</p>
            <p className="mt-1 text-[11px] leading-relaxed text-white/45">
              Class size figures come from the most recent NYC Open Data reports — historical
              baselines, not live compliance status.
            </p>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-[1000] border-b border-white/10 bg-[#0d0817]/70 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4 px-4 sm:px-6 h-14">
            {/* Below lg the sidebar is gone, so the header carries the brand;
                at lg and up it carries the breadcrumb instead. */}
            <Link href="/" className="lg:hidden flex items-center gap-2.5 min-w-0">
              <BrandMark />
              <span className="text-sm font-semibold text-white truncate">ClassFit NYC</span>
            </Link>

            <nav aria-label="Breadcrumb" className="hidden lg:flex items-center gap-1.5 text-[13px] min-w-0">
              <Link href="/" className="text-white/40 hover:text-white/70 transition-colors">
                ClassFit NYC
              </Link>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth="2"
                stroke="currentColor"
                aria-hidden
                className="w-3.5 h-3.5 text-white/25 shrink-0"
              >
                <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span aria-current="page" className="font-medium text-white/80 truncate">
                {currentLabel(pathname)}
              </span>
            </nav>

            {/* Compact nav standing in for the sidebar below lg. */}
            <nav aria-label="Main" className="lg:hidden flex items-center gap-1 shrink-0">
              {NAV.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      active ? "bg-white/10 text-white" : "text-white/55 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {item.shortLabel}
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>
        <main className="flex-1 flex flex-col min-w-0">{children}</main>
      </div>
    </div>
  );
}
