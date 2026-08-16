"use client";

import { useEffect, useRef, useState } from "react";

// First-load intro overlay. Black background, بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ
// rendered in Amiri Quran with a slow 3D flag sway. The recitation of 1:1
// (Mishary, EveryAyah) plays via a hidden <audio> element. When the audio
// finishes, the text fades, a brief black hold passes, then the black
// background fades to reveal the platform.
//
// On dismiss we dispatch `hifz-intro-done` so the ModelPreloader can defer
// its 98 MB Whisper download until the animation isn't competing for
// CPU/network with it.

const AUDIO_URL = "https://everyayah.com/data/Alafasy_128kbps/001001.mp3";
const TEXT_REVEAL_MS = 500;
const TEXT_FADE_MS = 700;
const BLACK_HOLD_MS = 250;
const PLATFORM_FADE_MS = 900;
const TEXT_REVEAL_SAFETY_MS = 2000;
const FALLBACK_HOLD_MS = 5000;

export const INTRO_DONE_EVENT = "hifz-intro-done";

export function IntroOverlay() {
  const [show, setShow] = useState(true);
  const [textRevealed, setTextRevealed] = useState(false);
  const [textFading, setTextFading] = useState(false);
  const [bgFading, setBgFading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const startedRef = useRef(false);
  const dismissedRef = useRef(false);
  const introDoneFiredRef = useRef(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function pushTimer(id: number) {
      timersRef.current.push(id);
    }

    function fireIntroDone() {
      if (introDoneFiredRef.current) return;
      introDoneFiredRef.current = true;
      window.dispatchEvent(new CustomEvent(INTRO_DONE_EVENT));
    }

    function reveal() {
      if (startedRef.current) return;
      startedRef.current = true;
      setTextRevealed(true);
    }

    function dismiss() {
      if (dismissedRef.current) return;
      dismissedRef.current = true;
      fireIntroDone();
      setTextFading(true);
      pushTimer(
        window.setTimeout(() => {
          setBgFading(true);
          pushTimer(
            window.setTimeout(() => {
              audioRef.current?.pause();
              setShow(false);
            }, PLATFORM_FADE_MS)
          );
        }, TEXT_FADE_MS + BLACK_HOLD_MS)
      );
    }

    const audioEl = audio;
    const onPlaying = () => reveal();
    const onEnded = () => dismiss();
    const onError = () => {
      reveal();
      pushTimer(window.setTimeout(dismiss, FALLBACK_HOLD_MS));
    };

    audioEl.addEventListener("playing", onPlaying);
    audioEl.addEventListener("ended", onEnded);
    audioEl.addEventListener("error", onError);

    // Attempt autoplay. If blocked, fall through to a visual-only path.
    void audioEl.play().catch(() => {
      reveal();
      pushTimer(window.setTimeout(dismiss, FALLBACK_HOLD_MS));
    });

    // Reveal safety: if audio takes too long to actually start playing
    // (slow network), show the text anyway so the user isn't staring at
    // black.
    pushTimer(
      window.setTimeout(() => {
        if (!startedRef.current) {
          reveal();
          if (!dismissedRef.current) {
            pushTimer(window.setTimeout(dismiss, FALLBACK_HOLD_MS));
          }
        }
      }, TEXT_REVEAL_SAFETY_MS)
    );

    return () => {
      audioEl.removeEventListener("playing", onPlaying);
      audioEl.removeEventListener("ended", onEnded);
      audioEl.removeEventListener("error", onError);
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current = [];
      audioEl.pause();
    };
  }, []);

  function skip() {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    if (!introDoneFiredRef.current) {
      introDoneFiredRef.current = true;
      window.dispatchEvent(new CustomEvent(INTRO_DONE_EVENT));
    }
    setTextFading(true);
    timersRef.current.push(
      window.setTimeout(() => {
        setBgFading(true);
        timersRef.current.push(
          window.setTimeout(() => {
            audioRef.current?.pause();
            setShow(false);
          }, PLATFORM_FADE_MS)
        );
      }, TEXT_FADE_MS + BLACK_HOLD_MS)
    );
  }

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bismillah"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black"
      style={{
        opacity: bgFading ? 0 : 1,
        transition: `opacity ${PLATFORM_FADE_MS}ms ease-out`,
      }}
    >
      {/* Hidden <audio> — no crossOrigin attr so EveryAyah loads without
          needing CORS headers. preload="auto" hints the browser to fetch
          immediately so 'playing' can fire as soon as autoplay clears. */}
      <audio
        ref={audioRef}
        src={AUDIO_URL}
        preload="auto"
        playsInline
        style={{ display: "none" }}
      />

      {textRevealed && (
        <span
          className="intro-bismillah"
          aria-hidden="true"
          style={{
            opacity: textFading ? 0 : 1,
            transition: textFading
              ? `opacity ${TEXT_FADE_MS}ms ease-out`
              : `opacity ${TEXT_REVEAL_MS}ms ease-out`,
          }}
        >
          بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ
        </span>
      )}
      <button
        type="button"
        onClick={skip}
        className="absolute bottom-6 right-6 text-[11px] uppercase tracking-wider text-white/55 hover:text-white/90 transition-colors px-2 py-1"
        aria-label="Skip intro"
      >
        skip
      </button>
    </div>
  );
}
