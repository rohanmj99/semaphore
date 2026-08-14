import { advertiseSender, pairingSupported } from "@core/pairing";
import { advertiseOnline, type OnlineSender } from "@core/online";
import { StreamSender } from "@core/session";
import type { SliceSource } from "@core/chunker";
import type { ProgressStats } from "@core/types";
import type { NegotiatorState } from "@core/webrtc";
import { iceServersConfig, mailboxForSession, shareLinkFor } from "../config.ts";

export type SendChannel = "loopback" | "online";

export interface SendCallbacks {
  onMatched(receiverFingerprint: string): void;
  onTransferring(): void;
  onStats(stats: ProgressStats): void;
  onDone(hash: string | null): void;
  onError(message: string): void;
  onNote?(note: string | null): void;
}

interface SendQueue {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  onMatch(cb: (peer: { receiverFingerprint: string }) => void): void;
  notifyGo(): void;
  start(
    cb: (keys: { sessionKey: Uint8Array; channel: import("@core/transports").TransportEndpoint; receiverFingerprint: string }) => void,
  ): void;
  onState?(cb: (state: NegotiatorState) => void): void;
  onFailure?(cb: (message: string) => void): void;
  stop(): void;
}

const LINK_EXPIRY_MS = 10 * 60 * 1000;

export class SendController {
  readonly wordPair: string;
  readonly senderFingerprint: string;
  readonly sessionId: string;
  readonly link: string | null = null;
  private queue: SendQueue | null = null;
  private stream: StreamSender | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private completedHash: string | null = null;

  constructor(readonly source: SliceSource, private readonly cb: SendCallbacks, channel: SendChannel = "loopback") {
    const file = { name: source.name ?? "file", size: source.size };
    if (channel === "online") {
      if (typeof RTCPeerConnection === "undefined") {
        throw new Error("This browser can't do online transfers.");
      }
      const online = advertiseOnline(file, mailboxForSession, { iceServers: iceServersConfig() });
      this.link = shareLinkFor(online.sessionId);
      this.queue = this.wrapOnline(online);
    } else {
      if (!pairingSupported()) throw new Error("This browser can't run nearby pairing.");
      this.queue = advertiseSender(file);
    }
    this.wordPair = this.queue.wordPair;
    this.senderFingerprint = this.queue.senderFingerprint;
    this.sessionId = this.queue.sessionId;
    this.wireQueue(this.queue);
    if (channel === "online") {
      this.expiryTimer = setTimeout(() => {
        if (!this.settled) this.cb.onError("The link expired — send a new one.");
      }, LINK_EXPIRY_MS);
    }
  }

  private wrapOnline(online: OnlineSender): SendQueue {
    return {
      sessionId: online.sessionId,
      wordPair: online.wordPair,
      senderFingerprint: online.senderFingerprint,
      onMatch(cb) {
        online.onMatch(cb);
      },
      notifyGo() {
        online.notifyGo();
      },
      start(cb) {
        online.start((room) => {
          cb({ sessionKey: room.sessionKey, channel: room.channel, receiverFingerprint: room.receiverFingerprint });
        });
      },
      onState(cb) {
        online.onState(cb);
      },
      onFailure(cb) {
        online.onFailure(cb);
      },
      stop() {
        online.stop();
      },
    };
  }

  private wireQueue(queue: SendQueue) {
    queue.onState?.((state) => {
      if (this.settled) return;
      this.cb.onNote?.(state === "reconnecting" ? "Trying to reconnect…" : null);
    });
    queue.onFailure?.((message) => {
      if (this.settled) return;
      this.cb.onError(message);
    });
    queue.onMatch((peer) => {
      if (this.settled) return;
      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
        this.expiryTimer = null;
      }
      this.cb.onMatched(peer.receiverFingerprint);
    });
    queue.start(({ sessionKey, channel }) => {
      if (this.settled) return;
      this.cb.onTransferring();
      this.stream = new StreamSender(this.sessionId, sessionKey, this.source, {
        onHeader: (h) => {
          this.completedHash = h.crc32.toString(16).padStart(8, "0");
        },
        onEvent: (e) => {
          if (this.settled) return;
          if (e.type === "error") this.cb.onError(e.message);
          if (e.type === "done") this.cb.onDone(this.completedHash);
        },
      });
      this.stream.run(channel);
      this.statsTimer = setInterval(() => {
        if (this.stream && !this.settled) this.cb.onStats(this.stream.stats.snapshot());
      }, 250);
    });
  }

  confirmMatch() {
    this.queue?.notifyGo();
  }

  cancel() {
    this.settled = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.stream?.cancel();
    this.queue?.stop();
    this.queue = null;
  }

  isSettled(): boolean {
    return this.settled;
  }
}