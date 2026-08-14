import { create } from "zustand";
import type { ChannelKind, ProgressStats } from "@core/types";
import type { VisibleSession } from "@core/pairing";

export type Mode = "landing" | "send" | "receive";
export type Theme = "dark" | "light";

export interface ReceivedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  receivedAt: number;
  bytes: Uint8Array;
}

export type SendScreen = "pick" | "channel" | "waiting" | "matched" | "transfer" | "done" | "error";

export interface SenderView {
  screen: SendScreen;
  fileName: string;
  fileSize: number;
  mime: string;
  wordPair: string;
  peerFingerprint: string | null;
  channel: ChannelKind | null;
  link: string | null;
  note: string | null;
  stats: ProgressStats | null;
  hash: string | null;
  error: string;
}

export type ReceiveScreen = "listen" | "match" | "waiting" | "transfer" | "done" | "error";

export interface ReceiverView {
  screen: ReceiveScreen;
  sessions: VisibleSession[];
  chosen: VisibleSession | null;
  note: string | null;
  stats: ProgressStats | null;
  file: ReceivedFile | null;
  received: ReceivedFile[];
  error: string;
}

interface AppStore {
  mode: Mode;
  theme: Theme;
  onlineReady: boolean | null;
  sender: SenderView;
  receiver: ReceiverView;
  setMode(mode: Mode): void;
  setTheme(theme: Theme): void;
  setOnlineReady(ready: boolean): void;
  setSender(patch: Partial<SenderView>): void;
  setReceiver(patch: Partial<ReceiverView>): void;
  resetSender(): void;
  resetReceiver(): void;
}

const initialSender: SenderView = {
  screen: "pick",
  fileName: "",
  fileSize: 0,
  mime: "application/octet-stream",
  wordPair: "",
  peerFingerprint: null,
  channel: null,
  link: null,
  note: null,
  stats: null,
  hash: null,
  error: "",
};

const initialReceiver: ReceiverView = {
  screen: "listen",
  sessions: [],
  chosen: null,
  note: null,
  stats: null,
  file: null,
  received: [],
  error: "",
};

export const useApp = create<AppStore>((set, get) => ({
  mode: "landing",
  theme: (localStorage.getItem("semaphore-theme") as Theme) || "dark",
  onlineReady: null,
  sender: initialSender,
  receiver: initialReceiver,
  setMode(mode) {
    if (mode === get().mode) return;
    set({ mode });
  },
  setTheme(theme) {
    localStorage.setItem("semaphore-theme", theme);
    set({ theme });
  },
  setOnlineReady(ready) {
    set({ onlineReady: ready });
  },
  setSender(patch) {
    set({ sender: { ...get().sender, ...patch } });
  },
  setReceiver(patch) {
    set({ receiver: { ...get().receiver, ...patch } });
  },
  resetSender() {
    set({ sender: { ...initialSender } });
  },
  resetReceiver() {
    set({ receiver: { ...initialReceiver } });
  },
}));