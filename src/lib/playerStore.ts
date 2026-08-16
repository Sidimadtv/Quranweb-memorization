import type { SurahAudio, VerseTiming } from "./audio";

export type PlayerSnapshot = {
  isPlaying: boolean;
  activeVerseKey: string | null;
  wordIndex: number | null;
  currentMs: number;
};

const INITIAL: PlayerSnapshot = {
  isPlaying: false,
  activeVerseKey: null,
  wordIndex: null,
  currentMs: 0,
};

export class PlayerStore {
  private listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot = INITIAL;
  private audio: HTMLAudioElement | null = null;
  private surahAudio: SurahAudio | null = null;
  private rafHandle: number | null = null;

  private stopOnVerseEnd: boolean = false;

  loadSurah(surahAudio: SurahAudio) {
    this.surahAudio = surahAudio;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    this.audio = null;
    this.update({ ...INITIAL });
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    if (!this.surahAudio) throw new Error("Surah audio not loaded");
    const a = new Audio(this.surahAudio.audioUrl);
    a.preload = "auto";
    a.addEventListener("play", () => {
      this.update({ ...this.snapshot, isPlaying: true });
      this.tick();
    });
    a.addEventListener("pause", () => {
      this.update({ ...this.snapshot, isPlaying: false });
      this.cancelTick();
    });
    a.addEventListener("ended", () => {
      this.cancelTick();
      this.update({ ...INITIAL });
    });
    this.audio = a;
    return a;
  }

  playFromVerse(verseKey: string, opts?: { singleVerse?: boolean }) {
    if (!this.surahAudio) return;
    const t = this.surahAudio.verseTimings.find((v) => v.verse_key === verseKey);
    if (!t) return;
    const a = this.ensureAudio();
    a.currentTime = t.timestamp_from / 1000;
    this.stopOnVerseEnd = !!opts?.singleVerse;
    void a.play();
  }

  playFullSurah() {
    if (!this.surahAudio) return;
    const a = this.ensureAudio();
    if (a.currentTime >= a.duration - 0.05) a.currentTime = 0;
    this.stopOnVerseEnd = false;
    void a.play();
  }

  togglePause() {
    if (!this.audio) {
      this.playFullSurah();
      return;
    }
    if (this.audio.paused) void this.audio.play();
    else this.audio.pause();
  }

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.cancelTick();
    this.update({ ...INITIAL });
  }

  private tick = () => {
    if (!this.audio || !this.surahAudio) return;
    const currentMs = Math.floor(this.audio.currentTime * 1000);
    const timing = findVerseAt(this.surahAudio.verseTimings, currentMs);

    if (this.stopOnVerseEnd && timing && currentMs >= timing.timestamp_to - 10) {
      this.audio.pause();
      this.audio.currentTime = timing.timestamp_to / 1000;
      this.stopOnVerseEnd = false;
      return;
    }

    let activeVerseKey: string | null = null;
    let wordIndex: number | null = null;
    if (timing) {
      activeVerseKey = timing.verse_key;
      wordIndex = wordIndexAtAbsolute(timing, currentMs);
    }
    if (
      activeVerseKey !== this.snapshot.activeVerseKey ||
      wordIndex !== this.snapshot.wordIndex
    ) {
      this.update({
        ...this.snapshot,
        isPlaying: !this.audio.paused,
        currentMs,
        activeVerseKey,
        wordIndex,
      });
    }
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private cancelTick() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private update(next: PlayerSnapshot) {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.snapshot;

  destroy() {
    this.cancelTick();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
    }
    this.audio = null;
    this.listeners.clear();
  }
}

function findVerseAt(
  timings: VerseTiming[],
  ms: number
): VerseTiming | null {
  for (const t of timings) {
    if (ms >= t.timestamp_from && ms <= t.timestamp_to) return t;
  }
  return null;
}

function wordIndexAtAbsolute(
  timing: VerseTiming,
  absoluteMs: number
): number | null {
  for (const [wordPos, startMs, endMs] of timing.segments) {
    if (absoluteMs >= startMs && absoluteMs <= endMs) return wordPos;
  }
  return null;
}
