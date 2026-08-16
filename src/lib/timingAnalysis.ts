// Per-word timing comparison: align the user's audio to the sheikh's audio
// via DTW on amplitude envelopes, project the sheikh's known word boundaries
// through the warp path, and surface "rushed" / "elongated" feedback.
//
// Amplitude envelope (not full MFCC) keeps this cheap enough to run in the
// main thread without bogging down the UI. Pitch/spectral nuance is lost,
// but for pacing & madd-duration feedback envelope alignment is enough.

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 400; // 25ms
const HOP_SAMPLES = 160; // 10ms
const HOP_MS = (HOP_SAMPLES / SAMPLE_RATE) * 1000; // 10
const BAND_FRAMES = 60; // Sakoe-Chiba band — limits warp factor to ~6x

export type WordTiming = {
  wordIdx: number; // 1-based word position in the ayah
  sheikhMs: number;
  userMs: number;
  ratio: number; // user / sheikh, 1.0 = same pace
  kind: "balanced" | "rushed" | "elongated";
  feedback?: string;
};

export type TimingReport = {
  userTotalMs: number;
  sheikhTotalMs: number;
  totalRatio: number;
  perWord: WordTiming[];
};

export async function blobToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new Ctx({ sampleRate: SAMPLE_RATE });
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    return decoded.getChannelData(0).slice();
  } finally {
    void ctx.close();
  }
}

// ── Sheikh audio cache ────────────────────────────────────────────────
const pcmCache = new Map<string, Promise<Float32Array>>();

export function getSheikhSurahPCM(audioUrl: string): Promise<Float32Array> {
  if (!pcmCache.has(audioUrl)) {
    pcmCache.set(
      audioUrl,
      (async () => {
        const res = await fetch(audioUrl);
        if (!res.ok) throw new Error(`Sheikh audio fetch failed (${res.status})`);
        const buf = await res.arrayBuffer();
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx({ sampleRate: SAMPLE_RATE });
        try {
          const decoded = await ctx.decodeAudioData(buf);
          return decoded.getChannelData(0).slice();
        } finally {
          void ctx.close();
        }
      })().catch((err) => {
        pcmCache.delete(audioUrl);
        throw err;
      })
    );
  }
  return pcmCache.get(audioUrl)!;
}

export function sliceAyahPCM(
  surahPcm: Float32Array,
  startMs: number,
  endMs: number
): Float32Array {
  const start = Math.max(0, Math.floor((startMs / 1000) * SAMPLE_RATE));
  const end = Math.min(
    surahPcm.length,
    Math.floor((endMs / 1000) * SAMPLE_RATE)
  );
  return surahPcm.slice(start, end);
}

// ── Envelope ──────────────────────────────────────────────────────────
function computeEnvelope(audio: Float32Array): Float32Array {
  if (audio.length < FRAME_SAMPLES) return new Float32Array(0);
  const numFrames = Math.floor((audio.length - FRAME_SAMPLES) / HOP_SAMPLES) + 1;
  const out = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const start = i * HOP_SAMPLES;
    let sumSquares = 0;
    for (let j = 0; j < FRAME_SAMPLES; j++) {
      const v = audio[start + j];
      sumSquares += v * v;
    }
    out[i] = Math.sqrt(sumSquares / FRAME_SAMPLES);
  }
  // Normalize so amplitude scaling doesn't dominate DTW cost
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  if (max > 0.0001) {
    for (let i = 0; i < out.length; i++) out[i] /= max;
  }
  return out;
}

// ── DTW with Sakoe-Chiba band ────────────────────────────────────────
function dtwPath(a: Float32Array, b: Float32Array): number[][] {
  const N = a.length;
  const M = b.length;
  if (N === 0 || M === 0) return [];

  // We only need two rows of cost at a time, but we need the full backpointer
  // grid for traceback. Compact backpointers as Uint8: 0=diag, 1=up, 2=left.
  const cost = new Float32Array((N + 1) * (M + 1));
  cost.fill(Infinity);
  cost[0] = 0;
  const back = new Uint8Array((N + 1) * (M + 1));

  const idx = (i: number, j: number) => i * (M + 1) + j;

  for (let i = 1; i <= N; i++) {
    const jMin = Math.max(1, i - BAND_FRAMES);
    const jMax = Math.min(M, i + BAND_FRAMES);
    for (let j = jMin; j <= jMax; j++) {
      const d = Math.abs(a[i - 1] - b[j - 1]);
      const c00 = cost[idx(i - 1, j - 1)];
      const c10 = cost[idx(i - 1, j)];
      const c01 = cost[idx(i, j - 1)];
      let best = c00;
      let dir = 0;
      if (c10 < best) {
        best = c10;
        dir = 1;
      }
      if (c01 < best) {
        best = c01;
        dir = 2;
      }
      cost[idx(i, j)] = d + best;
      back[idx(i, j)] = dir;
    }
  }

  const path: number[][] = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const dir = back[idx(i, j)];
    if (dir === 0) {
      i--;
      j--;
    } else if (dir === 1) {
      i--;
    } else {
      j--;
    }
  }
  path.reverse();
  return path;
}

// ── Analysis ──────────────────────────────────────────────────────────
export function analyzeTiming(
  userPcm: Float32Array,
  sheikhPcm: Float32Array,
  sheikhSegments: [number, number, number][] // [wordPos, startMsAbs, endMsAbs]
): TimingReport {
  const userEnv = computeEnvelope(userPcm);
  const sheikhEnv = computeEnvelope(sheikhPcm);

  // Build sheikh-frame → user-frame map by walking the DTW path
  // (use the last user frame seen for each sheikh frame)
  const sheikhToUserFrame = new Int32Array(sheikhEnv.length);
  sheikhToUserFrame.fill(-1);
  const path = dtwPath(userEnv, sheikhEnv);
  for (const [u, s] of path) sheikhToUserFrame[s] = u;
  // Forward-fill any gaps
  let last = 0;
  for (let s = 0; s < sheikhToUserFrame.length; s++) {
    if (sheikhToUserFrame[s] === -1) sheikhToUserFrame[s] = last;
    else last = sheikhToUserFrame[s];
  }

  // Sheikh segments use absolute ms within the surah; the caller has already
  // sliced the PCM to start at 0. Find the offset from the first segment.
  const segmentOffsetMs =
    sheikhSegments.length > 0 ? sheikhSegments[0][1] : 0;

  const perWord: WordTiming[] = [];
  for (const [wordPos, startMsAbs, endMsAbs] of sheikhSegments) {
    const segStartMs = startMsAbs - segmentOffsetMs;
    const segEndMs = endMsAbs - segmentOffsetMs;
    const sheikhStartFrame = Math.max(
      0,
      Math.min(sheikhEnv.length - 1, Math.floor(segStartMs / HOP_MS))
    );
    const sheikhEndFrame = Math.max(
      0,
      Math.min(sheikhEnv.length - 1, Math.floor(segEndMs / HOP_MS))
    );
    const userStartFrame = sheikhToUserFrame[sheikhStartFrame];
    const userEndFrame = sheikhToUserFrame[sheikhEndFrame];
    const sheikhMs = segEndMs - segStartMs;
    const userMs = Math.max(0, (userEndFrame - userStartFrame) * HOP_MS);
    const ratio = sheikhMs > 0 ? userMs / sheikhMs : 1;
    let kind: WordTiming["kind"] = "balanced";
    let feedback: string | undefined;
    if (ratio < 0.55) {
      kind = "rushed";
      feedback = `Rushed — you took ${Math.round(ratio * 100)}% of the sheikh's duration.`;
    } else if (ratio > 1.8) {
      kind = "elongated";
      feedback = `Elongated — you took ${Math.round(ratio * 100)}% of the sheikh's duration.`;
    }
    perWord.push({
      wordIdx: wordPos,
      sheikhMs,
      userMs,
      ratio,
      kind,
      feedback,
    });
  }

  const userTotalMs = (userPcm.length / SAMPLE_RATE) * 1000;
  const sheikhTotalMs = (sheikhPcm.length / SAMPLE_RATE) * 1000;

  return {
    userTotalMs,
    sheikhTotalMs,
    totalRatio: sheikhTotalMs > 0 ? userTotalMs / sheikhTotalMs : 1,
    perWord,
  };
}
