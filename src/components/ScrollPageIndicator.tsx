"use client";

import { useEffect, useRef, useState } from "react";
import type { Verse } from "@/lib/quran";

export function ScrollPageIndicator({ verses }: { verses: Verse[] }) {
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [bumpKey, setBumpKey] = useState(0);
  const lastPageRef = useRef<number | null>(null);
  const visibleRef = useRef(new Map<string, number>());
  const ayahPageRef = useRef(
    new Map(verses.map((v) => [v.verse_key, v.page_number]))
  );

  useEffect(() => {
    ayahPageRef.current = new Map(
      verses.map((v) => [v.verse_key, v.page_number])
    );
  }, [verses]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.verseKey;
          if (!key) continue;
          if (e.isIntersecting) {
            visibleRef.current.set(key, e.intersectionRatio);
          } else {
            visibleRef.current.delete(key);
          }
        }
        let bestKey: string | null = null;
        let bestRatio = -1;
        for (const [k, r] of visibleRef.current) {
          if (r > bestRatio) {
            bestRatio = r;
            bestKey = k;
          }
        }
        const page = bestKey
          ? (ayahPageRef.current.get(bestKey) ?? null)
          : null;
        if (page !== null && page !== lastPageRef.current) {
          lastPageRef.current = page;
          setCurrentPage(page);
          setBumpKey((n) => n + 1);
        } else if (page === null && lastPageRef.current !== null) {
          lastPageRef.current = null;
          setCurrentPage(null);
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    const nodes = document.querySelectorAll<HTMLElement>("[data-verse-key]");
    nodes.forEach((n) => observer.observe(n));

    return () => observer.disconnect();
  }, [verses.length]);

  if (currentPage === null) return null;
  const minPage = verses[0]?.page_number ?? currentPage;
  const maxPage = verses[verses.length - 1]?.page_number ?? currentPage;
  const total = Math.max(1, maxPage - minPage + 1);
  const progress = (currentPage - minPage) / total;

  return (
    <aside
      aria-hidden
      className="fixed right-2 sm:right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-2 pointer-events-none"
    >
      <div className="hidden sm:block relative h-40 w-1 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
        <div
          className="absolute left-0 right-0 top-0 bg-emerald-500 dark:bg-emerald-600 transition-[height] duration-150"
          style={{ height: `${Math.min(100, Math.max(0, progress * 100))}%` }}
        />
      </div>
      <div
        key={bumpKey}
        className="rounded-full bg-emerald-600 text-white text-sm font-bold px-3 py-1.5 shadow-lg tabular-nums animate-[bump_400ms_ease-out] ring-2 ring-white dark:ring-stone-900"
      >
        📖 Page {currentPage}
      </div>
    </aside>
  );
}
