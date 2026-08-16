import type { Verse } from "./quran";
import { transcribeWithTimings, type WordTiming } from "./whisper";

export type ContinuousCallbacks = {
  onCalibrationStart?: () => void;
  onCalibrationComplete?: (threshold: number) => void;
  onActiveVerseChanged: (verseNumber: number | null) => void;
  onTranscribing: (verseNumber: number) => void;
  onResult: (
    verseNumber: number,
    transcript: string,
    audioBlob: Blob,
    words: WordTiming[]
  ) => void;
  onError: (verseNumber: number | null, message: string) => void;
  onComplete: () => void;
  onMicLevel?: (level: number, threshold: number, isSilent: boolean) => void;
};

export type ContinuousHandle = {
  stop: () => void;
  skipCurrent: () => void;
};

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

export async function startContinuousRecite(opts: {
  verses: Verse[];
  startIndex?: number;
  silenceDurationMs?: number;
  minSegmentMs?: number;
  sessionCancelMs?: number;
  callbacks: ContinuousCallbacks;
}): Promise<ContinuousHandle> {
  const startIndex = opts.startIndex ?? 0;
  const SILENCE_DURATION_MS = opts.silenceDurationMs ?? 900;
  const MIN_SEGMENT_MS = opts.minSegmentMs ?? 700;
  const VOICE_TO_START_MS = 250;
  const SESSION_CANCEL_SILENCE_MS = opts.sessionCancelMs ?? 2000;
  const CALIBRATION_MS = 700;
  const MIN_THRESHOLD = 0.015;
  const MAX_THRESHOLD = 0.05;
  const THRESHOLD_MULTIPLIER = 2.5;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    },
  });

  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const audioContext = new AudioCtx();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const timeData = new Uint8Array(analyser.frequencyBinCount);

  let stopped = false;

  function computeRms(): number {
    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / timeData.length);
  }

  // ── PHASE 1: Calibration ────────────────────────────────────────────
  opts.callbacks.onCalibrationStart?.();
  const silenceThreshold = await new Promise<number>((resolve) => {
    const samples: number[] = [];
    const start = performance.now();
    function tick() {
      if (stopped) {
        resolve(MIN_THRESHOLD);
        return;
      }
      const rms = computeRms();
      samples.push(rms);
      opts.callbacks.onMicLevel?.(rms, MIN_THRESHOLD, false);
      if (performance.now() - start < CALIBRATION_MS) {
        requestAnimationFrame(tick);
      } else {
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)] ?? MIN_THRESHOLD;
        const computed = Math.min(
          MAX_THRESHOLD,
          Math.max(MIN_THRESHOLD, median * THRESHOLD_MULTIPLIER)
        );
        resolve(computed);
      }
    }
    requestAnimationFrame(tick);
  });
  opts.callbacks.onCalibrationComplete?.(silenceThreshold);

  if (stopped) {
    stream.getTracks().forEach((t) => t.stop());
    if (audioContext.state !== "closed") void audioContext.close();
    opts.callbacks.onComplete();
    return { stop: () => {}, skipCurrent: () => {} };
  }

  // ── PHASE 2: Recording loop ─────────────────────────────────────────
  let currentIndex = startIndex;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let silenceStart: number | null = null;
  let segmentStart = 0;
  let transitioning = false;
  let rafHandle: number | null = null;
  let voiceStreakStart: number | null = null;
  let hasStartedSpeaking = false;
  // Session-level silence tracker — persists across segment boundaries so
  // total continuous silence (including transitions) can trigger auto-cancel.
  let sessionSilenceStart: number | null = null;
  let hasSpokenInSession = false;

  function startSegment() {
    if (stopped || currentIndex >= opts.verses.length) return;
    chunks = [];
    silenceStart = null;
    segmentStart = performance.now();
    voiceStreakStart = null;
    hasStartedSpeaking = false;
    const mime = pickMimeType();
    const r = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined
    );
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    r.onstop = () => {
      const myVerseNumber = opts.verses[currentIndex].verse_number;
      const blob = new Blob(chunks, {
        type: r.mimeType || "audio/webm",
      });

      if (!stopped) {
        opts.callbacks.onTranscribing(myVerseNumber);
        transcribeWithTimings(blob)
          .then(({ text, words }) =>
            opts.callbacks.onResult(
              myVerseNumber,
              text.trim(),
              blob,
              words
            )
          )
          .catch((err) => {
            opts.callbacks.onError(
              myVerseNumber,
              err instanceof Error ? err.message : "Transcription failed."
            );
            opts.callbacks.onResult(myVerseNumber, "", blob, []);
          });

        currentIndex++;
        if (currentIndex < opts.verses.length) {
          opts.callbacks.onActiveVerseChanged(
            opts.verses[currentIndex].verse_number
          );
          startSegment();
        } else {
          finalize();
        }
      } else {
        finalize();
      }
      transitioning = false;
    };
    recorder = r;
    r.start();
    opts.callbacks.onActiveVerseChanged(
      opts.verses[currentIndex].verse_number
    );
  }

  function tick() {
    if (stopped) return;
    rafHandle = requestAnimationFrame(tick);

    const rms = computeRms();
    const now = performance.now();

    const isSilent = rms < silenceThreshold;
    opts.callbacks.onMicLevel?.(rms, silenceThreshold, isSilent);

    // Session-level silence tracking (runs regardless of segment state so it
    // spans the brief transitioning window between ayat).
    if (isSilent) {
      if (sessionSilenceStart === null) sessionSilenceStart = now;
    } else {
      sessionSilenceStart = null;
    }
    if (
      hasSpokenInSession &&
      sessionSilenceStart !== null &&
      now - sessionSilenceStart > SESSION_CANCEL_SILENCE_MS
    ) {
      stop();
      return;
    }

    if (transitioning || !recorder || recorder.state !== "recording") return;

    if (isSilent) {
      voiceStreakStart = null;
      if (!hasStartedSpeaking) return;
      if (silenceStart === null) silenceStart = now;
      else if (
        now - silenceStart > SILENCE_DURATION_MS &&
        now - segmentStart > MIN_SEGMENT_MS
      ) {
        transitioning = true;
        recorder.stop();
      }
    } else {
      silenceStart = null;
      if (voiceStreakStart === null) voiceStreakStart = now;
      else if (now - voiceStreakStart >= VOICE_TO_START_MS) {
        hasStartedSpeaking = true;
        hasSpokenInSession = true;
      }
    }
  }

  function finalize() {
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    stream.getTracks().forEach((t) => t.stop());
    if (audioContext.state !== "closed") void audioContext.close();
    opts.callbacks.onActiveVerseChanged(null);
    opts.callbacks.onComplete();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    } else {
      finalize();
    }
  }

  function skipCurrent() {
    if (
      stopped ||
      transitioning ||
      !recorder ||
      recorder.state !== "recording"
    )
      return;
    transitioning = true;
    recorder.stop();
  }

  startSegment();
  tick();

  return { stop, skipCurrent };
}
