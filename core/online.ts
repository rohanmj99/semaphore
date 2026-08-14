import { createSessionId, deriveKxSessionKey, fingerprint, keypair, wordPair } from "./crypto.ts";
import { fromBase64Url, toBase64Url } from "./util.ts";
import type { Mailbox } from "./mailbox.ts";
import { MailboxPoller, parseMailboxJson, putWithRetry } from "./mailbox.ts";
import { WebRtcNegotiator, type NegotiatorState } from "./webrtc.ts";
import type { TransportEndpoint } from "./transports.ts";

export interface OnlineAnnouncement {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  senderPub: string;
  file: { name: string; size: number } | null;
  ts: number;
}

export type OnlineSession = OnlineAnnouncement & { seenAt: number };

export type MailboxForSession = (sessionId: string) => Mailbox;

export interface OnlineNegOptions {
  iceServers: RTCIceServer[];
  pcFactory?: () => RTCPeerConnection;
  connectTimeoutMs?: number;
  restartWaitMs?: number;
  pollMs?: number;
}

export interface OnlineRoom {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  receiverFingerprint: string;
  channel: TransportEndpoint;
  sessionKey: Uint8Array;
}

export interface OnlineSender {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  onMatch(cb: (peer: { receiverFingerprint: string }) => void): void;
  notifyGo(): void;
  start(cb: (keys: OnlineRoom) => void): void;
  onState(cb: (state: NegotiatorState) => void): void;
  onFailure(cb: (message: string) => void): void;
  stop(): void;
}

interface PeerMessage {
  t: string;
  pub?: string;
  fp?: string;
}

export async function fetchAnnouncement(sessionId: string, mailboxFor: MailboxForSession): Promise<OnlineSession> {
  const mailbox = mailboxFor(sessionId);
  const page = await mailbox.get("announce");
  if (page.entries.length === 0) {
    throw new Error("This link has expired. Ask the sender to share a new one.");
  }
  const latest = page.entries[page.entries.length - 1];
  const seenAt = typeof latest.ts === "number" ? latest.ts : Date.now();
  const msg = parseMailboxJson<OnlineAnnouncement>(latest.p);
  if (
    !msg ||
    typeof msg.wordPair !== "string" ||
    typeof msg.senderFingerprint !== "string" ||
    typeof msg.senderPub !== "string"
  ) {
    throw new Error("This link isn't ready yet. Ask the sender to share a new one.");
  }
  try {
    fromBase64Url(msg.senderPub);
  } catch {
    throw new Error("This link isn't ready yet. Ask the sender to share a new one.");
  }
  return {
    sessionId,
    wordPair: msg.wordPair,
    senderFingerprint: msg.senderFingerprint,
    senderPub: msg.senderPub,
    file: msg.file && typeof msg.file.name === "string" ? { name: msg.file.name, size: Number(msg.file.size) || 0 } : null,
    ts: typeof msg.ts === "number" ? msg.ts : seenAt,
    seenAt,
  };
}

export function advertiseOnline(
  file: { name: string; size: number } | null,
  mailboxFor: MailboxForSession,
  negOpts: OnlineNegOptions,
): OnlineSender {
  const kp = keypair();
  const sessionId = createSessionId();
  const mailbox = mailboxFor(sessionId);
  const pair = wordPair(kp.publicKey);
  const senderFp = fingerprint(kp.publicKey);
  const poller = new MailboxPoller(mailbox, negOpts.pollMs);
  const matchHandlers = new Set<(peer: { receiverFingerprint: string }) => void>();
  const startHandlers = new Set<(room: OnlineRoom) => void>();
  const stateHandlers = new Set<(state: NegotiatorState) => void>();
  const failureHandlers = new Set<(message: string) => void>();
  let negotiator: WebRtcNegotiator | null = null;
  let stopped = false;

  poller.subscribe("peer", (entries) => {
    for (const entry of entries) {
      const msg = parseMailboxJson<PeerMessage>(entry.p);
      if (!msg || msg.t !== "match" || typeof msg.fp !== "string") continue;
      for (const cb of [...matchHandlers]) cb({ receiverFingerprint: msg.fp });
    }
  });
  poller.subscribe("ready", (entries) => {
    for (const entry of entries) {
      const msg = parseMailboxJson<PeerMessage>(entry.p);
      if (!msg || msg.t !== "ready" || typeof msg.pub !== "string" || typeof msg.fp !== "string") continue;
      if (stopped) return;
      let receiverPub: Uint8Array;
      try {
        receiverPub = fromBase64Url(msg.pub);
      } catch {
        continue;
      }
      const sessionKey = deriveKxSessionKey(sessionId, receiverPub, kp.secretKey).key;
      const room: OnlineRoom = {
        sessionId,
        wordPair: pair,
        senderFingerprint: senderFp,
        receiverFingerprint: msg.fp,
        channel: ensureNegotiator().transport,
        sessionKey,
      };
      for (const cb of [...startHandlers]) cb(room);
    }
  });
  poller.start();

  const announcement: OnlineAnnouncement = {
    sessionId,
    wordPair: pair,
    senderFingerprint: senderFp,
    senderPub: toBase64Url(kp.publicKey),
    file: file ? { name: file.name, size: file.size } : null,
    ts: Date.now(),
  };
  void putWithRetry(mailbox, "announce", JSON.stringify(announcement)).then((ok) => {
    if (!ok && !stopped) {
      for (const cb of [...failureHandlers]) cb("Live relay unavailable — try another channel.");
    }
  });

  function ensureNegotiator(): WebRtcNegotiator {
    if (!negotiator) {
      negotiator = new WebRtcNegotiator({
        role: "responder",
        mailbox,
        sessionId,
        iceServers: negOpts.iceServers,
        pcFactory: negOpts.pcFactory,
        connectTimeoutMs: negOpts.connectTimeoutMs,
        restartWaitMs: negOpts.restartWaitMs,
        pollMs: negOpts.pollMs,
        onState: (state) => {
          for (const cb of [...stateHandlers]) cb(state);
        },
        onFailure: (message) => {
          for (const cb of [...failureHandlers]) cb(message);
        },
      });
      negotiator.start();
    }
    return negotiator;
  }

  return {
    sessionId,
    wordPair: pair,
    senderFingerprint: senderFp,
    onMatch(cb) {
      matchHandlers.add(cb);
    },
    notifyGo() {
      void putWithRetry(mailbox, "go", JSON.stringify({ t: "go", ts: Date.now() }));
    },
    start(cb) {
      startHandlers.add(cb);
    },
    onState(cb) {
      stateHandlers.add(cb);
    },
    onFailure(cb) {
      failureHandlers.add(cb);
    },
    stop() {
      stopped = true;
      poller.stop();
      negotiator?.stop();
      negotiator = null;
      matchHandlers.clear();
      startHandlers.clear();
      stateHandlers.clear();
      failureHandlers.clear();
    },
  };
}

export function matchOnlineSession(
  session: OnlineAnnouncement,
  mailboxFor: MailboxForSession,
  negOpts: OnlineNegOptions,
): OnlineReceiver {
  const kp = keypair();
  const receiverFp = fingerprint(kp.publicKey);
  const mailbox = mailboxFor(session.sessionId);
  const poller = new MailboxPoller(mailbox, negOpts.pollMs);
  const goHandlers = new Set<() => void>();
  const stateHandlers = new Set<(state: NegotiatorState) => void>();
  const failureHandlers = new Set<(message: string) => void>();
  let negotiator: WebRtcNegotiator | null = null;
  let pin: OnlineRoom | null = null;
  let stopped = false;

  poller.subscribe("go", (entries) => {
    for (const entry of entries) {
      const msg = parseMailboxJson<{ t: string }>(entry.p);
      if (!msg || msg.t !== "go") continue;
      for (const cb of [...goHandlers]) cb();
      return;
    }
  });
  poller.start();

  function ensureNegotiator(): WebRtcNegotiator {
    if (!negotiator) {
      negotiator = new WebRtcNegotiator({
        role: "initiator",
        mailbox,
        sessionId: session.sessionId,
        iceServers: negOpts.iceServers,
        pcFactory: negOpts.pcFactory,
        connectTimeoutMs: negOpts.connectTimeoutMs,
        restartWaitMs: negOpts.restartWaitMs,
        pollMs: negOpts.pollMs,
        onState: (state) => {
          for (const cb of [...stateHandlers]) cb(state);
        },
        onFailure: (message) => {
          for (const cb of [...failureHandlers]) cb(message);
        },
      });
      negotiator.start();
    }
    return negotiator;
  }

  return {
    get pin() {
      return pin;
    },
    confirm() {
      if (pin || stopped) return;
      let senderPub: Uint8Array;
      try {
        senderPub = fromBase64Url(session.senderPub);
      } catch {
        return;
      }
      const sessionKey = deriveKxSessionKey(session.sessionId, senderPub, kp.secretKey).key;
      pin = {
        sessionId: session.sessionId,
        wordPair: session.wordPair,
        senderFingerprint: session.senderFingerprint,
        receiverFingerprint: receiverFp,
        channel: ensureNegotiator().transport,
        sessionKey,
      };
      void putWithRetry(mailbox, "peer", JSON.stringify({ t: "match", pub: toBase64Url(kp.publicKey), fp: receiverFp }));
    },
    onGo(cb) {
      goHandlers.add(cb);
    },
    postReady() {
      void putWithRetry(mailbox, "ready", JSON.stringify({ t: "ready", pub: toBase64Url(kp.publicKey), fp: receiverFp }));
    },
    onState(cb) {
      stateHandlers.add(cb);
    },
    onFailure(cb) {
      failureHandlers.add(cb);
    },
    cancel() {
      stopped = true;
      poller.stop();
      negotiator?.stop();
      negotiator = null;
      goHandlers.clear();
      stateHandlers.clear();
      failureHandlers.clear();
    },
  };
}

export interface OnlineReceiver {
  readonly pin: OnlineRoom | null;
  confirm(): void;
  onGo(cb: () => void): void;
  postReady(): void;
  onState(cb: (state: NegotiatorState) => void): void;
  onFailure(cb: (message: string) => void): void;
  cancel(): void;
}