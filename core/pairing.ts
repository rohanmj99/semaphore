import type { TransportEndpoint } from "./transports.ts";
import type { WireMessage } from "./frames.ts";
import { frameMessage, FrameParser } from "./frames.ts";
import type { ChannelKind } from "./types.ts";
import { createSessionId, deriveKxSessionKey, fingerprint, keypair, wordPair } from "./crypto.ts";
import { fromBase64Url, nextId, toBase64Url } from "./util.ts";

const HUB_CHANNEL = "semaphore:hub";
export const ANNOUNCE_INTERVAL_MS = 800;
const SESSION_TTL_MS = 2600;
const dec = new TextDecoder();

function sessionChannelName(sessionId: string): string {
  return `semaphore:session:${sessionId}`;
}

export interface SessionAnnouncement {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  senderPub: string;
  file: { name: string; size: number } | null;
}

export interface VisibleSession {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  senderPub: string;
  file: { name: string; size: number } | null;
  seenAt: number;
}

export interface Room {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  receiverFingerprint: string;
  channel: TransportEndpoint;
  sessionKey: Uint8Array;
}

const bcAvailable = (): boolean => typeof BroadcastChannel === "function";

export class BroadcastTransport implements TransportEndpoint {
  readonly kind: ChannelKind = "loopback";
  readonly id: string;
  private readonly bc: BroadcastChannel;
  private readonly msgHandlers = new Set<(frame: Uint8Array) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(name: string, id = nextId()) {
    this.id = id;
    if (!bcAvailable()) throw new Error("BroadcastChannel unavailable");
    this.bc = new BroadcastChannel(name);
    this.bc.addEventListener("message", (e) => {
      if (this.closed) return;
      const data = e.data;
      if (!(data instanceof Uint8Array)) return;
      for (const cb of [...this.msgHandlers]) cb(data);
    });
  }

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error("channel closed");
    this.bc.postMessage(frame);
  }

  onMessage(cb: (frame: Uint8Array) => void): () => void {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bc.close();
    for (const cb of [...this.closeHandlers]) cb();
    this.msgHandlers.clear();
    this.closeHandlers.clear();
  }
}

export interface QueuedSender {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  onMatch: (cb: (peer: { receiverFingerprint: string; receiverPub: string }) => void) => void;
  notifyGo(): void;
  start(onReady: (keys: { sessionKey: Uint8Array; channel: TransportEndpoint; receiverFingerprint: string }) => void): void;
  stop(): void;
}

export function advertiseSender(file: { name: string; size: number } | null): QueuedSender {
  const kp = keypair();
  const sessionId = createSessionId();
  const pair = wordPair(kp.publicKey);
  const fp = fingerprint(kp.publicKey);
  const channel = new BroadcastTransport(sessionChannelName(sessionId), `${sessionId}:s`);
  const hub = new BroadcastChannel(HUB_CHANNEL);
  const announcement: SessionAnnouncement = {
    sessionId,
    wordPair: pair,
    senderFingerprint: fp,
    senderPub: toBase64Url(kp.publicKey),
    file,
  };
  const heart = () => {
    try {
      hub.postMessage(announcement);
    } catch {
      /* hub closed */
    }
  };
  heart();
  const iv = setInterval(heart, ANNOUNCE_INTERVAL_MS);

  const matchHandlers = new Set<(peer: { receiverFingerprint: string; receiverPub: string }) => void>();
  const goHandlers = new Set<() => void>();
  const readyHandlers = new Set<(keys: { sessionKey: Uint8Array; channel: TransportEndpoint; receiverFingerprint: string }) => void>();
  const parser = new FrameParser();
  const unsub = channel.onMessage((frame) => {
    for (const f of parser.push(frame)) {
      let m: WireMessage;
      try {
        m = JSON.parse(dec.decode(f)) as WireMessage;
      } catch {
        continue;
      }
      if (m.t === "match" && typeof m.pub === "string" && typeof m.fp === "string") {
        const peer = { receiverFingerprint: m.fp, receiverPub: m.pub };
        for (const cb of [...matchHandlers]) cb(peer);
      } else if (m.t === "go") {
        for (const cb of [...goHandlers]) cb();
      } else if (m.t === "ready" && typeof m.pub === "string" && typeof m.fp === "string") {
        const receiverPub = fromBase64Url(m.pub);
        const sessionKey = deriveKxSessionKey(sessionId, receiverPub, kp.secretKey).key;
        for (const cb of [...readyHandlers]) cb({ sessionKey, channel, receiverFingerprint: m.fp });
      }
    }
  });

  const sendJson = (m: WireMessage) => channel.send(frameMessage(new TextEncoder().encode(JSON.stringify(m))));

  return {
    sessionId,
    wordPair: pair,
    senderFingerprint: fp,
    onMatch(cb) {
      matchHandlers.add(cb);
    },
    notifyGo() {
      sendJson({ t: "go" });
    },
    start(onReady) {
      readyHandlers.add(onReady);
    },
    stop() {
      clearInterval(iv);
      unsub();
      hub.close();
      channel.close();
      matchHandlers.clear();
      goHandlers.clear();
      readyHandlers.clear();
    },
  };
}

export function scanForSessions(onSessions: (list: VisibleSession[]) => void): () => void {
  if (!bcAvailable()) {
    onSessions([]);
    return () => {};
  }
  const hub = new BroadcastChannel(HUB_CHANNEL);
  const map = new Map<string, VisibleSession>();
  hub.addEventListener("message", (e) => {
    const d = e.data as Partial<SessionAnnouncement>;
    if (!d || typeof d.sessionId !== "string" || typeof d.wordPair !== "string") return;
    map.set(d.sessionId, {
      sessionId: d.sessionId,
      wordPair: d.wordPair,
      senderFingerprint: typeof d.senderFingerprint === "string" ? d.senderFingerprint : "",
      senderPub: typeof d.senderPub === "string" ? d.senderPub : "",
      file: d.file && typeof d.file.name === "string" ? { name: d.file.name, size: Number(d.file.size) || 0 } : null,
      seenAt: Date.now(),
    });
  });
  const tick = () => {
    const now = Date.now();
    for (const [id, s] of [...map]) {
      if (now - s.seenAt > SESSION_TTL_MS) map.delete(id);
    }
    onSessions([...map.values()].sort((a, b) => a.seenAt - b.seenAt));
  };
  const iv = setInterval(tick, 400);
  return () => {
    clearInterval(iv);
    hub.close();
  };
}

export interface ReceiverMatcher {
  readonly pin: Room | null;
  confirm(): void;
  onGo: (cb: () => void) => void;
  postReady(): void;
  cancel(): void;
}

export function matchSession(session: VisibleSession): ReceiverMatcher {
  const kp = keypair();
  const receiverFp = fingerprint(kp.publicKey);
  const channel = new BroadcastTransport(sessionChannelName(session.sessionId), `${session.sessionId}:r`);
  const parser = new FrameParser();
  const goHandlers = new Set<() => void>();
  const sendJson = (m: WireMessage) => channel.send(frameMessage(new TextEncoder().encode(JSON.stringify(m))));
  let pin: Room | null = null;

  const onMessage = (frame: Uint8Array) => {
    for (const f of parser.push(frame)) {
      let m: WireMessage;
      try {
        m = JSON.parse(dec.decode(f)) as WireMessage;
      } catch {
        continue;
      }
      if (m.t === "go") {
        for (const cb of [...goHandlers]) cb();
      }
    }
  };
  channel.onMessage(onMessage);

  return {
    get pin() {
      return pin;
    },
    confirm() {
      if (pin) return;
      const senderPub = fromBase64Url(session.senderPub);
      const sessionKey = deriveKxSessionKey(session.sessionId, senderPub, kp.secretKey).key;
      pin = {
        sessionId: session.sessionId,
        wordPair: session.wordPair,
        senderFingerprint: session.senderFingerprint,
        receiverFingerprint: receiverFp,
        channel,
        sessionKey,
      };
      sendJson({ t: "match", pub: toBase64Url(kp.publicKey), fp: receiverFp });
    },
    onGo(cb) {
      goHandlers.add(cb);
    },
    postReady() {
      sendJson({ t: "ready", pub: toBase64Url(kp.publicKey), fp: receiverFp });
    },
    cancel() {
      channel.close();
      goHandlers.clear();
    },
  };
}

export function pairingSupported(): boolean {
  return bcAvailable();
}