import { matchSession, type VisibleSession } from "@core/pairing";
import { matchOnlineSession, fetchAnnouncement } from "@core/online";
import { StreamReceiver } from "@core/session";
import type { ManifestHeader, ProgressStats } from "@core/types";
import type { NegotiatorState } from "@core/webrtc";
import { crc32 } from "@core/crc32";
import { iceServersConfig, mailboxForSession } from "../config.ts";

export interface ReceiveCallbacks {
  onTransferring(): void;
  onStats(stats: ProgressStats): void;
  onDone(result: { data: Uint8Array; header: ManifestHeader; hash: string }): void;
  onError(message: string): void;
  onNote?(note: string | null): void;
}

interface MatcherLike {
  readonly pin: { sessionId: string; sessionKey: Uint8Array; channel: import("@core/transports").TransportEndpoint } | null;
  confirm(): void;
  onGo(cb: () => void): void;
  postReady(): void;
  onState?(cb: (state: NegotiatorState) => void): void;
  onFailure?(cb: (message: string) => void): void;
  cancel(): void;
}

const HEADER_TIMEOUT_MS = 30_000;
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export class ReceiveController {
  readonly session: VisibleSession;
  private matcher: MatcherLike;
  private receiver: StreamReceiver | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private started = false;

  constructor(session: VisibleSession, private readonly cb: ReceiveCallbacks, matcher: MatcherLike = matchSession(session)) {
    this.session = session;
    this.matcher = matcher;
    matcher.onState?.((state) => {
      if (this.settled) return;
      this.cb.onNote?.(state === "reconnecting" ? "Trying to reconnect…" : null);
    });
    matcher.onFailure?.((message) => {
      if (this.settled) return;
      this.cb.onError(message);
    });
    if (matcher.onState) {
      this.confirmTimer = setTimeout(() => {
        if (!this.settled) {
          this.cb.onError("The other device didn't connect. Ask them to try again.");
        }
      }, CONFIRM_TIMEOUT_MS);
    }
  }

  static async openOnline(sessionId: string, cb: ReceiveCallbacks): Promise<ReceiveController> {
    const announce = await fetchAnnouncement(sessionId, mailboxForSession);
    if (announce.file && announce.file.size > 0) {
      const problem = await ensureStorageFits(announce.file.size);
      if (problem) throw new Error(problem);
    }
    const matcher = matchOnlineSession(announce, mailboxForSession, { iceServers: iceServersConfig() });
    return new ReceiveController(announce, cb, matcher);
  }

  get wordPair(): string {
    return this.session.wordPair;
  }

  get senderFingerprint(): string {
    return this.session.senderFingerprint;
  }

  confirm() {
    if (this.started || this.settled) return;
    this.started = true;
    this.matcher.confirm();
    this.matcher.onGo(() => {
      if (this.settled) return;
      this.handleGo();
    });
  }

  private handleGo() {
    const pin = this.matcher.pin;
    if (!pin || this.settled) return;
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    this.cb.onTransferring();
    this.matcher.postReady();
    this.receiver = new StreamReceiver(pin.sessionId, pin.sessionKey, (e) => {
      if (this.settled) return;
      if (e.type === "error") this.cb.onError(e.message);
    });
    this.receiver.onComplete((r) => {
      if (this.settled) return;
      this.settleTimeouts();
      if (r.ok) {
        const hash = crc32(r.data).toString(16).padStart(8, "0");
        this.cb.onDone({ data: r.data, header: r.header, hash });
      } else {
        this.cb.onError(r.message);
      }
    });
    this.receiver.start(pin.channel);
    if (pin.channel.kind === "loopback") {
      pin.channel.onClose(() => {
        if (!this.settled && !this.receiver?.engine.allReceived) {
          this.cb.onError("Sending stopped before it finished.");
        }
      });
    }
    this.statsTimer = setInterval(() => {
      if (this.receiver && !this.settled) this.cb.onStats(this.receiver.stats.snapshot());
    }, 250);
    this.timeout = setTimeout(() => {
      if (!this.settled && !this.receiver?.engine.header) {
        this.cb.onError("The sender didn't respond. Try again.");
      }
    }, HEADER_TIMEOUT_MS);
  }

  cancel() {
    this.settled = true;
    this.settleTimeouts();
    this.matcher.cancel();
  }

  private settleTimeouts() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.timeout) clearTimeout(this.timeout);
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.statsTimer = null;
    this.timeout = null;
    this.confirmTimer = null;
  }
}

/** Fails fast with a message when the file clearly won't fit in storage. */
export async function ensureStorageFits(size: number): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    const quota = est.quota ?? Infinity;
    if (quota === Infinity) return null;
    const used = est.usage ?? 0;
    if (quota - used < size) {
      return "Not enough storage left on this device to hold the file.";
    }
    return null;
  } catch {
    return null;
  }
}