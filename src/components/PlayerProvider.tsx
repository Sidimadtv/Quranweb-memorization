"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { fetchSurahAudio, type SurahAudio } from "@/lib/audio";
import { PlayerStore } from "@/lib/playerStore";

type PlayerCtx = {
  store: PlayerStore;
  surahAudio: SurahAudio | null;
  audioStatus: "loading" | "ready" | "error";
  audioError: string | null;
  reload: () => void;
};

const Context = createContext<PlayerCtx | null>(null);

export function PlayerProvider({
  reciterId,
  surahId,
  children,
}: {
  reciterId: number;
  surahId: number;
  children: ReactNode;
}) {
  const storeRef = useRef<PlayerStore | null>(null);
  if (!storeRef.current) storeRef.current = new PlayerStore();
  const store = storeRef.current;

  const stateRef = useRef<{
    surahAudio: SurahAudio | null;
    audioStatus: "loading" | "ready" | "error";
    audioError: string | null;
    nonce: number;
  }>({ surahAudio: null, audioStatus: "loading", audioError: null, nonce: 0 });

  const listenersRef = useRef(new Set<() => void>());

  const subscribe = useMemo(
    () => (l: () => void) => {
      listenersRef.current.add(l);
      return () => listenersRef.current.delete(l);
    },
    []
  );
  const getSnapshot = useMemo(() => () => stateRef.current, []);
  const localState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  );

  useEffect(() => {
    let cancelled = false;
    stateRef.current = {
      ...stateRef.current,
      audioStatus: "loading",
      audioError: null,
    };
    listenersRef.current.forEach((l) => l());

    fetchSurahAudio(reciterId, surahId)
      .then((sa) => {
        if (cancelled) return;
        store.loadSurah(sa);
        stateRef.current = {
          surahAudio: sa,
          audioStatus: "ready",
          audioError: null,
          nonce: stateRef.current.nonce + 1,
        };
        listenersRef.current.forEach((l) => l());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        stateRef.current = {
          surahAudio: null,
          audioStatus: "error",
          audioError: err instanceof Error ? err.message : "Audio load failed",
          nonce: stateRef.current.nonce + 1,
        };
        listenersRef.current.forEach((l) => l());
      });

    return () => {
      cancelled = true;
      store.stop();
    };
  }, [reciterId, surahId, store]);

  useEffect(() => {
    return () => {
      store.destroy();
    };
  }, [store]);

  const ctx: PlayerCtx = {
    store,
    surahAudio: localState.surahAudio,
    audioStatus: localState.audioStatus,
    audioError: localState.audioError,
    reload: () => {
      stateRef.current = { ...stateRef.current, nonce: stateRef.current.nonce + 1 };
      listenersRef.current.forEach((l) => l());
    },
  };

  return <Context.Provider value={ctx}>{children}</Context.Provider>;
}

export function usePlayer() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("usePlayer must be used inside PlayerProvider");
  return ctx;
}

export function useActiveVerseKey(): string | null {
  const { store } = usePlayer();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().activeVerseKey,
    () => null
  );
}

export function useWordIndexFor(verseKey: string): number | null {
  const { store } = usePlayer();
  return useSyncExternalStore(
    store.subscribe,
    () => {
      const s = store.getSnapshot();
      return s.activeVerseKey === verseKey ? s.wordIndex : null;
    },
    () => null
  );
}

export function useIsPlaying(): boolean {
  const { store } = usePlayer();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().isPlaying,
    () => false
  );
}
