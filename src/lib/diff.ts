export type DiffStatus = "correct" | "wrong" | "missed" | "extra";

export type DiffToken = {
  expected: string | null;
  actual: string | null;
  status: DiffStatus;
};

const TASHKEEL = /[ً-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TATWEEL = /ـ/g;

export function normalizeArabic(s: string): string {
  return s
    .replace(TASHKEEL, "")
    .replace(TATWEEL, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeArabic(s).split(" ").filter(Boolean);
}

export function diffRecitation(
  expectedRaw: string,
  actualRaw: string
): DiffToken[] {
  const expected = tokenize(expectedRaw);
  const actual = tokenize(actualRaw);
  const m = expected.length;
  const n = actual.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        expected[i - 1] === actual[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops: DiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (expected[i - 1] === actual[j - 1]) {
      ops.push({ expected: expected[i - 1], actual: actual[j - 1], status: "correct" });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ expected: expected[i - 1], actual: null, status: "missed" });
      i--;
    } else {
      ops.push({ expected: null, actual: actual[j - 1], status: "extra" });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ expected: expected[i - 1], actual: null, status: "missed" });
    i--;
  }
  while (j > 0) {
    ops.push({ expected: null, actual: actual[j - 1], status: "extra" });
    j--;
  }

  ops.reverse();
  return collapseAdjacentMissedExtraToWrong(ops);
}

function collapseAdjacentMissedExtraToWrong(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const cur = tokens[k];
    const next = tokens[k + 1];
    if (
      next &&
      ((cur.status === "missed" && next.status === "extra") ||
        (cur.status === "extra" && next.status === "missed"))
    ) {
      const expected = cur.status === "missed" ? cur.expected : next.expected;
      const actual = cur.status === "extra" ? cur.actual : next.actual;
      out.push({ expected, actual, status: "wrong" });
      k++;
    } else {
      out.push(cur);
    }
  }
  return out;
}

export function accuracyScore(tokens: DiffToken[]): number {
  if (tokens.length === 0) return 0;
  const denom = tokens.filter((t) => t.status !== "extra").length;
  if (denom === 0) return 0;
  const correct = tokens.filter((t) => t.status === "correct").length;
  return Math.round((correct / denom) * 100);
}

/**
 * Walks the diff tokens in order and returns alignment[userWordIdx] = expectedWordIdx | -1.
 * Both indices are 0-based into their respective normalized-and-tokenized arrays.
 * Use this to know which expected word the user was reciting at a given user-audio time.
 */
export function alignUserToExpected(tokens: DiffToken[]): number[] {
  const alignment: number[] = [];
  let expectedIdx = 0;
  let userIdx = 0;
  for (const t of tokens) {
    switch (t.status) {
      case "correct":
      case "wrong":
        alignment[userIdx] = expectedIdx;
        expectedIdx += 1;
        userIdx += 1;
        break;
      case "missed":
        expectedIdx += 1;
        break;
      case "extra":
        alignment[userIdx] = -1;
        userIdx += 1;
        break;
    }
  }
  return alignment;
}

/**
 * Given an array of {start,end} word timings (in seconds) and a current playback time,
 * return the index of the word currently being spoken, or -1 if outside any word.
 */
export function wordIndexAtTime(
  words: { start: number; end: number }[],
  timeSec: number
): number {
  for (let i = 0; i < words.length; i++) {
    if (timeSec >= words[i].start && timeSec <= words[i].end) return i;
  }
  return -1;
}
