import Link from "next/link";
import { fetchChapters, fetchJuzMap, juzLabel, pageLabel } from "@/lib/quran";
import { TranslationPicker } from "@/components/TranslationPicker";

export default async function Home() {
  const [chapters, juzMap] = await Promise.all([fetchChapters(), fetchJuzMap()]);

  return (
    <div>
      <section className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight mb-2">
          Practice. Listen. Recite.
        </h1>
        <p className="text-stone-600 dark:text-stone-400 max-w-2xl">
          Pick any surah, listen to a reciter, and recite into your mic to get
          word-level feedback. Phase 1 is Hafs only — multi-Qira&apos;at and
          tajweed checks come later.
        </p>
      </section>

      <TranslationPicker />

      <section>
        <h2 className="text-sm uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-3">
          Surahs
        </h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-stretch">
          {chapters.map((c) => (
            <li key={c.id} className="flex">
              <Link
                href={`/surah/${c.id}`}
                className="flex flex-col w-full rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors overflow-hidden"
              >
                <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-stone-100 dark:bg-stone-800 text-xs font-medium tabular-nums">
                      {c.id}
                    </span>
                    <span className="font-semibold text-base leading-tight truncate min-w-0">
                      {c.name_simple}
                    </span>
                  </div>
                  <span
                    className="arabic shrink-0"
                    style={{ fontSize: "1.4rem", lineHeight: "1" }}
                  >
                    {c.name_arabic}
                  </span>
                </div>
                <div className="px-3 pb-1">
                  <p className="text-xs text-stone-500 dark:text-stone-400 truncate">
                    {c.translated_name.name} · {c.verses_count} verses
                  </p>
                </div>
                <div className="mt-auto flex flex-wrap border-t border-stone-200 dark:border-stone-800">
                  <span className="flex-1 basis-[120px] inline-flex items-center justify-center gap-1 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200 text-xs font-bold px-2 py-1.5 tabular-nums whitespace-nowrap">
                    📖 {pageLabel(c.pages)}
                  </span>
                  {juzMap.get(c.id) && (
                    <span className="flex-1 basis-[90px] inline-flex items-center justify-center gap-1 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-200 text-xs font-bold px-2 py-1.5 tabular-nums whitespace-nowrap">
                      📚 {juzLabel(juzMap.get(c.id)!)}
                    </span>
                  )}
                  <span
                    className={`flex-1 basis-[70px] inline-flex items-center justify-center text-xs font-bold px-2 py-1.5 capitalize whitespace-nowrap ${
                      c.revelation_place === "makkah"
                        ? "bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200"
                        : "bg-sky-100 dark:bg-sky-900/40 text-sky-900 dark:text-sky-200"
                    }`}
                  >
                    {c.revelation_place === "makkah" ? "🕋 Makki" : "🕌 Madani"}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
