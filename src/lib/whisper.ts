// Tarteel Whisper-base fine-tuned on Quran recitation. Community ONNX export
// by TMSH75 at q8 quantization (~98 MB total: 76 MB merged decoder + 22 MB
// encoder). Loaded once per browser tab via @huggingface/transformers; cached
// in IndexedDB after first download. All inference runs in-browser.
//
// The base variant is significantly more accurate than tiny on Quranic Arabic
// — particularly on short ayat with limited acoustic context (e.g. Al-Ikhlas
// ayah 2 was a common tiny false-negative).
//
// Note: many community exports (including aaqibhabib's) ship a botched
// generation_config that pins is_multilingual:false, which makes
// Transformers.js refuse any language= override. TMSH75 ships the bare
// post-fine-tune config which lets the multilingual encoder do its thing
// without complaints.

const MODEL_ID = "TMSH75/whisper-base-ar-quran-onnx";

export type LoadStatus =
  | { kind: "idle" }
  | { kind: "loading"; progress: number; file?: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type WordTiming = {
  text: string;
  start: number; // seconds
  end: number; // seconds
};

export type TranscriptionResult = {
  text: string;
  words: WordTiming[];
};

type PipelineOutput = {
  text?: string;
  chunks?: { text: string; timestamp: [number | null, number | null] }[];
};

type Pipeline = (
  input: Float32Array,
  opts?: Record<string, unknown>
) => Promise<PipelineOutput | PipelineOutput[]>;

let pipelinePromise: Promise<Pipeline> | null = null;
let cached: Pipeline | null = null;

export async function loadWhisper(
  onStatus?: (s: LoadStatus) => void
): Promise<Pipeline> {
  if (cached) {
    onStatus?.({ kind: "ready" });
    return cached;
  }
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      onStatus?.({ kind: "loading", progress: 0 });
      const { pipeline } = await import("@huggingface/transformers");
      const pipe = (await pipeline(
        "automatic-speech-recognition",
        MODEL_ID,
        {
          dtype: "q8",
          progress_callback: (data: unknown) => {
            const d = data as {
              status?: string;
              progress?: number;
              file?: string;
            };
            if (d.status === "progress" || d.status === "downloading") {
              onStatus?.({
                kind: "loading",
                progress: Math.round(d.progress ?? 0),
                file: d.file,
              });
            }
          },
        }
      )) as unknown as Pipeline;
      cached = pipe;
      onStatus?.({ kind: "ready" });
      return pipe;
    })().catch((err: unknown) => {
      pipelinePromise = null;
      const message = err instanceof Error ? err.message : "Model load failed";
      onStatus?.({ kind: "error", message });
      throw err;
    });
  }
  return pipelinePromise;
}

export async function transcribe(
  audioBlob: Blob,
  options?: { onStatus?: (s: LoadStatus) => void }
): Promise<string> {
  const pipe = await loadWhisper(options?.onStatus);
  const audioData = await blobToMono16k(audioBlob);
  const normalized = peakNormalize(audioData);
  const out = await pipe(normalized, {
    chunk_length_s: 30,
  });
  const result = Array.isArray(out) ? out[0] : out;
  return (result?.text ?? "").trim();
}

export async function transcribeWithTimings(
  audioBlob: Blob,
  options?: { onStatus?: (s: LoadStatus) => void }
): Promise<TranscriptionResult> {
  const pipe = await loadWhisper(options?.onStatus);
  const audioData = await blobToMono16k(audioBlob);
  return runWithTimings(pipe, audioData);
}

export async function transcribeFloat32WithTimings(
  audioData: Float32Array
): Promise<TranscriptionResult> {
  if (!cached) {
    throw new Error("Whisper not loaded yet");
  }
  return runWithTimings(cached, audioData);
}

// `wordTimingsSupported` is set to false on first failure so we don't keep
// re-trying the expensive path for the rest of the session. Many community
// ONNX exports of Whisper (including the Tarteel tiny build) skip the
// cross-attentions that Transformers.js needs for word-level timestamps.
let wordTimingsSupported = true;

async function runWithTimings(
  pipe: Pipeline,
  audioData: Float32Array
): Promise<TranscriptionResult> {
  const normalized = peakNormalize(audioData);
  const durationSec = audioData.length / 16000;

  if (wordTimingsSupported) {
    try {
      const out = await pipe(normalized, {
        chunk_length_s: 30,
        return_timestamps: "word",
      });
      const result = Array.isArray(out) ? out[0] : out;
      const text = (result?.text ?? "").trim();
      const words: WordTiming[] = [];
      for (const chunk of result?.chunks ?? []) {
        const t = (chunk.text ?? "").trim();
        if (!t) continue;
        const [start, end] = chunk.timestamp;
        if (start === null || end === null) continue;
        words.push({ text: t, start, end });
      }
      if (words.length > 0) return { text, words };
      // Word path returned no usable chunks; fall through to synthesized timings
      return { text, words: synthesizeWordTimings(text, durationSec) };
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      // Any error tied to the model not supporting word-level timestamps —
      // fall through to the text-only path and synthesize timings. Re-throw
      // anything that looks like a genuine transcription failure.
      const isTimestampError =
        msg.includes("cross attentions") ||
        msg.includes("output_attentions") ||
        msg.includes("alignment_heads") ||
        msg.includes("token-level timestamps") ||
        msg.includes("return_timestamps");
      if (isTimestampError) {
        wordTimingsSupported = false;
      } else {
        throw err;
      }
    }
  }

  const out = await pipe(normalized, {
    chunk_length_s: 30,
  });
  const result = Array.isArray(out) ? out[0] : out;
  const text = (result?.text ?? "").trim();
  return { text, words: synthesizeWordTimings(text, durationSec) };
}

/** When the ONNX model doesn't expose cross-attentions for word timestamps,
 *  fall back to evenly distributing the recognized words across the audio
 *  duration. Not phoneme-accurate, but plenty good enough for follow-along
 *  replay highlighting and "you're around here" live indicators. */
function synthesizeWordTimings(
  text: string,
  durationSec: number
): WordTiming[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || durationSec <= 0) return [];
  const perWord = durationSec / tokens.length;
  return tokens.map((token, i) => ({
    text: token,
    start: i * perWord,
    end: (i + 1) * perWord,
  }));
}

export function hasNativeWordTimings(): boolean {
  return wordTimingsSupported;
}

/** Scale audio so its peak is around 0.7. Helps Whisper on quiet recordings
 *  without amplifying when the audio is already loud enough. Leaves true
 *  silence alone so it doesn't blow up the noise floor. */
function peakNormalize(audio: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const abs = Math.abs(audio[i]);
    if (abs > peak) peak = abs;
  }
  if (peak < 0.001) return audio; // basically silent — don't amplify noise
  if (peak >= 0.7) return audio; // already loud enough
  const scale = 0.7 / peak;
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * scale;
  return out;
}

async function blobToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)
      : null;
  if (!Ctx) throw new Error("AudioContext not available in this environment");
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    return decoded.getChannelData(0);
  } finally {
    void ctx.close();
  }
}

export function isWhisperLoaded(): boolean {
  return cached !== null;
}
