import { advertiseSender, pairingSupported } from "@core/pairing";
import { advertiseOnline, type OnlineSender } from "@core/online";
import { StreamSender } from "@core/session";
import { advertiseLight, lightSupported, type LightSenderQueue, type LightTransport } from "@core/qr/light";
import { advertiseSound, soundSupport, type SoundSenderQueue } from "@core/modem/sound";
import type { SliceSource } from "@core/chunker";
import type { ProgressStats } from "@core/types";
import type { NegotiatorState } from "@core/webrtc";
import { iceServersConfig, mailboxForSession, shareLinkFor } from "../config.ts";

export type SendChannel = "loopback" | "online" | "sound" | "light";

export function channelSupported(channel: SendChannel): boolean {
  switch (channel) {
    case "loopback":
      return pairingSupported();
    case "online":
      return typeof RTCPeerConnection !== "undefined";
    case "sound":
      return soundSupport();
    case "light":
      return lightSupported();
  }
}

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
  /** Light channel only: the display transport the UI paints as an animated QR. */
  display?: LightTransport;
  onMatch(cb: (peer: { receiverFingerprint: string }) => void): void;
  notifyGo(): void;
  /** Broadcast channels only: re-start announcing after the transfer ended,
   *  so a receiver that missed it can match and receive it again. */
  reannounce?(): void;
  start(
    cb: (keys: { sessionKey: Uint8Array; channel: import("@core/transports").TransportEndpoint; receiverFingerprint: string }) => void,
  ): void;
  onState?(cb: (state: NegotiatorState) => void): void;
  onFailure?(cb: (message: string) => void): void;
  stop(): void;
}

const LINK_EXPIRY_MS = 10 * 60 * 1000;
/** Broadcast chunk sizes — small so one message fits the channel's window. */
const SOUND_CHUNK_BYTES = 4096;
const LIGHT_CHUNK_BYTES = 8192;
/** Broadcast mode: bounded cycle count; the UI shows guidance when done. */
const NO_ACK_PASSES = 6;

export class SendController {
  readonly wordPair: string;
  readonly senderFingerprint: string;
  readonly sessionId: string;
  readonly link: string | null = null;
  /** Light channel: animated QR display transport, null on other channels. */
  readonly display: LightTransport | null;
  private queue: SendQueue | null = null;
  private stream: StreamSender | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private completedHash: string | null = null;

  constructor(readonly source: SliceSource, private readonly cb: SendCallbacks, private readonly channel: SendChannel = "loopback") {
    const file = { name: source.name ?? "file", size: source.size };
    if (channel === "online") {
      if (typeof RTCPeerConnection === "undefined") {
        throw new Error("This browser can't do online transfers.");
      }
      const online = advertiseOnline(file, mailboxForSession, { iceServers: iceServersConfig() });
      this.link = shareLinkFor(online.sessionId);
      this.queue = this.wrapOnline(online);
    } else if (channel === "sound") {
      if (!soundSupport()) throw new Error("Sound isn't available in this browser.");
      this.queue = this.wrapSound(advertiseSound(file));
    } else if (channel === "light") {
      if (!lightSupported()) throw new Error("This browser can't do screen-flash transfers.");
      this.queue = this.wrapLight(advertiseLight(file));
    } else {
      if (!pairingSupported()) throw new Error("This browser can't run nearby pairing.");
      this.queue = advertiseSender(file);
    }
    this.display = this.queue.display ?? null;
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

  private wrapSound(sound: SoundSenderQueue): SendQueue {
    return {
      sessionId: sound.sessionId,
      wordPair: sound.wordPair,
      senderFingerprint: sound.senderFingerprint,
      onMatch(cb) {
        sound.onMatch(cb);
      },
      notifyGo() {
        sound.notifyGo();
      },
      reannounce() {
        sound.reannounce();
      },
      start(cb) {
        sound.start((keys) => {
          cb({ sessionKey: keys.sessionKey, channel: keys.channel, receiverFingerprint: keys.receiverFingerprint });
        });
      },
      onFailure(cb) {
        sound.onFailure?.(cb);
      },
      stop() {
        sound.stop();
      },
    };
  }

  private wrapLight(light: LightSenderQueue): SendQueue {
    return {
      sessionId: light.sessionId,
      wordPair: light.wordPair,
      senderFingerprint: light.senderFingerprint,
      display: light.display,
      onMatch(cb) {
        light.onMatch(cb);
      },
      notifyGo() {
        light.notifyGo();
      },
      reannounce() {
        light.reannounce();
      },
      start(cb) {
        light.start((keys) => {
          cb({ sessionKey: keys.sessionKey, channel: keys.channel, receiverFingerprint: keys.receiverFingerprint });
        });
      },
      onFailure(cb) {
        light.onFailure?.(cb);
      },
      stop() {
        light.stop();
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
      this.spawnStream(sessionKey, channel);
    });
  }

  /** (Re)start the stream on the negotiated channel. In broadcast mode
   *  (sound/light) this re-broadcasts the whole transfer from the start —
   *  used by "Broadcast again" so a receiver that missed the first passes
   *  can still catch the file. */
  private spawnStream(sessionKey: Uint8Array, channel: import("@core/transports").TransportEndpoint) {
    this.completedHash = null;
    this.cb.onTransferring();
    const broadcast = this.channel === "sound" || this.channel === "light";
    this.stream = new StreamSender(this.sessionId, sessionKey, this.source, {
      noAck: broadcast,
      chunkSize: broadcast ? (this.channel === "light" ? LIGHT_CHUNK_BYTES : SOUND_CHUNK_BYTES) : undefined,
      maxPasses: broadcast ? NO_ACK_PASSES : undefined,
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
    if (!this.statsTimer) {
      this.statsTimer = setInterval(() => {
        if (this.stream && !this.settled) this.cb.onStats(this.stream.stats.snapshot());
      }, 250);
    }
  }

  /** Broadcast channels only: re-start announcing so the other device can
   *  match and receive the transfer again. Resolves false when there's
   *  nothing to re-announce (e.g. already re-announcing). */
  resend(): boolean {
    if (this.settled || !this.queue) return false;
    const broadcast = this.channel === "sound" || this.channel === "light";
    if (!broadcast || !this.queue.reannounce) return false;
    this.stream?.cancel();
    this.stream = null;
    this.queue.reannounce();
    return true;
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