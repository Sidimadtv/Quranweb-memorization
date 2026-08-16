// Arabic grapheme parsing + letter/diacritic comparison for actionable
// recitation feedback (e.g. "missing tanween", "damma instead of fatha",
// "wrong letter ث vs س"). Compares ASR output to the expected Uthmani text
// at character level, not word level.

export type Grapheme = {
  letter: string;
  marks: string[];
  raw: string;
};

const ZERO_WIDTH = /[​-‏﻿]/g;
const TATWEEL = /ـ/g;

// Marks that ACTUALLY affect pronunciation — these participate in the diff.
const PHONETIC_MARK_RANGES: [number, number][] = [
  [0x064b, 0x065f], // tashkeel + tanween + sukun + dagger alif neighbors
  [0x0670, 0x0670], // dagger alif (long aa sound)
];

// Quranic typographic annotations — stop signs, iqlab markers (ۢ), small
// waws (ۥ), etc. These are guidance for the reciter, not phonetic content.
// Whisper transcribes plain Arabic and will never output these, so leaving
// them in the comparison guarantees false "missing mark" errors.
const QURANIC_ANNOTATION_RANGE: [number, number] = [0x06d6, 0x06ed];

function isPhoneticMark(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0)!;
  for (const [lo, hi] of PHONETIC_MARK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

function isQuranicAnnotation(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0)!;
  return code >= QURANIC_ANNOTATION_RANGE[0] && code <= QURANIC_ANNOTATION_RANGE[1];
}

function isMark(ch: string): boolean {
  return isPhoneticMark(ch) || isQuranicAnnotation(ch);
}

/** Strip everything that isn't a letter or recognized diacritic. */
function clean(s: string): string {
  return s.replace(ZERO_WIDTH, "").replace(TATWEEL, "");
}

/** Split a string into graphemes. Each grapheme = 1 base letter + any
 *  diacritics that follow it (until the next base letter or whitespace).
 *  Whitespace becomes its own "word boundary" grapheme with letter=" ". */
export function parseGraphemes(input: string): Grapheme[] {
  const s = clean(input);
  const out: Grapheme[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      out.push({ letter: " ", marks: [], raw: " " });
      i++;
      continue;
    }
    if (isMark(ch)) {
      // Orphan mark with no preceding letter — skip
      i++;
      continue;
    }
    const letter = ch;
    const marks: string[] = [];
    let j = i + 1;
    while (j < s.length) {
      const c = s[j];
      if (isPhoneticMark(c)) {
        marks.push(c);
        j++;
      } else if (isQuranicAnnotation(c)) {
        // skip — typographic only, not in Whisper's output anyway
        j++;
      } else {
        break;
      }
    }
    out.push({ letter, marks, raw: letter + marks.join("") });
    i = j;
  }
  return out;
}

// ── Mark equivalence ────────────────────────────────────────────────────
const REAL_VOWELS = new Set(["َ", "ُ", "ِ", "ً", "ٌ", "ٍ"]);
const SUKUN_CHAR = "ْ";

/** Bare consonant (no vowel mark) is functionally noon-sakinah / sukoon by
 *  Mushaf convention. Whisper sometimes outputs explicit sukoon, sometimes
 *  not — both forms mean the same thing. Normalize so they compare equal. */
function normalizeMarks(marks: string[]): string[] {
  const hasVowel = marks.some((m) => REAL_VOWELS.has(m));
  if (!hasVowel && !marks.includes(SUKUN_CHAR)) {
    return [...marks, SUKUN_CHAR];
  }
  return marks;
}

// Normalize equivalent letter forms (alif variants, ya/alif maqsura, ta marbuta/ha)
const LETTER_EQUIV: Record<string, string> = {
  "آ": "ا", // آ → ا
  "أ": "ا", // أ → ا
  "إ": "ا", // إ → ا
  "ٱ": "ا", // ٱ → ا
  "ى": "ي", // ى → ي
  "ؤ": "و", // ؤ → و
  "ئ": "ي", // ئ → ي
};

function canonicalLetter(letter: string): string {
  return LETTER_EQUIV[letter] ?? letter;
}

// ── Mark naming for human-readable feedback ─────────────────────────────
const MARK_NAME: Record<string, string> = {
  "َ": "fatha",
  "ُ": "damma",
  "ِ": "kasra",
  "ْ": "sukun",
  "ّ": "shadda",
  "ً": "fathatan",
  "ٌ": "dammatan",
  "ٍ": "kasratan",
  "ٰ": "dagger-alif",
};

const MARK_ENGLISH: Record<string, string> = {
  "َ": "fatha (◌َ — short 'a')",
  "ُ": "damma (◌ُ — short 'u')",
  "ِ": "kasra (◌ِ — short 'i')",
  "ْ": "sukun (◌ْ — no vowel)",
  "ّ": "shadda (◌ّ — doubled letter)",
  "ً": "tanween fath (◌ً — 'an' ending)",
  "ٌ": "tanween damm (◌ٌ — 'un' ending)",
  "ٍ": "tanween kasr (◌ٍ — 'in' ending)",
  "ٰ": "dagger alif (long 'aa')",
};

function describeMark(mark: string): string {
  return MARK_ENGLISH[mark] ?? `mark (${mark.codePointAt(0)?.toString(16)})`;
}

function describeMarkShort(mark: string): string {
  return MARK_NAME[mark] ?? mark;
}

// ── Letter-confusion table (Stage 5 seed) ───────────────────────────────
// Common substitutions when Arabic phonemes don't exist in the speaker's L1.
const LETTER_TIPS: Record<string, string> = {
  // Dental fricatives ↔ alveolar fricatives
  "س->ث":
    "siin (س) → thaa (ث): touch the tip of your tongue between your front teeth.",
  "ث->س":
    "thaa (ث) → siin (س): you held it like /s/, but ث needs the tongue between the teeth.",
  "ش->س":
    "shiin (ش) → siin (س): tongue moved forward. Push it back a bit and round the air.",
  "ز->ذ":
    "zaay (ز) → dhaal (ذ): they're both voiced sibilants but ذ puts the tongue between teeth.",
  "ذ->ز":
    "dhaal (ذ) → zaay (ز): tongue should be between teeth (like 'th' in 'this'), not behind them.",
  "ذ->د":
    "dhaal (ذ) → daal (د): ذ is the voiced 'th' (this). Don't make it a stop.",
  "د->ذ":
    "daal (د) → dhaal (ذ): د is a stop, not a fricative. Tongue tip against teeth ridge, no air leak.",
  // Throat letters (often the hardest for non-Arabic speakers)
  "ه->ح":
    "haa (ه) → ḥaa (ح): ح is deeper in the throat, breathy but not pharyngeal.",
  "ح->ه":
    "ḥaa (ح) → haa (ه): pull the air from your upper throat, not your mouth.",
  "خ->ح":
    "khaa (خ) → ḥaa (ح): خ is the rasping back-throat sound, ح is breathier and lighter.",
  "ح->خ":
    "ḥaa (ح) → khaa (خ): you added rasp. ح is voiceless, breathy, no scraping.",
  "خ->ك":
    "khaa (خ) → kaaf (ك): you said the stop instead of the fricative. خ should have airflow.",
  "ك->خ":
    "kaaf (ك) → khaa (خ): you let air escape continuously. ك is a clean stop.",
  "غ->ر":
    "ghayn (غ) → raa (ر): غ is back-of-throat like a soft French 'r' — not a tongue tap.",
  "ر->غ":
    "raa (ر) → ghayn (غ): ر is a tongue tap on the ridge, not the throat.",
  // Hamza ↔ ʿAyn confusion (very common)
  "أ->ع":
    "hamza (ء) → ʿayn (ع): ع comes from the middle of the throat, hamza is just a glottal stop.",
  "ع->أ":
    "ʿayn (ع) → hamza (ء): you flattened ع. Constrict the middle of the throat.",
  "ع->غ":
    "ʿayn (ع) → ghayn (غ): both throat letters but ع is voiced without scraping; غ has the scrape.",
  // Velar/uvular stops
  "ك->ق":
    "kaaf (ك) → qaaf (ق): ق is much deeper — back of the tongue against the uvula.",
  "ق->ك":
    "qaaf (ق) → kaaf (ك): you said it forward; ق is pulled all the way back.",
  // Emphatics (heavy letters) — common L1 confusion losing the heaviness
  "د->ض":
    "daal (د) → ḍaad (ض): ض is heavy/emphatic. Tongue covers more roof of mouth.",
  "ض->د":
    "ḍaad (ض) → daal (د): you lost the emphasis. ض needs the tongue to spread heavy.",
  "ت->ط":
    "taa (ت) → ṭaa (ط): ط is the emphatic version. Tongue tip + lots of weight.",
  "ط->ت":
    "ṭaa (ط) → taa (ت): you said the light version. ط is heavy.",
  "ز->ظ":
    "zaay (ز) → ẓaa (ظ): ظ is emphatic and uses 'th' shape (between teeth).",
  "ظ->ز":
    "ẓaa (ظ) → zaay (ز): tongue should be between teeth, voiced and heavy.",
  "س->ص":
    "siin (س) → ṣaad (ص): ص is the emphatic 'sad' sound. Tongue spreads heavy across the palate.",
  "ص->س":
    "ṣaad (ص) → siin (س): you went light. ص needs that heavy spread.",
  "ظ->ض":
    "ẓaa (ظ) → ḍaad (ض): close cousins but ظ is between teeth (th-like), ض is behind them.",
  // Nasals and laterals (less common)
  "ن->م":
    "noon (ن) → meem (م): tongue tip touches the ridge for ن; lips close for م. Different point.",
  "م->ن":
    "meem (م) → noon (ن): your lips should close on م, not stay open.",
};

function letterPair(expected: string, actual: string): string | null {
  const key = `${expected}->${actual}`;
  return LETTER_TIPS[key] ?? null;
}

// ── Tajweed tolerance ───────────────────────────────────────────────────
// Tajweed rules change how text is recited vs how it's spelled. The diff
// alone treats the spelling as ground truth, which misreads correct
// recitation as wrong. These post-processing rules forgive specific cases.

const SUKUN = "ْ";
const SHADDA = "ّ";

// Qalqalah letters — when held with sukoon or at word end, they get a
// bouncing release that acoustically overlaps with similar voiceless/voiced
// counterparts. Whisper commonly confuses these.
const QALQALAH = new Set(["ق", "ط", "ب", "ج", "د"]);
// Substitutions that are ASR-confusion-acceptable on qalqalah letters at
// word end (similar place of articulation). The Quran-correct letter is on
// the left; we accept the right as Whisper's alternative.
const QALQALAH_ACCEPT: Record<string, string[]> = {
  "د": ["ت"], // bouncy dental ↔ dental stop
  "ت": ["د"],
  "ب": ["ف", "پ"],
  "ج": ["ش"],
  "ق": ["ك"],
};

// Yarmaloon (يرملون) — the 6 letters noon sakinah merges with via idgham.
const YARMALOON = new Set(["ي", "ر", "م", "ل", "و", "ن"]);

const TANWEEN_CHARS = new Set(["ً", "ٌ", "ٍ"]);

/** Post-process the grapheme diff with tajweed/recitation tolerance rules.
 *  Each rule re-classifies certain tokens from wrong/missing → correct with
 *  an explanatory feedback string the user can hover. */
function tajweedTolerate(
  tokens: LetterDiffToken[],
  wordEndExpectedIndices: Set<number>
): LetterDiffToken[] {
  // Build a parallel array mapping token index → expected-grapheme index
  // (so the word-end check works correctly after collapseAdjacentToWrongLetter
  // merged some pairs).
  const expectedIdxAtToken: number[] = new Array(tokens.length).fill(-1);
  let runningExpectedIdx = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].expected) {
      runningExpectedIdx++;
      expectedIdxAtToken[k] = runningExpectedIdx;
    }
  }

  const out: LetterDiffToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isAtWordEnd = wordEndExpectedIndices.has(expectedIdxAtToken[i]);

    // Rule 1: Idgham (noon sakinah merger), case A — noon went entirely
    // missing in the actual transcript, next letter is yarmaloon with shadda.
    if (t.status === "missing" && t.expected?.letter === "ن") {
      const next = tokens[i + 1];
      if (
        next &&
        next.expected &&
        YARMALOON.has(canonicalLetter(next.expected.letter)) &&
        (next.actual?.marks.includes(SHADDA) ||
          next.expected.marks.includes(SHADDA))
      ) {
        out.push({
          ...t,
          status: "correct",
          feedback: `Idgham: noon sakinah merged into ${labelLetter(next.expected.letter)} (correct tajweed)`,
        });
        continue;
      }
    }

    // Rule 2: Qalqalah substitution at word end.
    if (t.status === "wrong-letter" && t.expected && t.actual) {
      const eLet = t.expected.letter;
      if (
        QALQALAH.has(eLet) &&
        QALQALAH_ACCEPT[eLet]?.includes(t.actual.letter) &&
        (t.expected.marks.includes(SUKUN) || isAtWordEnd)
      ) {
        out.push({
          ...t,
          status: "correct",
          feedback: `Qalqalah ${labelLetter(eLet)} at word end — acoustic ASR variance is acceptable`,
        });
        continue;
      }
    }

    // Rule 3: Missing shaddah only — accept as soft acoustic miss.
    if (t.status === "wrong-marks" && t.expected && t.actual) {
      const expectedHasShadda = t.expected.marks.includes(SHADDA);
      const actualHasShadda = t.actual.marks.includes(SHADDA);
      if (expectedHasShadda && !actualHasShadda) {
        const eRest = t.expected.marks.filter((m) => m !== SHADDA);
        const aRest = t.actual.marks.filter((m) => m !== SHADDA);
        if (sameMarks(eRest, aRest)) {
          out.push({
            ...t,
            status: "correct",
            feedback: "Shaddah (doubled letter) — accepted as a soft acoustic miss",
          });
          continue;
        }
      }
    }

    // Rule 4: Waqf (stopping) at word end — tanween silenced as sukoon is
    // valid Quran recitation when the reciter is stopping at a word.
    if (t.status === "wrong-marks" && t.expected && t.actual && isAtWordEnd) {
      const expectedHasTanween = t.expected.marks.some((m) =>
        TANWEEN_CHARS.has(m)
      );
      const actualHasSukoonOrBare =
        t.actual.marks.length === 0 || t.actual.marks.includes(SUKUN);
      if (expectedHasTanween && actualHasSukoonOrBare) {
        out.push({
          ...t,
          status: "correct",
          feedback: `Waqf: silencing the tanween (${labelLetter(t.expected.letter)} at stop) is correct stopping recitation`,
        });
        continue;
      }
    }

    out.push(t);
  }
  return out;
}

/** Compute the indices in the (space-stripped) expected sequence that fall
 *  on a word boundary, so qalqalah-at-word-end rules can fire correctly. */
function computeWordEndIndices(expectedRaw: string): Set<number> {
  const set = new Set<number>();
  const all = parseGraphemes(expectedRaw);
  let nonSpaceIdx = 0;
  for (let k = 0; k < all.length; k++) {
    if (all[k].letter === " ") {
      if (nonSpaceIdx > 0) set.add(nonSpaceIdx - 1);
    } else {
      nonSpaceIdx++;
    }
  }
  if (nonSpaceIdx > 0) set.add(nonSpaceIdx - 1);
  return set;
}

// ── Letter-level diff ──────────────────────────────────────────────────

export type LetterDiffStatus =
  | "correct"
  | "wrong-letter"
  | "wrong-marks"
  | "missing"
  | "extra";

export type LetterDiffToken = {
  expected: Grapheme | null;
  actual: Grapheme | null;
  status: LetterDiffStatus;
  feedback?: string;
  tip?: string;
};

export function diffGraphemes(
  expectedRaw: string,
  actualRaw: string
): LetterDiffToken[] {
  const expected = parseGraphemes(expectedRaw).filter((g) => g.letter !== " ");
  const actual = parseGraphemes(actualRaw).filter((g) => g.letter !== " ");
  const m = expected.length;
  const n = actual.length;

  // LCS by canonical-letter equality (ignore marks for alignment; rate them later)
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const eq =
        canonicalLetter(expected[i - 1].letter) ===
        canonicalLetter(actual[j - 1].letter);
      dp[i][j] = eq
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const out: LetterDiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const eLet = canonicalLetter(expected[i - 1].letter);
    const aLet = canonicalLetter(actual[j - 1].letter);
    if (eLet === aLet) {
      const e = expected[i - 1];
      const a = actual[j - 1];
      const marksMatch = sameMarks(e.marks, a.marks);
      if (marksMatch) {
        out.push({ expected: e, actual: a, status: "correct" });
      } else {
        out.push({
          expected: e,
          actual: a,
          status: "wrong-marks",
          feedback: describeMarkDifference(e, a),
        });
      }
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ expected: expected[i - 1], actual: null, status: "missing" });
      i--;
    } else {
      out.push({ expected: null, actual: actual[j - 1], status: "extra" });
      j--;
    }
  }
  while (i > 0) {
    out.push({ expected: expected[i - 1], actual: null, status: "missing" });
    i--;
  }
  while (j > 0) {
    out.push({ expected: null, actual: actual[j - 1], status: "extra" });
    j--;
  }
  out.reverse();
  const collapsed = collapseAdjacentToWrongLetter(out);
  const wordEnds = computeWordEndIndices(expectedRaw);
  return tajweedTolerate(collapsed, wordEnds);
}

function sameMarks(a: string[], b: string[]): boolean {
  const an = normalizeMarks(a);
  const bn = normalizeMarks(b);
  if (an.length !== bn.length) return false;
  const aSorted = [...an].sort();
  const bSorted = [...bn].sort();
  return aSorted.every((m, i) => m === bSorted[i]);
}

/** When a missing immediately precedes/follows an extra, treat it as a
 *  wrong-letter substitution. Lets us produce concrete "siin → thaa" tips. */
function collapseAdjacentToWrongLetter(
  tokens: LetterDiffToken[]
): LetterDiffToken[] {
  const out: LetterDiffToken[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const cur = tokens[k];
    const next = tokens[k + 1];
    if (
      next &&
      ((cur.status === "missing" && next.status === "extra") ||
        (cur.status === "extra" && next.status === "missing"))
    ) {
      const expected = cur.status === "missing" ? cur.expected : next.expected;
      const actual = cur.status === "extra" ? cur.actual : next.actual;
      if (expected && actual) {
        const tip =
          letterPair(expected.letter, actual.letter) ?? undefined;
        out.push({
          expected,
          actual,
          status: "wrong-letter",
          feedback: `You said ${actual.letter} (${labelLetter(actual.letter)}), should be ${expected.letter} (${labelLetter(expected.letter)})`,
          tip,
        });
        k++;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

function describeMarkDifference(expected: Grapheme, actual: Grapheme): string {
  const eMarks = new Set(expected.marks);
  const aMarks = new Set(actual.marks);
  const missing = [...eMarks].filter((m) => !aMarks.has(m));
  const extra = [...aMarks].filter((m) => !eMarks.has(m));

  // Common case: one short vowel swap (fatha vs damma, etc.)
  if (missing.length === 1 && extra.length === 1) {
    const want = missing[0];
    const said = extra[0];
    return `Said ${describeMarkShort(said)}, should be ${describeMarkShort(want)} — ${describeMark(want)}`;
  }
  if (missing.length === 0 && extra.length > 0) {
    return `Added ${extra.map(describeMarkShort).join(" + ")} where there shouldn't be one`;
  }
  if (extra.length === 0 && missing.length > 0) {
    return `Missing ${missing.map((m) => `${describeMarkShort(m)} (${describeMark(m)})`).join(" + ")}`;
  }
  return `Marks differ: expected ${expected.marks.map(describeMarkShort).join(",")}, said ${actual.marks.map(describeMarkShort).join(",")}`;
}

/** Letter naming. */
const LETTER_LABEL: Record<string, string> = {
  "ا": "alif",
  "ب": "baa",
  "ت": "taa",
  "ث": "thaa",
  "ج": "jeem",
  "ح": "ḥaa",
  "خ": "khaa",
  "د": "daal",
  "ذ": "dhaal",
  "ر": "raa",
  "ز": "zaay",
  "س": "siin",
  "ش": "shiin",
  "ص": "ṣaad",
  "ض": "ḍaad",
  "ط": "ṭaa",
  "ظ": "ẓaa",
  "ع": "ʿayn",
  "غ": "ghayn",
  "ف": "faa",
  "ق": "qaaf",
  "ك": "kaaf",
  "ل": "laam",
  "م": "meem",
  "ن": "nuun",
  "ه": "haa",
  "و": "waaw",
  "ي": "yaa",
  "ة": "taa marbuta",
  "ء": "hamza",
};

function labelLetter(ch: string): string {
  return LETTER_LABEL[ch] ?? ch;
}

/** Generate compact summary lines for the Feedback panel — one bullet per
 *  meaningful error. Skips correct graphemes. */
export function summarizeLetterDiff(
  tokens: LetterDiffToken[],
  opts?: { limit?: number }
): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.status === "correct") continue;
    if (t.status === "wrong-marks" && t.feedback && t.expected) {
      out.push(`• ${t.expected.raw}: ${t.feedback}`);
    } else if (t.status === "wrong-letter" && t.feedback) {
      out.push(`• ${t.feedback}${t.tip ? ` — ${t.tip}` : ""}`);
    } else if (t.status === "missing" && t.expected) {
      out.push(
        `• Missed ${t.expected.letter} (${labelLetter(t.expected.letter)})`
      );
    } else if (t.status === "extra" && t.actual) {
      out.push(
        `• Added ${t.actual.letter} (${labelLetter(t.actual.letter)}) that isn't there`
      );
    }
    if (opts?.limit && out.length >= opts.limit) {
      out.push("• …more");
      break;
    }
  }
  return out;
}

export function letterAccuracy(tokens: LetterDiffToken[]): number {
  if (tokens.length === 0) return 0;
  const denom = tokens.filter((t) => t.status !== "extra").length;
  if (denom === 0) return 0;
  const correct = tokens.filter((t) => t.status === "correct").length;
  return Math.round((correct / denom) * 100);
}

// ── Render-friendly feedback walk ──────────────────────────────────────
// Turns the grapheme diff into a sequence of parts that can be rendered as
// colored spans, interleaved with original word boundaries from the expected
// text so the visual layout stays word-by-word like a Mushaf line.

export type RenderPart =
  | { kind: "space" }
  | { kind: "expected"; token: LetterDiffToken }
  | { kind: "extra"; tokens: LetterDiffToken[] };

export function buildFeedbackRendering(
  expectedRaw: string,
  actualRaw: string
): RenderPart[] {
  const expectedGraphemes = parseGraphemes(expectedRaw);
  const diff = diffGraphemes(expectedRaw, actualRaw);

  const parts: RenderPart[] = [];
  let diffIdx = 0;

  function flushExtras() {
    const extras: LetterDiffToken[] = [];
    while (diffIdx < diff.length && diff[diffIdx].status === "extra") {
      extras.push(diff[diffIdx]);
      diffIdx++;
    }
    if (extras.length > 0) parts.push({ kind: "extra", tokens: extras });
  }

  for (const g of expectedGraphemes) {
    if (g.letter === " ") {
      flushExtras();
      parts.push({ kind: "space" });
      continue;
    }
    flushExtras();
    if (diffIdx < diff.length) {
      parts.push({ kind: "expected", token: diff[diffIdx] });
      diffIdx++;
    } else {
      parts.push({
        kind: "expected",
        token: { expected: g, actual: null, status: "missing" },
      });
    }
  }
  flushExtras();
  return parts;
}

// ── Word-level rendering (preserves Arabic cursive joins) ──────────────
// Each word is kept as a single span; status is aggregated from the letter
// diff so colors still come from the per-letter analysis but visual layout
// stays word-by-word like the original Uthmani text.

export type WordStatus =
  | "correct"
  | "wrong-marks"
  | "wrong-letter"
  | "missing"
  | "partial";

export type WordRenderPart =
  | { kind: "space" }
  | {
      kind: "word";
      text: string;
      status: WordStatus;
      letterTokens: LetterDiffToken[];
    }
  | { kind: "extra"; text: string; tokens: LetterDiffToken[] };

function aggregateStatus(tokens: LetterDiffToken[]): WordStatus {
  if (tokens.length === 0) return "correct";
  if (tokens.every((t) => t.status === "correct")) return "correct";
  if (tokens.some((t) => t.status === "wrong-letter")) return "wrong-letter";
  if (tokens.some((t) => t.status === "missing")) {
    return tokens.some((t) => t.status === "correct") ? "partial" : "missing";
  }
  if (tokens.some((t) => t.status === "wrong-marks")) return "wrong-marks";
  return "correct";
}

export function buildWordFeedbackRendering(
  expectedRaw: string,
  actualRaw: string
): WordRenderPart[] {
  const expectedGraphemes = parseGraphemes(expectedRaw);
  const diff = diffGraphemes(expectedRaw, actualRaw);

  const parts: WordRenderPart[] = [];
  let diffIdx = 0;
  let currentText = "";
  let currentTokens: LetterDiffToken[] = [];

  function flushExtras() {
    const extras: LetterDiffToken[] = [];
    while (diffIdx < diff.length && diff[diffIdx].status === "extra") {
      extras.push(diff[diffIdx]);
      diffIdx++;
    }
    if (extras.length > 0) {
      parts.push({
        kind: "extra",
        text: extras.map((t) => t.actual?.raw ?? "").join(""),
        tokens: extras,
      });
    }
  }

  function flushWord() {
    if (currentText.length > 0 || currentTokens.length > 0) {
      parts.push({
        kind: "word",
        text: currentText,
        status: aggregateStatus(currentTokens),
        letterTokens: currentTokens,
      });
      currentText = "";
      currentTokens = [];
    }
  }

  for (const g of expectedGraphemes) {
    if (g.letter === " ") {
      flushExtras();
      flushWord();
      parts.push({ kind: "space" });
      continue;
    }
    flushExtras();
    currentText += g.raw;
    if (diffIdx < diff.length) {
      currentTokens.push(diff[diffIdx]);
      diffIdx++;
    } else {
      currentTokens.push({
        expected: g,
        actual: null,
        status: "missing",
      });
    }
  }
  flushExtras();
  flushWord();
  return parts;
}
