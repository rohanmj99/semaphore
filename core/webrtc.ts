import type { TransportEndpoint } from "./transports.ts";
import { nextId } from "./util.ts";
import type { Mailbox } from "./mailbox.ts";
import { parseMailboxJson, putWithRetry, sleepMs } from "./mailbox.ts";

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  binaryType: string;
  readonly bufferedAmount: number;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: Event) => void) | null;
  onerror: ((ev: RTCErrorEvent) => void) | null;
}

/** Largest single message an SCTP data channel will carry (Chromium: 256 KiB). */
const FRAGMENT_MAX = 60 * 1024;
const FRAG_FIRST = 0xf1;
const FRAG_NEXT = 0xf2;

export class DataChannelTransport implements TransportEndpoint {
  readonly kind = "online" as const;
  readonly id = nextId();
  peerClosed = false;
  private dc: DataChannelLike | null = null;
  private queue: Uint8Array[] = [];
  private opened = false;
  private closed = false;
  private msgHandlers = new Set<(frame: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private openHandlers = new Set<() => void>();
  private peerCloseHandlers = new Set<() => void>();
  private fragSeq = 0;
  private fragments = new Map<
    number,
    { total: number; parts: Uint8Array[] }
  >();

  attach(dc: DataChannelLike): void {
    if (this.closed) {
      dc.close();
      return;
    }
    this.dc = dc;
    this.opened = false;
    this.peerClosed = false;
    this.fragments.clear();
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => {
      const data = ev.data;
      let frame: Uint8Array;
      if (data instanceof ArrayBuffer) {
        frame = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        return;
      }
      const assembled = this.accept(frame);
      if (assembled) {
        for (const cb of [...this.msgHandlers]) cb(assembled);
      }
    };
    dc.onerror = () => {};
    dc.onclose = () => {
      this.peerClosed = true;
      for (const cb of [...this.peerCloseHandlers]) cb();
    };
    if (dc.readyState === "open") {
      this.markOpen();
    } else {
      dc.onopen = () => this.markOpen();
    }
  }

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error("channel closed");
    // SCTP data channels cap each message (Chromium: 256 KiB), so chunk
    // frames must be split and reassembled on the receiving side.
    if (frame.length <= FRAGMENT_MAX) {
      if (!this.dc || this.dc.readyState !== "open") {
        this.queue.push(frame);
        return;
      }
      this.transmit(frame);
      return;
    }
    const id = ++this.fragSeq & 0xffff;
    const total = Math.ceil(frame.length / FRAGMENT_MAX);
    for (let i = 0; i < total; i++) {
      const start = i * FRAGMENT_MAX;
      const slice = frame.subarray(start, Math.min(start + FRAGMENT_MAX, frame.length));
      const header = new Uint8Array(4);
      header[0] = i === 0 ? FRAG_FIRST : FRAG_NEXT;
      header[1] = (id >> 8) & 0xff;
      header[2] = id & 0xff;
      header[3] = i === 0 ? total : i;
      const part = new Uint8Array(4 + slice.length);
      part.set(header);
      part.set(slice, 4);
      if (!this.dc || this.dc.readyState !== "open") {
        this.queue.push(part);
        continue;
      }
      this.transmit(part);
    }
  }

  /** Reassemble fragment parts; returns a complete frame or null. */
  private accept(packet: Uint8Array): Uint8Array | null {
    if (packet.length < 1) return null;
    if (packet[0] !== FRAG_FIRST && packet[0] !== FRAG_NEXT) return packet;
    if (packet.length < 4) return null;
    const id = (packet[1] << 8) | packet[2];
    const payload = packet.subarray(4);
    const entry = this.fragments.get(id);
    if (packet[0] === FRAG_FIRST) {
      const total = packet[3];
      if (total < 1 || total > 4096) return null;
      this.fragments.set(id, { total, parts: [payload] });
      return null;
    }
    if (!entry) return null;
    const index = packet[3];
    if (index < 1 || index >= entry.total) return null;
    entry.parts[index] = payload;
    if (entry.parts.length < entry.total) return null;
    this.fragments.delete(id);
    let length = 0;
    for (const part of entry.parts) length += part.length;
    const frame = new Uint8Array(length);
    let offset = 0;
    for (const part of entry.parts) {
      frame.set(part, offset);
      offset += part.length;
    }
    return frame;
  }

  onMessage(cb: (frame: Uint8Array) => void): () => void {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  onOpen(cb: () => void): () => void {
    this.openHandlers.add(cb);
    return () => this.openHandlers.delete(cb);
  }

  onPeerClose(cb: () => void): () => void {
    this.peerCloseHandlers.add(cb);
    return () => this.peerCloseHandlers.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dc?.close();
    } catch {
      /* already closed */
    }
    this.handleClose();
  }

  private markOpen(): void {
    if (this.opened || this.closed) return;
    this.opened = true;
    this.flush();
    for (const cb of [...this.openHandlers]) cb();
  }

  private transmit(frame: Uint8Array): void {
    try {
      this.dc?.send(this.bufferOf(frame));
    } catch {
      this.queue.push(frame);
    }
  }

  private flush(): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return;
    while (this.queue.length > 0) {
      const frame = this.queue.shift() as Uint8Array;
      try {
        dc.send(this.bufferOf(frame));
      } catch {
        this.queue.unshift(frame);
        return;
      }
    }
  }

  private bufferOf(frame: Uint8Array): ArrayBuffer {
    if (frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength) {
      return frame.buffer as ArrayBuffer;
    }
    return frame.slice().buffer;
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of [...this.closeHandlers]) cb();
    this.msgHandlers.clear();
    this.closeHandlers.clear();
  }
}

export type NegotiatorState = "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface NegotiatorOptions {
  role: "initiator" | "responder";
  mailbox: Mailbox;
  sessionId: string;
  iceServers: RTCIceServer[];
  pcFactory?: () => RTCPeerConnection;
  onState?: (state: NegotiatorState) => void;
  onFailure?: (message: string) => void;
  connectTimeoutMs?: number;
  restartWaitMs?: number;
  pollMs?: number;
}

interface SdpPayload {
  sdp: string;
}

interface IcePayload {
  from: "s" | "r";
  candidate?: RTCIceCandidateInit;
}

const CONNECT_TIMEOUT_MS = 75_000;
const RESTART_WAIT_MS = 45_000;
const POLL_MS = 900;
const ICE_QUIET_MS = 5_000;

export class WebRtcNegotiator {
  readonly transport = new DataChannelTransport();
  private readonly pc: RTCPeerConnection;
  private readonly opts: NegotiatorOptions;
  private stopped = false;
  private failed = false;
  private open = false;
  private recovering = false;
  private restartTried = false;
  private lastOfferSdp: string | null = null;
  private lastAnswerSdp: string | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;
  private cursors = new Map<string, number>();
  private lastIceSeen = 0;
  private loopDone = true;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: NegotiatorOptions) {
    this.opts = opts;
    this.pc = opts.pcFactory ? opts.pcFactory() : new RTCPeerConnection({ iceServers: opts.iceServers });
    this.pc.onicecandidate = (e) => {
      if (!e.candidate || this.stopped) return;
      const payload: IcePayload = { from: this.opts.role === "initiator" ? "r" : "s", candidate: e.candidate.toJSON() };
      void putWithRetry(opts.mailbox, "ice", JSON.stringify(payload));
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        void this.handleDcLost();
      }
    };
    this.transport.onPeerClose(() => {
      if (!this.stopped && !this.failed) {
        void this.handleDcLost();
      }
    });
    this.transport.onOpen(() => this.markOpen());
  }

  start(): void {
    if (this.opts.role === "initiator") {
      this.createChannel();
      this.opts.onState?.("connecting");
      void this.negotiateInitiator();
    } else {
      this.pc.ondatachannel = (e) => {
        this.transport.attach(e.channel as DataChannelLike);
      };
      this.opts.onState?.("connecting");
      void this.negotiateResponder();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.transport.close();
    this.opts.onState?.("closed");
  }

  private createChannel(): void {
    const dc = this.pc.createDataChannel("data", { ordered: true });
    this.transport.attach(dc);
  }

  private async negotiateInitiator(): Promise<void> {
    try {
      await this.postOffer();
      await this.mainLoop("answer");
    } catch {
      this.fail("Couldn't connect directly to the other device. Try again.");
    }
  }

  private async negotiateResponder(): Promise<void> {
    try {
      await this.mainLoop("offer");
    } catch {
      this.fail("Couldn't connect directly to the other device. Try again.");
    }
  }

  private async postOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    if (!offer.sdp) throw new Error("offer has no sdp");
    await this.pc.setLocalDescription(offer);
    const ok = await putWithRetry(this.opts.mailbox, "offer", JSON.stringify({ sdp: offer.sdp } satisfies SdpPayload));
    if (!ok) this.fail("Live relay unavailable — try another channel.");
  }

  private async mainLoop(selfKind: "offer" | "answer"): Promise<void> {
    const connectTimeout = this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const startedAt = Date.now();
    this.lastIceSeen = Date.now();
    try {
      while (!this.stopped && !this.failed) {
        if (this.open && this.remoteDescSet && Date.now() - this.lastIceSeen > ICE_QUIET_MS) {
          return;
        }
        const page = await this.opts.mailbox.get(selfKind, this.cursorOf(selfKind));
        if (page.now > this.cursorOf(selfKind)) {
          this.advance(selfKind, page.now);
          for (const entry of page.entries) {
            const msg = parseMailboxJson<SdpPayload>(entry.p);
            if (!msg || typeof msg.sdp !== "string") continue;
            if (selfKind === "answer") {
              await this.applyAnswer(msg.sdp);
            } else {
              await this.applyOffer(msg.sdp);
            }
          }
        }
        await this.pollIce();
        if (!this.open && !this.recovering && Date.now() - startedAt > connectTimeout) {
          return this.fail("Couldn't connect directly to the other device. Try again.");
        }
        if (this.stopped || this.failed) return;
        await sleepMs(this.opts.pollMs ?? POLL_MS);
      }
    } finally {
      this.loopDone = true;
    }
  }

  private async applyOffer(sdp: string): Promise<void> {
    if (sdp === this.lastOfferSdp) return;
    this.lastOfferSdp = sdp;
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    this.remoteDescSet = true;
    this.flushCandidates();
    const answer = await this.pc.createAnswer();
    if (!answer.sdp) throw new Error("answer has no sdp");
    await this.pc.setLocalDescription(answer);
    const ok = await putWithRetry(this.opts.mailbox, "answer", JSON.stringify({ sdp: answer.sdp } satisfies SdpPayload));
    if (!ok) this.fail("Live relay unavailable — try another channel.");
  }

  private async applyAnswer(sdp: string): Promise<void> {
    if (sdp === this.lastAnswerSdp) return;
    this.lastAnswerSdp = sdp;
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    this.remoteDescSet = true;
    this.flushCandidates();
  }

  private async pollIce(): Promise<void> {
    const page = await this.opts.mailbox.get("ice", this.cursorOf("ice"));
    if (page.now > this.cursorOf("ice")) {
      this.advance("ice", page.now);
      for (const entry of page.entries) {
        const msg = parseMailboxJson<IcePayload>(entry.p);
        if (!msg || typeof msg.from !== "string") continue;
        if (msg.from === (this.opts.role === "initiator" ? "r" : "s")) continue;
        if (!msg.candidate) continue;
        this.lastIceSeen = Date.now();
        if (this.remoteDescSet) {
          try {
            await this.pc.addIceCandidate(msg.candidate);
          } catch {
            /* stale candidate */
          }
        } else {
          this.pendingCandidates.push(msg.candidate);
        }
      }
    }
  }

  private cursorOf(kind: string): number {
    return this.cursors.get(kind) ?? 0;
  }

  private advance(kind: string, now: number): void {
    this.cursors.set(kind, now);
  }

  private flushCandidates(): void {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift() as RTCIceCandidateInit;
      try {
        void this.pc.addIceCandidate(candidate).catch(() => {});
      } catch {
        /* dropped */
      }
    }
  }

  private markOpen(): void {
    if (this.open || this.stopped) return;
    this.open = true;
    this.recovering = false;
    this.clearTimers();
    this.opts.onState?.("open");
  }

  private async handleDcLost(): Promise<void> {
    if (this.stopped || this.failed || this.recovering) return;
    if (!this.open) return;
    if (this.restartTried) {
      return this.fail("The connection between the two devices was lost.");
    }
    this.open = false;
    this.recovering = true;
    this.restartTried = true;
    this.opts.onState?.("reconnecting");
    if (this.opts.role === "initiator") {
      try {
        if (typeof this.pc.restartIce === "function") this.pc.restartIce();
        await this.postOffer();
        this.createChannel();
      } catch {
        return this.fail("The connection between the two devices was lost.");
      }
    }
    if (this.loopDone) {
      this.loopDone = false;
      void this.mainLoop(this.opts.role === "initiator" ? "answer" : "offer");
    }
    this.deadlineTimer = setTimeout(() => {
      if (!this.open && !this.stopped) {
        this.fail("The connection between the two devices was lost.");
      }
    }, this.opts.restartWaitMs ?? RESTART_WAIT_MS);
  }

  private fail(message: string): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.clearTimers();
    this.opts.onState?.("failed");
    this.opts.onFailure?.(message);
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.transport.close();
  }

  private clearTimers(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}