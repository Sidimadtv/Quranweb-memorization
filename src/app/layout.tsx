import type { Metadata } from "next";
import { Inter, Amiri_Quran } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ModelPreloader } from "@/components/ModelPreloader";
import { IntroOverlay } from "@/components/IntroOverlay";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const amiriQuran = Amiri_Quran({
  variable: "--font-quran",
  subsets: ["arabic"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Hifz AI — Quran memorization & recitation practice",
  description:
    "Practice Quran memorization and recitation with prominent reciters and AI-assisted word-level feedback.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${amiriQuran.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
        <header className="border-b border-stone-200 dark:border-stone-800 bg-white/70 dark:bg-stone-950/70 backdrop-blur sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
            <Link href="/" className="font-semibold tracking-tight text-lg">
              Hifz AI
            </Link>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Supplement, not substitute. Always learn from a qualified teacher.
            </p>
          </div>
        </header>
        <IntroOverlay />
        <ModelPreloader />
        <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6">
          {children}
        </main>
        <footer className="border-t border-stone-200 dark:border-stone-800 text-xs text-stone-500 dark:text-stone-400">
          <div className="max-w-6xl mx-auto px-4 py-4">
            Text + audio from quran.com / qurancdn.com · Recitation recognition runs entirely in your browser via Tarteel Whisper (ONNX)
          </div>
        </footer>
      </body>
    </html>
  );
}
