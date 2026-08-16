"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_TRANSLATION_ID,
  fetchAvailableTranslations,
  type TranslationOption,
} from "@/lib/quran";

const STORAGE_KEY = "hifz-ai.translation-id";

export function getStoredTranslationId(): number {
  if (typeof window === "undefined") return DEFAULT_TRANSLATION_ID;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_TRANSLATION_ID;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : DEFAULT_TRANSLATION_ID;
}

export function TranslationPicker() {
  const [options, setOptions] = useState<TranslationOption[]>([]);
  const [selectedId, setSelectedId] = useState<number>(DEFAULT_TRANSLATION_ID);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(getStoredTranslationId());
    fetchAvailableTranslations()
      .then((opts) => {
        setOptions(opts);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Couldn't load translation list"
        );
        setLoading(false);
      });
  }, []);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = Number(e.target.value);
    setSelectedId(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(id));
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, TranslationOption[]>();
    for (const opt of options) {
      const arr = map.get(opt.language) ?? [];
      arr.push(opt);
      map.set(opt.language, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Languages: English first, then alphabetical
    return [...map.entries()].sort(([a], [b]) => {
      if (a === "English") return -1;
      if (b === "English") return 1;
      return a.localeCompare(b);
    });
  }, [options]);

  const current = options.find((o) => o.id === selectedId);

  return (
    <section className="mb-6 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-3">
      <label
        htmlFor="translation-picker"
        className="block text-xs uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5"
      >
        Translation
      </label>
      <select
        id="translation-picker"
        value={selectedId}
        onChange={onChange}
        disabled={loading || !!error}
        className="w-full rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 text-sm disabled:opacity-50"
      >
        {/* Always keep the selected id as an option even before the list
            loads, so the select shows the persisted choice immediately. */}
        {options.length === 0 && (
          <option value={selectedId}>
            {loading ? "Loading…" : `Translation #${selectedId}`}
          </option>
        )}
        {grouped.map(([lang, opts]) => (
          <optgroup key={lang} label={lang}>
            {opts.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
                {opt.authorName && opt.authorName !== opt.name
                  ? ` — ${opt.authorName}`
                  : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
        {error
          ? `Couldn't load translation list (${error}).`
          : current
            ? `Applied to every surah · ${current.language}`
            : "Applied to every surah you open."}
      </p>
    </section>
  );
}
