const QDC_API = "https://api.qurancdn.com/api/qdc";

export type VerseTiming = {
  verse_key: string;
  timestamp_from: number;
  timestamp_to: number;
  duration: number;
  segments: [number, number, number][];
};

export type SurahAudio = {
  audioUrl: string;
  duration: number;
  verseTimings: VerseTiming[];
};

export async function fetchSurahAudio(
  reciterId: number,
  chapterId: number
): Promise<SurahAudio> {
  const res = await fetch(
    `${QDC_API}/audio/reciters/${reciterId}/audio_files?chapter=${chapterId}&segments=true`,
    { next: { revalidate: 60 * 60 * 24 * 30 } }
  );
  if (!res.ok) throw new Error(`Failed to fetch surah audio: ${res.status}`);
  const data = (await res.json()) as {
    audio_files: {
      audio_url: string;
      duration: number;
      verse_timings: VerseTiming[];
    }[];
  };
  const af = data.audio_files[0];
  if (!af) throw new Error("No audio file returned");
  return {
    audioUrl: af.audio_url,
    duration: af.duration,
    verseTimings: af.verse_timings,
  };
}

export function wordIndexAt(
  timing: VerseTiming,
  currentMs: number
): number | null {
  for (const [wordPos, startMs, endMs] of timing.segments) {
    if (currentMs >= startMs && currentMs <= endMs) return wordPos;
  }
  return null;
}
