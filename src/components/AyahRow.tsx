"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Verse } from "@/lib/quran";
import {
  diffRecitation,
  accuracyScore,
  alignUserToExpected,
  tokenize,
  type DiffToken,
} from "@/lib/diff";
import {
  buildWordFeedbackRendering,
  diffGraphemes,
  letterAccuracy,
  summarizeLetterDiff,
  type WordStatus,
} from "@/lib/arabicGraphemes";
import {
  transcribeWithTimings,
  type LoadStatus,
  type WordTiming,
} from "@/lib/whisper";
import {
  analyzeTiming,
  blobToMono16k,
  getSheikhSurahPCM,
  sliceAyahPCM,
  type TimingReport,
} from "@/lib/timingAnalysis";
import { usePlayer, useWordIndexFor } from "./PlayerProvider";
import type { ReciteRegistry } from "./SurahView";

type RecState =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "loading-model"; progress: number }
  | { kind: "transcribing" }
  | {
      kind: "result";
      tokens: DiffToken[];
      transcript: string;
      audioBlob: Blob;
      words: WordTiming[];
    }
  | { kind: "error"; message: string };

export type ContinuousOverride =
  | { kind: "recording" }
  | { kind: "transcribing" }
  | {
      kind: "result";
      transcript: string;
      audioBlob: Blob;
      words: WordTiming[];
    }
  | { kind: "error"; message: string };

export function AyahRow({
  verse,
  translation,
  registry,
  hasNext,
  continuousOverride = null,
  continuousActive = false,
  onClearContinuousResult,
}: {
  verse: Verse;
  translation?: string;
  registry: ReciteRegistry;
  hasNext: boolean;
  continuousOverride?: ContinuousOverride | null;
  continuousActive?: boolean;
  onClearContinuousResult?: (verseNumber: number) => void;
}) {
  const { store, audioStatus, surahAudio } = usePlayer();
  const [rec, setRec] = useState<RecState>({ kind: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [replayWordIdx, setReplayWordIdx] = useState<number>(-1);
  const [timingReport, setTimingReport] = useState<TimingReport | null>(null);
  const [timingPending, setTimingPending] = useState(false);

  // Filter out tokens that are pure waqf/typographic marks (e.g. the bare ۚ
  // jeem stop sign that the Uthmani text has separated by whitespace). The
  // sheikh's per-word segment data counts only real words, so without this
  // filter the highlight indices drift past stop marks.
  const words = useMemo(
    () =>
      verse.text_uthmani.trim().split(/\s+/).filter(hasArabicLetter),
    [verse.text_uthmani]
  );
  const activeWord = useWordIndexFor(verse.verse_key);

  const continuousTokens = useMemo(
    () =>
      continuousOverride?.kind === "result"
        ? diffRecitation(verse.text_uthmani, continuousOverride.transcript)
        : null,
    [continuousOverride, verse.text_uthmani]
  );

  const isContinuousActive = continuousOverride?.kind === "recording";

  // Decide which result (if any) we're showing replay UI for
  const replayResult: {
    tokens: DiffToken[];
    transcript: string;
    audioBlob: Blob;
    words: WordTiming[];
  } | null = useMemo(() => {
    if (continuousOverride?.kind === "result" && continuousTokens) {
      return {
        tokens: continuousTokens,
        transcript: continuousOverride.transcript,
        audioBlob: continuousOverride.audioBlob,
        words: continuousOverride.words,
      };
    }
    if (!continuousOverride && rec.kind === "result") {
      return {
        tokens: rec.tokens,
        transcript: rec.transcript,
        audioBlob: rec.audioBlob,
        words: rec.words,
      };
    }
    return null;
  }, [continuousOverride, continuousTokens, rec]);

  // Word-level feedback rendering keeps each word as one connected span so
  // Arabic cursive joins render correctly; status colors come from the
  // letter-level analysis aggregated up to the word.
  const wordRenderParts = useMemo(
    () =>
      replayResult
        ? buildWordFeedbackRendering(verse.text_uthmani, replayResult.transcript)
        : null,
    [replayResult, verse.text_uthmani]
  );
  const showInlineFeedback =
    !!wordRenderParts && activeWord === null && replayWordIdx < 0;

  // Run DTW timing analysis (sheikh vs user) when we have a result + audio
  useEffect(() => {
    setTimingReport(null);
    if (!replayResult || !surahAudio) return;
    const timing = surahAudio.verseTimings.find(
      (t) => t.verse_key === verse.verse_key
    );
    if (!timing || timing.segments.length === 0) return;
    let cancelled = false;
    setTimingPending(true);
    (async () => {
      try {
        const [userPcm, sheikhFull] = await Promise.all([
          blobToMono16k(replayResult.audioBlob),
          getSheikhSurahPCM(surahAudio.audioUrl),
        ]);
        if (cancelled) return;
        const sheikhAyahPcm = sliceAyahPCM(
          sheikhFull,
          timing.timestamp_from,
          timing.timestamp_to
        );
        const report = analyzeTiming(userPcm, sheikhAyahPcm, timing.segments);
        if (!cancelled) {
          setTimingReport(report);
          setTimingPending(false);
        }
      } catch {
        if (!cancelled) setTimingPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replayResult, surahAudio, verse.verse_key]);

  function playSheikh() {
    store.playFromVerse(verse.verse_key, { singleVerse: true });
  }

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        recorderRef.current?.stop();
      } catch {
        // recorder may not be in a stoppable state; ignore
      }
    },
    []
  );

  useEffect(() => {
    return registry.register(verse.verse_number, () =>
      startReciteRef.current()
    );
  }, [registry, verse.verse_number]);

  const startReciteRef = useRef<() => void>(() => {});

  function listen() {
    store.playFromVerse(verse.verse_key, { singleVerse: true });
  }

  async function startRecite() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      setRec({
        kind: "error",
        message: "Microphone access isn't available in this browser.",
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      const rec = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined
      );
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void runTranscription(blob);
      };
      recorderRef.current = rec;
      rec.start();
      setRec({ kind: "recording" });
    } catch (err) {
      setRec({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Could not access microphone. Check permissions.",
      });
    }
  }

  function stopRecite() {
    try {
      recorderRef.current?.stop();
    } catch {
      // ignore
    }
  }

  async function runTranscription(blob: Blob) {
    setRec({ kind: "transcribing" });
    try {
      const { text, words: wordTimings } = await transcribeWithTimings(blob, {
        onStatus: (status: LoadStatus) => {
          if (status.kind === "loading") {
            setRec({ kind: "loading-model", progress: status.progress });
          } else if (status.kind === "ready") {
            setRec({ kind: "transcribing" });
          }
        },
      });
      const tokens = diffRecitation(verse.text_uthmani, text);
      setRec({
        kind: "result",
        tokens,
        transcript: text,
        audioBlob: blob,
        words: wordTimings,
      });
    } catch (err) {
      setRec({
        kind: "error",
        message: err instanceof Error ? err.message : "Transcription failed.",
      });
    }
  }

  startReciteRef.current = () => void startRecite();

  return (
    <li
      id={`ayah-${verse.verse_key}`}
      data-verse-key={verse.verse_key}
      data-page-number={verse.page_number}
      className={`rounded-lg border bg-white dark:bg-stone-900 p-4 transition-colors ${
        isContinuousActive
          ? "border-indigo-500 dark:border-indigo-500 shadow-md ring-2 ring-indigo-200 dark:ring-indigo-900/60"
          : activeWord !== null || replayWordIdx >= 0
            ? "border-emerald-400 dark:border-emerald-700 shadow-sm"
            : "border-stone-200 dark:border-stone-800"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="flex h-7 min-w-7 items-center justify-center rounded-md bg-stone-100 dark:bg-stone-800 text-xs font-medium tabular-nums px-1.5">
            {verse.verse_number}
          </span>
          <span
            className="inline-flex items-center rounded-md bg-emerald-100 dark:bg-emerald-900/60 text-emerald-900 dark:text-emerald-200 text-xs font-bold px-2 py-0.5 tabular-nums whitespace-nowrap"
            title={`Mushaf page ${verse.page_number}`}
          >
            📖 Page {verse.page_number}
          </span>
        </div>
        <div className="flex gap-2 shrink-0 ml-auto">
          <button
            type="button"
            onClick={listen}
            disabled={audioStatus !== "ready"}
            className="text-xs rounded-md border border-stone-300 dark:border-stone-700 px-2.5 py-1 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
          >
            ▶ Listen
          </button>
          {continuousActive || continuousOverride ? (
            <span
              className={`text-xs rounded-md px-2.5 py-1 font-medium ${
                continuousOverride?.kind === "recording"
                  ? "bg-indigo-600 text-white animate-pulse"
                  : continuousOverride?.kind === "transcribing"
                    ? "border border-stone-300 dark:border-stone-700 text-stone-500"
                    : continuousOverride?.kind === "result"
                      ? "bg-emerald-600 text-white"
                      : continuousOverride?.kind === "error"
                        ? "bg-red-600 text-white"
                        : "border border-stone-300 dark:border-stone-700 text-stone-400"
              }`}
            >
              {continuousOverride?.kind === "recording"
                ? "🎙 Recording…"
                : continuousOverride?.kind === "transcribing"
                  ? "Transcribing…"
                  : continuousOverride?.kind === "result"
                    ? "✓ Done"
                    : continuousOverride?.kind === "error"
                      ? "Error"
                      : "Queued"}
            </span>
          ) : rec.kind === "recording" ? (
            <button
              type="button"
              onClick={stopRecite}
              className="text-xs rounded-md bg-red-600 text-white px-2.5 py-1 hover:bg-red-700"
            >
              ⏹ Stop
            </button>
          ) : rec.kind === "loading-model" || rec.kind === "transcribing" ? (
            <button
              type="button"
              disabled
              className="text-xs rounded-md border border-stone-300 dark:border-stone-700 px-2.5 py-1 opacity-60"
            >
              {rec.kind === "loading-model"
                ? `Loading model… ${rec.progress}%`
                : "Transcribing…"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startRecite()}
              className="text-xs rounded-md bg-emerald-600 text-white px-2.5 py-1 hover:bg-emerald-700"
            >
              🎙 Recite
            </button>
          )}
        </div>
      </div>

      <p className="arabic">
        {showInlineFeedback && wordRenderParts
          ? wordRenderParts.map((part, i) => {
              if (part.kind === "space") return <span key={i}> </span>;
              if (part.kind === "extra") {
                return (
                  <span
                    key={i}
                    className="arabic-word bg-stone-200 dark:bg-stone-800 text-stone-500 dark:text-stone-500 line-through opacity-70"
                    title={`Extra: you said ${part.text}`}
                  >
                    {part.text}
                  </span>
                );
              }
              const title = part.letterTokens
                .filter((t) => t.feedback)
                .map((t) => t.feedback)
                .join(" · ") || labelForStatus(part.status);
              return (
                <span
                  key={i}
                  className={`arabic-word ${classForWordStatus(part.status)}`}
                  title={title}
                >
                  {part.text}
                </span>
              );
            })
          : words.map((w, i) => {
              const wordPos = i + 1;
              const isActive = activeWord === wordPos;
              const isReplayActive = replayWordIdx === i;
              return (
                <span
                  key={i}
                  className={`arabic-word ${
                    isReplayActive
                      ? "bg-indigo-200 dark:bg-indigo-900/70 text-indigo-950 dark:text-indigo-100"
                      : isActive
                        ? "bg-emerald-200 dark:bg-emerald-900/70 text-emerald-950 dark:text-emerald-100"
                        : ""
                  }`}
                >
                  {w}
                  {i < words.length - 1 ? " " : ""}
                </span>
              );
            })}
      </p>

      {translation && (
        <p
          dir="ltr"
          className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300 italic"
        >
          {translation}
        </p>
      )}

      {continuousOverride?.kind === "result" &&
        continuousOverride.transcript.length === 0 && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
            Whisper didn&apos;t hear anything for this ayah. The mic may be
            quiet, the segment may have been too short, or VAD advanced too
            early.
          </p>
        )}
      {continuousOverride?.kind === "error" && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {continuousOverride.message}
        </p>
      )}
      {!continuousOverride && rec.kind === "recording" && (
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          Recording — recite the ayah, then hit Stop.
        </p>
      )}
      {rec.kind === "loading-model" && (
        <div className="mt-3">
          <p className="text-xs text-stone-500 dark:text-stone-400 mb-1">
            First-time setup — downloading Quran recognition model (~90MB,
            cached after).
          </p>
          <div className="h-1.5 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 dark:bg-emerald-600 transition-[width] duration-200"
              style={{ width: `${rec.progress}%` }}
            />
          </div>
        </div>
      )}
      {rec.kind === "transcribing" && (
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          Transcribing with Tarteel Whisper…
        </p>
      )}
      {replayResult && !continuousActive && (
        <Feedback
          tokens={replayResult.tokens}
          transcript={replayResult.transcript}
          expectedText={verse.text_uthmani}
          audioBlob={replayResult.audioBlob}
          userWords={replayResult.words}
          timingReport={timingReport}
          timingPending={timingPending}
          words={words}
          onReplayWordIdxChange={setReplayWordIdx}
          onPlaySheikh={playSheikh}
          onReset={
            continuousOverride && onClearContinuousResult
              ? () => onClearContinuousResult(verse.verse_number)
              : () => setRec({ kind: "idle" })
          }
          onAdvance={
            !continuousOverride && hasNext
              ? () => registry.advanceFrom(verse.verse_number)
              : undefined
          }
        />
      )}
      {rec.kind === "error" && (
        <div className="mt-3 text-sm text-red-600 dark:text-red-400">
          {rec.message}{" "}
          <button
            onClick={() => setRec({ kind: "idle" })}
            className="underline"
          >
            try again
          </button>
        </div>
      )}
    </li>
  );
}

function Feedback({
  tokens,
  transcript,
  expectedText,
  audioBlob,
  userWords,
  timingReport,
  timingPending,
  words,
  onReset,
  onAdvance,
  onReplayWordIdxChange,
  onPlaySheikh,
}: {
  tokens: DiffToken[];
  transcript: string;
  expectedText: string;
  audioBlob: Blob | null;
  userWords: WordTiming[];
  timingReport: TimingReport | null;
  timingPending: boolean;
  words: string[];
  onReset: () => void;
  onAdvance?: () => void;
  onReplayWordIdxChange: (idx: number) => void;
  onPlaySheikh: () => void;
}) {
  const score = accuracyScore(tokens);
  const letterTokens = useMemo(
    () => diffGraphemes(expectedText, transcript),
    [expectedText, transcript]
  );
  const letterScore = useMemo(
    () => letterAccuracy(letterTokens),
    [letterTokens]
  );
  const letterIssues = useMemo(
    () => summarizeLetterDiff(letterTokens, { limit: 8 }),
    [letterTokens]
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Map user-word-index → expected-word-index via the diff alignment
  const userToExpected = useMemo(() => alignUserToExpected(tokens), [tokens]);

  // Cache normalized user word tokens — Whisper segment text vs LCS token text
  // come from the same transcript, so their tokenizations should align 1:1
  const userTokenCount = useMemo(
    () => tokenize(transcript).length,
    [transcript]
  );

  useEffect(() => {
    if (!audioBlob) return;
    const url = URL.createObjectURL(audioBlob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioBlob]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      audioRef.current?.pause();
      onReplayWordIdxChange(-1);
    };
  }, [onReplayWordIdxChange]);

  function startReplay() {
    if (!audioUrl) return;
    if (!audioRef.current) {
      const a = new Audio(audioUrl);
      audioRef.current = a;
      a.addEventListener("ended", () => {
        setIsPlaying(false);
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        onReplayWordIdxChange(-1);
      });
      a.addEventListener("pause", () => {
        setIsPlaying(false);
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      });
    } else {
      audioRef.current.src = audioUrl;
      audioRef.current.currentTime = 0;
    }
    void audioRef.current.play();
    setIsPlaying(true);
    tickReplay();
  }

  function stopReplay() {
    audioRef.current?.pause();
    setIsPlaying(false);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    onReplayWordIdxChange(-1);
  }

  function tickReplay() {
    const a = audioRef.current;
    if (!a) return;
    const t = a.currentTime;
    let userIdx = -1;
    for (let i = 0; i < userWords.length; i++) {
      if (t >= userWords[i].start && t <= userWords[i].end) {
        userIdx = i;
        break;
      }
      if (t < userWords[i].start) break;
    }
    if (userIdx < 0 && userWords.length > 0) {
      // If between words, light up the previously spoken word so it doesn't jump to -1
      for (let i = userWords.length - 1; i >= 0; i--) {
        if (t >= userWords[i].end) {
          userIdx = i;
          break;
        }
      }
    }
    // Whisper sometimes returns fewer "chunks" than tokenized words; clamp.
    const safeUserIdx = Math.min(userIdx, userTokenCount - 1);
    const expectedIdx =
      safeUserIdx >= 0 && safeUserIdx < userToExpected.length
        ? userToExpected[safeUserIdx]
        : -1;
    onReplayWordIdxChange(expectedIdx >= 0 ? expectedIdx : -1);
    if (!a.paused && !a.ended) {
      rafRef.current = requestAnimationFrame(tickReplay);
    }
  }

  return (
    <div className="mt-4 border-t border-stone-200 dark:border-stone-800 pt-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-xs uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {score}% words · {letterScore}% letters + tashkeel
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {audioUrl && (
            <button
              onClick={isPlaying ? stopReplay : startReplay}
              className="text-xs font-medium rounded-md bg-indigo-600 text-white px-2.5 py-1 hover:bg-indigo-700"
              title="Replay your recitation with synchronized word highlighting"
            >
              {isPlaying ? "⏸ Stop replay" : "▶ Replay mine"}
            </button>
          )}
          <button
            onClick={onPlaySheikh}
            className="text-xs font-medium rounded-md bg-emerald-600 text-white px-2.5 py-1 hover:bg-emerald-700"
            title="Play the selected reciter's audio for this ayah"
          >
            ▶ Sheikh
          </button>
          <button
            onClick={onReset}
            className="text-xs text-stone-500 dark:text-stone-400 hover:underline"
          >
            retry
          </button>
          {onAdvance && (
            <button
              onClick={onAdvance}
              className="text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
            >
              Next ayah →
            </button>
          )}
        </div>
      </div>
      {letterIssues.length > 0 && (
        <div className="mt-3 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 p-3">
          <p className="text-xs uppercase tracking-wider text-amber-800 dark:text-amber-300 mb-1.5 font-semibold">
            What to fix
          </p>
          <ul className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed space-y-0.5">
            {letterIssues.map((issue, idx) => (
              <li key={idx}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {letterIssues.length === 0 && letterScore >= 95 && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
          ✓ Clean letter + tashkeel match against the Uthmani text.
        </p>
      )}
      {timingPending && (
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          Comparing your pacing to the sheikh…
        </p>
      )}
      {timingReport && <TimingPanel report={timingReport} words={words} />}
      <details className="mt-2 text-xs text-stone-500 dark:text-stone-400">
        <summary className="cursor-pointer">What the model heard</summary>
        <p
          className="arabic mt-1"
          style={{ fontSize: "1.25rem", lineHeight: "2" }}
        >
          {transcript || "(empty)"}
        </p>
      </details>
    </div>
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c));
}

function classForWordStatus(status: WordStatus): string {
  switch (status) {
    case "correct":
      return "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-100";
    case "wrong-marks":
      return "bg-amber-200 dark:bg-amber-900/70 text-amber-950 dark:text-amber-100 ring-1 ring-amber-400 dark:ring-amber-700";
    case "wrong-letter":
      return "bg-red-200 dark:bg-red-900/70 text-red-950 dark:text-red-100 ring-1 ring-red-400 dark:ring-red-700";
    case "missing":
      return "bg-orange-100 dark:bg-orange-950/60 text-orange-900 dark:text-orange-200 underline decoration-dotted decoration-orange-500";
    case "partial":
      return "bg-yellow-100 dark:bg-yellow-950/60 text-yellow-900 dark:text-yellow-200 underline decoration-dotted decoration-yellow-500";
  }
}

function labelForStatus(status: WordStatus): string {
  switch (status) {
    case "correct":
      return "Correct";
    case "wrong-marks":
      return "Right letters, wrong tashkeel";
    case "wrong-letter":
      return "Wrong letter substitution";
    case "missing":
      return "You didn't say this word";
    case "partial":
      return "Part of the word was missed";
  }
}

function hasArabicLetter(token: string): boolean {
  for (const ch of token) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    // Basic Arabic letters U+0621..U+064A and the extended Quranic letters
    // U+0671..U+06D3 (covers ٱ alif wasla, ۚ-adjacent letters, etc.)
    if (
      (code >= 0x0621 && code <= 0x064a) ||
      (code >= 0x0671 && code <= 0x06d3)
    ) {
      return true;
    }
  }
  return false;
}

function TimingPanel({
  report,
  words,
}: {
  report: TimingReport;
  words: string[];
}) {
  const totalPct = Math.round(report.totalRatio * 100);
  const totalKind =
    report.totalRatio < 0.75
      ? "rushed"
      : report.totalRatio > 1.35
        ? "slow"
        : "balanced";
  const totalText =
    totalKind === "rushed"
      ? `Overall ${totalPct}% of the sheikh's duration — you're rushing. Try slowing the recitation.`
      : totalKind === "slow"
        ? `Overall ${totalPct}% of the sheikh's duration — slower than the reference. Could be intentional (tarteel) or stretched out beyond reference.`
        : `Overall ${totalPct}% of the sheikh's duration — pacing is in range.`;

  const flagged = report.perWord.filter((w) => w.kind !== "balanced");

  return (
    <div className="mt-3 rounded-md bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900/60 p-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-1.5">
        <p className="text-xs uppercase tracking-wider text-indigo-800 dark:text-indigo-300 font-semibold">
          Pacing vs sheikh
        </p>
        <p className="text-[10px] text-indigo-700 dark:text-indigo-300 tabular-nums">
          you {(report.userTotalMs / 1000).toFixed(1)}s · sheikh{" "}
          {(report.sheikhTotalMs / 1000).toFixed(1)}s
        </p>
      </div>
      <p className="text-xs text-indigo-900 dark:text-indigo-200 mb-2">
        {totalText}
      </p>
      {flagged.length > 0 && (
        <ul className="text-xs text-indigo-900 dark:text-indigo-200 leading-relaxed space-y-0.5">
          {flagged.map((w, idx) => {
            const word = words[w.wordIdx - 1] ?? `word ${w.wordIdx}`;
            return (
              <li key={idx}>
                <span className="arabic" style={{ fontSize: "1rem" }}>
                  {word}
                </span>{" "}
                — {w.feedback}
              </li>
            );
          })}
        </ul>
      )}
      {flagged.length === 0 && (
        <p className="text-[11px] text-indigo-700 dark:text-indigo-300 italic">
          Per-word pacing within the acceptable range vs the sheikh.
        </p>
      )}
    </div>
  );
}
