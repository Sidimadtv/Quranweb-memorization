"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_RECITER_ID, RECITERS, getReciter } from "@/lib/reciters";
import type { Verse } from "@/lib/quran";
import {
  startContinuousRecite,
  type ContinuousHandle,
} from "@/lib/continuousRecite";
import { loadWhisper, type LoadStatus, type WordTiming } from "@/lib/whisper";
import { getSheikhSurahPCM } from "@/lib/timingAnalysis";
import {
  DEFAULT_TRANSLATION_ID,
  fetchTranslation,
} from "@/lib/quran";
import { getStoredTranslationId } from "./TranslationPicker";
import { AyahRow, type ContinuousOverride } from "./AyahRow";
import { PageDivider } from "./PageDivider";
import { ScrollPageIndicator } from "./ScrollPageIndicator";
import {
  PlayerProvider,
  useActiveVerseKey,
  useIsPlaying,
  usePlayer,
} from "./PlayerProvider";

export type ReciteRegistry = {
  register: (verseNumber: number, startRecite: () => void) => () => void;
  advanceFrom: (verseNumber: number) => void;
};

const STORAGE_KEY = "hifz-ai.reciter";

type ContinuousPhase = "off" | "preloading" | "calibrating" | "listening";

type MicMeter = {
  rms: number;
  threshold: number;
  isSilent: boolean;
};

type RecitedAyah = {
  transcript: string;
  audioBlob: Blob;
  words: WordTiming[];
};

type ContinuousState = {
  phase: ContinuousPhase;
  modelProgress: number;
  activeVerse: number | null;
  transcribing: Set<number>;
  results: Map<number, RecitedAyah>;
  errors: Map<number, string>;
  errorMessage: string | null;
  meter: MicMeter | null;
};

const EMPTY_CONTINUOUS: ContinuousState = {
  phase: "off",
  modelProgress: 0,
  activeVerse: null,
  transcribing: new Set(),
  results: new Map(),
  errors: new Map(),
  errorMessage: null,
  meter: null,
};

export function SurahView({
  surahId,
  verses,
  translations: initialTranslations,
}: {
  surahId: number;
  verses: Verse[];
  translations: string[];
}) {
  const [translations, setTranslations] = useState<string[]>(initialTranslations);

  useEffect(() => {
    const storedId = getStoredTranslationId();
    if (storedId === DEFAULT_TRANSLATION_ID) return;
    let cancelled = false;
    fetchTranslation(surahId, storedId)
      .then((arr) => {
        if (!cancelled && arr.length > 0) setTranslations(arr);
      })
      .catch(() => {
        // Stick with the default translation on fetch failure.
      });
    return () => {
      cancelled = true;
    };
  }, [surahId]);
  const [reciterId, setReciterId] = useState<number>(DEFAULT_RECITER_ID);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? Number(saved) : NaN;
    if (Number.isFinite(parsed) && RECITERS.some((r) => r.id === parsed)) {
      setReciterId(parsed);
    }
  }, []);

  function chooseReciter(id: number) {
    setReciterId(id);
    window.localStorage.setItem(STORAGE_KEY, String(id));
  }

  const reciter = getReciter(reciterId);
  const reciteRegistryRef = useRef(new Map<number, () => void>());
  const lastVerseNumber = verses[verses.length - 1]?.verse_number ?? 0;

  const registry: ReciteRegistry = {
    register: useCallback((verseNumber: number, startRecite: () => void) => {
      reciteRegistryRef.current.set(verseNumber, startRecite);
      return () => {
        reciteRegistryRef.current.delete(verseNumber);
      };
    }, []),
    advanceFrom: useCallback(
      (verseNumber: number) => {
        const next = verseNumber + 1;
        const start = reciteRegistryRef.current.get(next);
        if (!start) return;
        const verseKey = `${surahId}:${next}`;
        const el = document.getElementById(`ayah-${verseKey}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(start, 350);
      },
      [surahId]
    ),
  };

  const [continuous, setContinuous] =
    useState<ContinuousState>(EMPTY_CONTINUOUS);
  const sessionRef = useRef<ContinuousHandle | null>(null);
  const surahAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (continuous.activeVerse !== null && continuous.phase === "listening") {
      const verseKey = `${surahId}:${continuous.activeVerse}`;
      const el = document.getElementById(`ayah-${verseKey}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [continuous.activeVerse, continuous.phase, surahId]);

  async function startContinuous(fromVerseNumber?: number) {
    if (continuous.phase !== "off") return;
    const startIndex = fromVerseNumber
      ? verses.findIndex((v) => v.verse_number === fromVerseNumber)
      : 0;
    setContinuous({
      ...EMPTY_CONTINUOUS,
      phase: "preloading",
      modelProgress: 0,
      activeVerse: verses[Math.max(0, startIndex)]?.verse_number ?? null,
    });
    // Prefetch the sheikh PCM in parallel with model load so DTW analysis is
    // instant when the first ayah's transcription completes.
    if (surahAudioUrlRef.current) {
      void getSheikhSurahPCM(surahAudioUrlRef.current).catch(() => {
        // Pacing panel just won't render for that ayah; not fatal.
      });
    }
    try {
      await loadWhisper((status: LoadStatus) => {
        if (status.kind === "loading") {
          setContinuous((s) => ({ ...s, modelProgress: status.progress }));
        }
      });
    } catch (err) {
      setContinuous({
        ...EMPTY_CONTINUOUS,
        errorMessage:
          err instanceof Error ? err.message : "Model failed to load.",
      });
      return;
    }
    setContinuous((s) => ({ ...s, modelProgress: 100 }));
    try {
      const session = await startContinuousRecite({
        verses,
        startIndex: Math.max(0, startIndex),
        callbacks: {
          onCalibrationStart: () =>
            setContinuous((s) => ({ ...s, phase: "calibrating" })),
          onCalibrationComplete: () =>
            setContinuous((s) => ({ ...s, phase: "listening" })),
          onActiveVerseChanged: (verseNumber) =>
            setContinuous((s) => ({
              ...s,
              activeVerse: verseNumber,
              phase: verseNumber !== null ? "listening" : s.phase,
            })),
          onTranscribing: (verseNumber) =>
            setContinuous((s) => {
              const next = new Set(s.transcribing);
              next.add(verseNumber);
              return { ...s, transcribing: next };
            }),
          onResult: (verseNumber, transcript, audioBlob, words) =>
            setContinuous((s) => {
              const nextTranscribing = new Set(s.transcribing);
              nextTranscribing.delete(verseNumber);
              const nextResults = new Map(s.results);
              nextResults.set(verseNumber, { transcript, audioBlob, words });
              return {
                ...s,
                transcribing: nextTranscribing,
                results: nextResults,
              };
            }),
          onError: (verseNumber, message) =>
            setContinuous((s) => {
              const nextErrors = new Map(s.errors);
              const nextTranscribing = new Set(s.transcribing);
              if (verseNumber !== null) {
                nextErrors.set(verseNumber, message);
                nextTranscribing.delete(verseNumber);
              }
              return {
                ...s,
                errors: nextErrors,
                transcribing: nextTranscribing,
                errorMessage: message,
              };
            }),
          onComplete: () =>
            setContinuous((s) => ({
              ...s,
              phase: "off",
              activeVerse: null,
              meter: null,
            })),
          onMicLevel: (rms, threshold, isSilent) =>
            setContinuous((s) =>
              s.phase === "off"
                ? s
                : { ...s, meter: { rms, threshold, isSilent } }
            ),
        },
      });
      sessionRef.current = session;
    } catch (err) {
      setContinuous({
        ...EMPTY_CONTINUOUS,
        errorMessage:
          err instanceof Error
            ? err.message
            : "Could not start microphone session.",
      });
    }
  }

  function stopContinuous() {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }

  function skipCurrentInContinuous() {
    sessionRef.current?.skipCurrent();
  }

  function clearContinuousResults() {
    setContinuous(EMPTY_CONTINUOUS);
  }

  function clearContinuousResultForVerse(verseNumber: number) {
    setContinuous((s) => {
      const nextResults = new Map(s.results);
      const nextErrors = new Map(s.errors);
      nextResults.delete(verseNumber);
      nextErrors.delete(verseNumber);
      return { ...s, results: nextResults, errors: nextErrors };
    });
  }

  const hasResults =
    continuous.results.size > 0 || continuous.errors.size > 0;
  const isActive = continuous.phase !== "off";

  return (
    <PlayerProvider reciterId={reciter.id} surahId={surahId}>
      <ControlsBar
        reciterId={reciterId}
        onReciter={chooseReciter}
        continuousActive={isActive}
        continuousPhase={continuous.phase}
        continuousModelProgress={continuous.modelProgress}
        continuousActiveVerse={continuous.activeVerse}
        continuousErrorMessage={continuous.errorMessage}
        continuousMeter={continuous.meter}
        continuousTranscribingCount={continuous.transcribing.size}
        continuousResultCount={continuous.results.size}
        hasContinuousResults={hasResults}
        onStartContinuous={() => void startContinuous()}
        onStopContinuous={stopContinuous}
        onSkipContinuous={skipCurrentInContinuous}
        onClearContinuous={clearContinuousResults}
        onSurahAudioUrl={(url) => {
          surahAudioUrlRef.current = url;
        }}
      />
      <ScrollPageIndicator verses={verses} />
      <ol className="flex flex-col gap-3">
        {verses.map((v, i) => {
          const prevPage = verses[i - 1]?.page_number;
          const showDivider =
            prevPage !== undefined && v.page_number !== prevPage;
          const override = continuousOverrideFor(continuous, v.verse_number);
          return (
            <Fragment key={v.id}>
              {showDivider && <PageDivider page={v.page_number} />}
              <AyahRow
                verse={v}
                translation={translations[i]}
                registry={registry}
                hasNext={v.verse_number < lastVerseNumber}
                continuousOverride={override}
                continuousActive={isActive}
                onClearContinuousResult={clearContinuousResultForVerse}
              />
            </Fragment>
          );
        })}
      </ol>
    </PlayerProvider>
  );
}

function continuousOverrideFor(
  state: ContinuousState,
  verseNumber: number
): ContinuousOverride | null {
  if (state.phase === "off" && state.results.size === 0 && state.errors.size === 0) {
    return null;
  }
  if (state.activeVerse === verseNumber && state.phase === "listening") {
    return { kind: "recording" };
  }
  if (state.transcribing.has(verseNumber)) {
    return { kind: "transcribing" };
  }
  const r = state.results.get(verseNumber);
  if (r !== undefined) {
    return {
      kind: "result",
      transcript: r.transcript,
      audioBlob: r.audioBlob,
      words: r.words,
    };
  }
  const err = state.errors.get(verseNumber);
  if (err !== undefined) {
    return { kind: "error", message: err };
  }
  return null;
}

function ControlsBar({
  reciterId,
  onReciter,
  continuousActive,
  continuousPhase,
  continuousModelProgress,
  continuousActiveVerse,
  continuousErrorMessage,
  continuousMeter,
  continuousTranscribingCount,
  continuousResultCount,
  hasContinuousResults,
  onStartContinuous,
  onStopContinuous,
  onSkipContinuous,
  onClearContinuous,
  onSurahAudioUrl,
}: {
  reciterId: number;
  onReciter: (id: number) => void;
  continuousActive: boolean;
  continuousPhase: ContinuousPhase;
  continuousModelProgress: number;
  continuousActiveVerse: number | null;
  continuousErrorMessage: string | null;
  continuousMeter: MicMeter | null;
  continuousTranscribingCount: number;
  continuousResultCount: number;
  hasContinuousResults: boolean;
  onStartContinuous: () => void;
  onStopContinuous: () => void;
  onSkipContinuous: () => void;
  onClearContinuous: () => void;
  onSurahAudioUrl: (url: string | null) => void;
}) {
  const { store, audioStatus, audioError, surahAudio } = usePlayer();
  useEffect(() => {
    onSurahAudioUrl(surahAudio?.audioUrl ?? null);
  }, [surahAudio, onSurahAudioUrl]);
  const isPlaying = useIsPlaying();
  const activeKey = useActiveVerseKey();
  const lastActiveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeKey && activeKey !== lastActiveKeyRef.current) {
      lastActiveKeyRef.current = activeKey;
      const el = document.getElementById(`ayah-${activeKey}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [activeKey]);

  const reciter = getReciter(reciterId);

  return (
    <div className="mb-6 sticky top-14 z-10 rounded-lg border border-stone-200 dark:border-stone-800 p-3 bg-white/95 dark:bg-stone-900/95 backdrop-blur">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 min-w-0">
          <label
            htmlFor="reciter"
            className="block text-xs uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5"
          >
            Reciter
          </label>
          <select
            id="reciter"
            value={reciterId}
            onChange={(e) => onReciter(Number(e.target.value))}
            disabled={continuousActive}
            className="w-full rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-3 py-2 text-sm disabled:opacity-50"
          >
            {RECITERS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.style !== "murattal" ? ` (${r.style})` : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-stone-500 dark:text-stone-400 mt-1.5">
            {reciter.arabicName}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            disabled={audioStatus !== "ready" || continuousActive}
            onClick={() => {
              if (isPlaying) store.togglePause();
              else if (activeKey) store.togglePause();
              else store.playFullSurah();
            }}
            className="rounded-md bg-emerald-600 text-white px-3 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          >
            {audioStatus === "loading"
              ? "Loading…"
              : isPlaying
                ? "⏸ Pause"
                : activeKey
                  ? "▶ Resume"
                  : "▶ Play full surah"}
          </button>
          <button
            type="button"
            disabled={audioStatus !== "ready" || !activeKey}
            onClick={() => store.stop()}
            className="rounded-md border border-stone-300 dark:border-stone-700 px-3 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
          >
            ⏹ Stop audio
          </button>
          {continuousActive ? (
            <>
              <button
                type="button"
                onClick={onSkipContinuous}
                disabled={continuousPhase !== "listening"}
                className="rounded-md border border-stone-300 dark:border-stone-700 px-3 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
                title="Force advance to the next ayah"
              >
                ⏭ Next ayah
              </button>
              <button
                type="button"
                onClick={onStopContinuous}
                className="rounded-md bg-red-600 text-white px-3 py-2 text-sm font-medium hover:bg-red-700"
              >
                ⏹ Stop reciting
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onStartContinuous}
              className="rounded-md bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700"
              title="Recite continuously — the system auto-advances on natural pauses"
            >
              🎙 Continuous recite
            </button>
          )}
          {hasContinuousResults && !continuousActive && (
            <button
              type="button"
              onClick={onClearContinuous}
              className="rounded-md border border-stone-300 dark:border-stone-700 px-3 py-2 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Clear results
            </button>
          )}
        </div>
      </div>

      {continuousPhase === "preloading" && (
        <div className="mt-3 rounded-md border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/40 p-3">
          <p className="text-xs font-medium text-indigo-900 dark:text-indigo-200 mb-1.5">
            First-time setup — downloading Tarteel Whisper (~93 MB, cached after).
          </p>
          <div className="h-1.5 w-full rounded-full bg-indigo-100 dark:bg-indigo-900/60 overflow-hidden">
            <div
              className="h-full bg-indigo-600 dark:bg-indigo-500 transition-[width] duration-200"
              style={{ width: `${continuousModelProgress}%` }}
            />
          </div>
          <p className="text-[10px] text-indigo-700 dark:text-indigo-300 mt-1 tabular-nums">
            {continuousModelProgress}% — once loaded, every recite is instant
          </p>
        </div>
      )}

      {(continuousPhase === "calibrating" ||
        continuousPhase === "listening") && (
        <div
          className={`mt-3 rounded-md border p-3 ${
            continuousPhase === "calibrating"
              ? "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40"
              : "border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/40"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <p
              className={`text-xs font-semibold ${
                continuousPhase === "calibrating"
                  ? "text-amber-900 dark:text-amber-200"
                  : "text-indigo-900 dark:text-indigo-200"
              }`}
            >
              {continuousPhase === "calibrating"
                ? "🤫 STAY SILENT — calibrating to your mic + room (~0.7s)"
                : `🎙 Listening · ayah ${continuousActiveVerse ?? "?"} · pause ~0.9s to advance`}
            </p>
            <p className="text-[10px] text-indigo-700 dark:text-indigo-300 tabular-nums">
              {continuousResultCount} done ·{" "}
              {continuousTranscribingCount} transcribing
            </p>
          </div>
          <MicLevelMeter meter={continuousMeter} />
        </div>
      )}

      {continuousErrorMessage && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-2">
          {continuousErrorMessage}
        </p>
      )}
      {audioStatus === "error" && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-2">
          Audio load failed: {audioError}
        </p>
      )}
    </div>
  );
}

function MicLevelMeter({ meter }: { meter: MicMeter | null }) {
  if (!meter) {
    return (
      <div className="h-2 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden" />
    );
  }
  const SCALE = 0.15;
  const levelPct = Math.min(100, (meter.rms / SCALE) * 100);
  const thresholdPct = Math.min(100, (meter.threshold / SCALE) * 100);
  return (
    <div className="relative h-2 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
      <div
        className={`absolute top-0 left-0 h-full transition-[width] duration-100 ${
          meter.isSilent ? "bg-stone-400" : "bg-emerald-500"
        }`}
        style={{ width: `${levelPct}%` }}
      />
      <div
        className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-red-600"
        style={{ left: `${thresholdPct}%` }}
        title="Silence threshold"
      />
    </div>
  );
}
