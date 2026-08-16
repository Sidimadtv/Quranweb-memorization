"use client";

import { useEffect, useState } from "react";
import { loadWhisper, isWhisperLoaded, type LoadStatus } from "@/lib/whisper";
import { INTRO_DONE_EVENT } from "./IntroOverlay";

// Hard cap on how long we'll wait for the intro to fire its done event
// before starting the model download anyway. If the intro is disabled or
// crashes, the model still loads.
const INTRO_WAIT_FALLBACK_MS = 7500;

type PreloadState =
  | { kind: "idle" }
  | { kind: "loading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function ModelPreloader() {
  const [state, setState] = useState<PreloadState>({ kind: "idle" });
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isWhisperLoaded()) {
      // Already loaded in this tab session — nothing to show.
      return;
    }
    let cancelled = false;
    let started = false;

    function start() {
      if (started || cancelled) return;
      started = true;
      setState({ kind: "loading", progress: 0 });
      loadWhisper((s: LoadStatus) => {
        if (cancelled) return;
        if (s.kind === "loading") {
          setState({ kind: "loading", progress: s.progress });
        } else if (s.kind === "ready") {
          setState({ kind: "ready" });
          setTimeout(() => {
            if (!cancelled) setDismissed(true);
          }, 4000);
        } else if (s.kind === "error") {
          setState({ kind: "error", message: s.message });
        }
      }).catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to load model",
        });
      });
    }

    // Wait for the intro to finish before starting the 98 MB download —
    // running both at once (heavy network + decode + WASM init alongside
    // the CSS 3D sway animation) makes the intro stutter on mid-range
    // devices.
    const onIntroDone = () => start();
    window.addEventListener(INTRO_DONE_EVENT, onIntroDone, { once: true });
    const fallback = window.setTimeout(start, INTRO_WAIT_FALLBACK_MS);

    return () => {
      cancelled = true;
      window.removeEventListener(INTRO_DONE_EVENT, onIntroDone);
      clearTimeout(fallback);
    };
  }, []);

  if (state.kind === "idle" || dismissed) return null;

  const isLoading = state.kind === "loading";
  const isReady = state.kind === "ready";
  const isError = state.kind === "error";

  const colors = isReady
    ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/60"
    : isError
      ? "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60"
      : "border-indigo-300 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/60";

  return (
    <div className="fixed top-16 right-3 z-30 w-72 max-w-[calc(100vw-1.5rem)]">
      <div className={`rounded-md border shadow-md p-3 ${colors}`}>
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => isLoading && setExpanded((e) => !e)}
            className="flex-1 text-left"
            aria-label={isLoading ? "Tap for details" : undefined}
          >
            {isReady && (
              <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                ✓ Recitation model ready
              </p>
            )}
            {isError && (
              <p className="text-xs font-semibold text-red-900 dark:text-red-200">
                ⚠ Recitation model failed to load
              </p>
            )}
            {isLoading && (
              <p className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                📥 Preparing recitation model
              </p>
            )}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200 text-sm px-1 leading-none"
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
        {isLoading && (
          <>
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-indigo-100 dark:bg-indigo-900/40 overflow-hidden">
              <div
                className="h-full bg-indigo-600 dark:bg-indigo-500 transition-[width] duration-200"
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 text-[10px] text-indigo-700 dark:text-indigo-300 hover:underline tabular-nums text-left"
            >
              {state.progress}% — {expanded ? "hide details" : "tap for details"}
            </button>
          </>
        )}
        {isError && (
          <p className="mt-1 text-[10px] text-red-800 dark:text-red-300">
            {state.message}
          </p>
        )}
        {expanded && (
          <div className="mt-2 pt-2 border-t border-indigo-200 dark:border-indigo-900 space-y-2">
            <ExplainSection title="What's happening">
              The site is downloading <strong>Tarteel Whisper</strong> — an
              AI model fine-tuned on Quran recitation (~98 MB). It only has
              to do this once per browser.
            </ExplainSection>
            <ExplainSection title="Why now">
              So when you press 🎙 Recite, transcription is instant.
              Otherwise you&apos;d wait for this same download to happen
              right at that moment.
            </ExplainSection>
            <ExplainSection title="Privacy">
              The model runs <strong>entirely in your browser</strong>. Your
              microphone audio never leaves your device — there&apos;s no
              server-side transcription. Cached locally after this first
              visit, so future sessions skip the download.
            </ExplainSection>
          </div>
        )}
      </div>
    </div>
  );
}

function ExplainSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-stone-600 dark:text-stone-400">
        {title}
      </p>
      <p className="text-[11px] text-stone-700 dark:text-stone-300 mt-0.5 leading-relaxed">
        {children}
      </p>
    </div>
  );
}
