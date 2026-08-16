import Link from "next/link";
import { notFound } from "next/navigation";
import {
  fetchChapter,
  fetchJuzMap,
  fetchTranslation,
  fetchVerses,
  juzLabel,
  pageLabel,
  type Chapter,
} from "@/lib/quran";
import { SurahView } from "@/components/SurahView";

export default async function SurahPage(props: PageProps<"/surah/[id]">) {
  const { id } = await props.params;
  const surahId = Number(id);
  if (!Number.isInteger(surahId) || surahId < 1 || surahId > 114) {
    notFound();
  }

  const [chapter, verses, prev, next, juzMap, translations] =
    await Promise.all([
      fetchChapter(surahId),
      fetchVerses(surahId),
      surahId > 1 ? fetchChapter(surahId - 1) : Promise.resolve(null),
      surahId < 114 ? fetchChapter(surahId + 1) : Promise.resolve(null),
      fetchJuzMap(),
      fetchTranslation(surahId).catch(() => [] as string[]),
    ]);
  const juz = juzMap.get(surahId);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <Link
          href="/"
          className="text-sm text-stone-500 dark:text-stone-400 hover:underline"
        >
          ← All surahs
        </Link>
        <div className="flex items-center gap-2">
          {prev && <SurahNavLink chapter={prev} direction="prev" compact />}
          {next && <SurahNavLink chapter={next} direction="next" compact />}
        </div>
      </div>

      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-stone-500 dark:text-stone-400">
            Surah {chapter.id}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {chapter.name_simple}{" "}
            <span className="text-stone-400 font-normal">
              · {chapter.translated_name.name}
            </span>
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="inline-flex items-center rounded-md bg-emerald-100 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200 text-xs font-semibold px-2 py-0.5 tabular-nums">
              📖 {pageLabel(chapter.pages)}
            </span>
            {juz && (
              <span className="inline-flex items-center rounded-md bg-indigo-100 dark:bg-indigo-950/60 text-indigo-900 dark:text-indigo-200 text-xs font-semibold px-2 py-0.5 tabular-nums">
                📚 {juzLabel(juz)}
              </span>
            )}
            <span
              className={`inline-flex items-center rounded-md text-xs font-semibold px-2 py-0.5 capitalize ${
                chapter.revelation_place === "makkah"
                  ? "bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200"
                  : "bg-sky-100 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200"
              }`}
            >
              {chapter.revelation_place === "makkah" ? "🕋 Makki" : "🕌 Madani"}
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              {chapter.verses_count} verses
            </span>
          </div>
        </div>
        <span className="arabic" style={{ fontSize: "2rem", lineHeight: "1" }}>
          {chapter.name_arabic}
        </span>
      </header>

      <SurahView
        surahId={surahId}
        verses={verses}
        translations={translations}
      />

      <nav className="mt-8 grid grid-cols-2 gap-3">
        {prev ? (
          <SurahNavLink chapter={prev} direction="prev" />
        ) : (
          <span />
        )}
        {next ? (
          <SurahNavLink chapter={next} direction="next" />
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}

function SurahNavLink({
  chapter,
  direction,
  compact = false,
}: {
  chapter: Chapter;
  direction: "prev" | "next";
  compact?: boolean;
}) {
  const isNext = direction === "next";
  if (compact) {
    return (
      <Link
        href={`/surah/${chapter.id}`}
        className="inline-flex items-center gap-1 text-xs rounded-md border border-stone-200 dark:border-stone-800 px-2 py-1 hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors max-w-[140px] sm:max-w-none"
        title={`${isNext ? "Next" : "Previous"} surah: ${chapter.name_simple}`}
      >
        {!isNext && <span className="text-stone-400">←</span>}
        <span className="truncate">
          {chapter.id}. {chapter.name_simple}
        </span>
        {isNext && <span className="text-stone-400">→</span>}
      </Link>
    );
  }
  return (
    <Link
      href={`/surah/${chapter.id}`}
      className={`flex flex-col gap-0.5 rounded-lg border border-stone-200 dark:border-stone-800 hover:border-emerald-400 dark:hover:border-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors p-3 ${
        isNext ? "items-end text-right" : "items-start text-left"
      }`}
    >
      <span className="text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {isNext ? "Next surah →" : "← Previous surah"}
      </span>
      <span className="flex items-center gap-2">
        <span className="font-semibold truncate">
          {chapter.id}. {chapter.name_simple}
        </span>
      </span>
      <span className="text-xs text-stone-500 dark:text-stone-400 truncate">
        {chapter.translated_name.name} · {chapter.verses_count} verses
      </span>
    </Link>
  );
}
