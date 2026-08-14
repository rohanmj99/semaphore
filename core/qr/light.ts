import QRCode from "qrcode/lib/core/qrcode";
import jsQR from "jsqr";
import type { TransportEndpoint } from "../transports.ts";
import { FrameParser, frameMessage } from "../frames.ts";
import { createSessionId, deriveKxSessionKey, fingerprint, keypair, wordPair } from "../crypto.ts";
import { fromBase64Url, nextId, toBase64Url } from "../util.ts";
import type { SessionAnnouncement, VisibleSession } from "../pairing.ts";

/**
 * Light channel — animated QR transport.
 *
 * Wire messages are split into fragments, one per QR code. The sender
 * displays one QR at a time (the UI cycles the fragment buffer every few
 * seconds); the receiver's camera scans continuously, decodes fragments and
 * reassembles messages. Like the sound channel there is a broadcast repair
 * model: while a message is current, its fragments are cycled forever, so a
 * missed QR is picked up on the next pass.
 */

export const LIGHT_FRAG_MAGIC1 = 0x53; // 'S'
export const LIGHT_FRAG_MAGIC2 = 0x51; // 'Q'
/** Total QR payload bytes (6-byte header + data). */
export const LIGHT_FRAG_SIZE = 1400;
/** Data bytes per QR fragment. */
export const LIGHT_FRAG_CAP = LIGHT_FRAG_SIZE - 6;
/** Recommended display pace between QR frames. */
export const LIGHT_FRAME_MS = 2500;

/**
 * Split one wire message into QR payloads:
 * [0x53][0x51][totalHi][totalLo][seq][len][data...]
 */
export function fragmentLight(frame: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0, seq = 0; off < frame.length || out.length === 0; off += LIGHT_FRAG_CAP, seq++) {
    const data = frame.subarray(off, off + LIGHT_FRAG_CAP);
    const frag = new Uint8Array(6 + data.length);
    frag[0] = LIGHT_FRAG_MAGIC1;
    frag[1] = LIGHT_FRAG_MAGIC2;
    frag[2] = (frame.length >> 8) & 0xff;
    frag[3] = frame.length & 0xff;
    frag[4] = seq & 0xff;
    frag[5] = data.length;
    frag.set(data, 6);
    out.push(frag);
  }
  return out;
}

/**
 * In-order fragment reassembly for light fragments. Delivers a complete wire
 * message or null when the stream is corrupt / out of sequence.
 */
export class QrReassembler {
  private expectedLen = 0;
  private nextSeq = 0;
  private got = 0;
  private parts: Uint8Array[] = [];

  reset(): void {
    this.expectedLen = 0;
    this.nextSeq = 0;
    this.got = 0;
    this.parts = [];
  }

  push(frag: Uint8Array): Uint8Array | null {
    if (
      frag.length < 6 ||
      frag.length > LIGHT_FRAG_SIZE ||
      frag[0] !== LIGHT_FRAG_MAGIC1 ||
      frag[1] !== LIGHT_FRAG_MAGIC2
    ) {
      this.reset();
      return null;
    }
    const totalLen = (frag[2] << 8) | frag[3];
    const seq = frag[4];
    const len = frag.length - 6;
    if (totalLen === 0 || totalLen > 64 * 1024 * 1024 || len < 1 || len > LIGHT_FRAG_CAP) {
      this.reset();
      return null;
    }
    if (seq === 0) {
      // First fragment of a fresh message — also recovers from a dropped fragment.
      this.expectedLen = totalLen;
      this.nextSeq = seq;
      this.got = 0;
      this.parts = [];
    } else if (this.expectedLen === 0 || totalLen !== this.expectedLen || seq !== this.nextSeq || this.got + len > this.expectedLen) {
      // Stray mid-message fragment — drop it and the partial message.
      this.reset();
      return null;
    }
    this.nextSeq = (seq + 1) & 0xff;
    this.parts.push(frag.slice(6, 6 + len));
    this.got += len;
    if (this.got === this.expectedLen) {
      let outLen = 0;
      for (const p of this.parts) outLen += p.length;
      const out = new Uint8Array(outLen);
      let off = 0;
      for (const p of this.parts) {
        out.set(p, off);
        off += p.length;
      }
      this.reset();
      return out;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* QR rendering + decoding                                             */

export interface QrMatrix {
  size: number;
  bits: Uint8Array;
}

/**
 * Encode bytes as a QR module matrix (byte mode, error correction M).
 * Throws if the payload is too large to fit a QR code.
 */
export function renderQr(data: Uint8Array, errorCorrectionLevel: "L" | "M" | "Q" | "H" = "M"): QrMatrix {
  const qr = QRCode.create([{ data, mode: "byte" }], { errorCorrectionLevel });
  const m = qr.modules as { size: number; data: Uint8Array };
  return { size: m.size, bits: new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength) };
}

/**
 * Rasterize a module matrix to RGBA pixels (black modules, white background,
 * with a surrounding quiet zone). Pure computation — works in tests and on
 * canvas via putImageData.
 */
export function paintQr(
  matrix: QrMatrix,
  scale = 8,
  quiet = 4,
): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const n = matrix.size;
  const size = (n + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const set = (x: number, y: number, v: number) => {
    const i = (y * size + x) * 4;
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = 255;
  };
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if ((matrix.bits[y * n + x] & 1) === 0) continue;
      const px = (x + quiet) * scale;
      const py = (y + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          set(px + dx, py + dy, 0);
        }
      }
    }
  }
  return { width: size, height: size, rgba };
}

/**
 * Decode a QR code from raw RGBA pixels. Returns the raw byte payload, or
 * null if nothing could be decoded.
 */
export function decodeQr(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array | null {
  const found = jsQR(rgba, width, height, { inversionAttempts: "attemptBoth" });
  if (!found) return null;
  return new Uint8Array(found.binaryData);
}

/* ------------------------------------------------------------------ */
/* Camera scanning                                                     */

export interface CameraHandle {
  stop(): void;
  framesScanned(): number;
}

function canGetVideo(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

export function lightSupported(): boolean {
  return canGetVideo();
}

/**
 * Scan a video stream for QRs. Decoded raw payloads are passed to onDecode.
 * The camera keeps running until stop() is called. If the camera is not
 * available, onError is fired (once) and a no-op handle is returned.
 */
export function startCameraDecoder(
  onDecode: (payload: Uint8Array) => void,
  opts: { onError?: (message: string) => void; preview?: HTMLElement } = {},
): CameraHandle {
  const W = 640;
  const H = 480;
  const preview = opts.preview ?? null;
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let raf = 0;
  let frame = 0;
  let scanned = 0;
  let stopped = false;
  let errSent = false;

  if (!canGetVideo()) {
    queueMicrotask(() => {
      if (!stopped && !errSent) {
        errSent = true;
        opts.onError?.("Camera isn\u2019t available in this browser.");
      }
    });
    return { stop() {}, framesScanned: () => 0 };
  }

  const tick = () => {
    if (stopped || !video || !canvas) return;
    if (video.readyState >= 2) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        canvas.width = W;
        canvas.height = H;
        ctx.drawImage(video, 0, 0, W, H);
        frame++;
        if (frame % 3 === 0) {
          const img = ctx.getImageData(0, 0, W, H);
          scanned++;
          try {
            const payload = decodeQr(img.data, W, H);
            if (payload) onDecode(payload);
          } catch {
            /* skip */
          }
        }
      }
    }
    raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : 0;
  };

  Promise.resolve()
    .then(() =>
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      }),
    )
    .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }))
    .then((s) => {
      if (stopped) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      video = document.createElement("video");
      video.srcObject = s;
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.autoplay = true;
      canvas = document.createElement("canvas");
      if (preview) preview.replaceChildren(video);
      void video.play().then(() => {
        raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : 0;
      });
    })
    .catch(() => {
      if (!stopped && !errSent) {
        errSent = true;
        opts.onError?.("Couldn\u2019t start the camera (permission denied?).");
      }
    });

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (video) {
        video.pause?.();
        video.srcObject = null;
        video.remove();
      }
      video = null;
      canvas = null;
    },
    framesScanned: () => scanned,
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */

export interface LightTransportOptions {
  tx?: boolean;
  rx?: boolean;
  camera?: boolean;
  preview?: HTMLElement;
}

/**
 * Light transport. The tx side holds one message's fragment buffer, which the
 * UI cycles through for display (currentFrag/advance). The rx side accepts
 * camera images (feedImage) — startCameraDecoder bridges a live camera when
 * `camera: true`.
 */
export class LightTransport implements TransportEndpoint {
  readonly kind = "light" as const;
  readonly id = nextId();
  private readonly txOn: boolean;
  private readonly reassembler = new QrReassembler();
  private readonly parser = new FrameParser();
  private frags: Uint8Array[] = [];
  private cursor = 0;
  private cam: CameraHandle | null = null;
  private msgHandlers = new Set<(frame: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private closed = false;
  private rescanned = 0;
  private resFrags = 0;
  private lastDecode = 0;

  constructor(opts: LightTransportOptions = {}) {
    this.txOn = opts.tx !== false;
    if (opts.camera) {
      this.cam = startCameraDecoder((payload) => this.onQrPayload(payload), { preview: opts.preview });
    }
  }

  get framesScanned(): number {
    return this.rescanned;
  }

  get fragmentsDecoded(): number {
    return this.resFrags;
  }

  get lastDecodeMs(): number {
    return this.lastDecode;
  }

  /** The QR fragment currently on display, or null while idle. */
  currentFrag(): Uint8Array | null {
    return this.frags.length > 0 ? this.frags[this.cursor] : null;
  }

  /** Advance the display to the next fragment, cycling. */
  advance(): void {
    if (this.frags.length > 0) this.cursor = (this.cursor + 1) % this.frags.length;
  }

  /** Buffered message length in fragments (0 when idle). */
  get fragmentCount(): number {
    return this.frags.length;
  }

  send(frame: Uint8Array): void {
    if (this.closed || !this.txOn) return;
    this.frags = fragmentLight(frame);
    this.cursor = 0;
  }

  /** Feed one decoded camera image into the rx pipeline. */
  feedImage(rgba: Uint8ClampedArray, width: number, height: number): void {
    if (this.closed) return;
    this.rescanned++;
    let payload: Uint8Array | null = null;
    try {
      payload = decodeQr(rgba, width, height);
    } catch {
      payload = null;
    }
    if (payload) this.onQrPayload(payload);
  }

  private onQrPayload(payload: Uint8Array): void {
    if (this.closed) return;
    this.resFrags++;
    this.lastDecode = Date.now();
    const wire = this.reassembler.push(payload);
    if (!wire) return;
    let complete: Uint8Array[] = [];
    try {
      complete = this.parser.push(wire);
    } catch {
      this.parser.reset();
      return;
    }
    for (const c of complete) {
      for (const cb of [...this.msgHandlers]) cb(c);
    }
  }

  onMessage(cb: (frame: Uint8Array) => void): () => void {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  /**
   * Display pacing: resolves after one full rotation of the current
   * fragment buffer, so the UI can show every fragment for LIGHT_FRAME_MS
   * before the next message replaces it on screen.
   */
  idle(): Promise<void> {
    const rotations = Math.max(this.frags.length, 1) * LIGHT_FRAME_MS;
    return new Promise((r) => setTimeout(r, rotations));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cam?.stop();
    this.cam = null;
    this.frags = [];
    for (const cb of [...this.closeHandlers]) cb();
    this.msgHandlers.clear();
    this.closeHandlers.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Pairing over light                                                  */

export interface LightSenderQueue {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  /** The display transport — the UI reads currentFrag()/advance() from it. */
  readonly display: LightTransport;
  onMatch(cb: (peer: { receiverFingerprint: string; receiverPub: string }) => void): void;
  notifyGo(): void;
  start(
    cb: (keys: { sessionKey: Uint8Array; channel: TransportEndpoint; receiverFingerprint: string }) => void,
  ): void;
  onFailure?(cb: (message: string) => void): void;
  stop(): void;
}

const DEFAULT_BURST_MS = 2500;

export interface LightAnnounceOptions {
  announceEveryMs?: number;
  listenMs?: number;
  burstMs?: number;
}

export function advertiseLight(
  file: { name: string; size: number } | null,
  opts: LightAnnounceOptions = {},
): LightSenderQueue {
  const burstMs = opts.burstMs ?? DEFAULT_BURST_MS;
  const kp = keypair();
  const sessionId = createSessionId();
  const pair = wordPair(kp.publicKey);
  const fp = fingerprint(kp.publicKey);
  const display = new LightTransport({ tx: true, rx: false });
  const camera = new LightTransport({ tx: false, rx: true, camera: true });
  const parser = new FrameParser();

  const announcement: SessionAnnouncement = {
    sessionId,
    wordPair: pair,
    senderFingerprint: fp,
    senderPub: toBase64Url(kp.publicKey),
    file: file ? { name: file.name.slice(0, 80), size: file.size } : null,
  };
  const announceFrame = frameMessage(new TextEncoder().encode(JSON.stringify(announcement)));

  const matchHandlers = new Set<(peer: { receiverFingerprint: string; receiverPub: string }) => void>();
  const startHandlers = new Set<(keys: { sessionKey: Uint8Array; channel: TransportEndpoint; receiverFingerprint: string }) => void>();
  const failureHandlers = new Set<(message: string) => void>();

  let matchedPub: Uint8Array | null = null;
  let matchedFp = "";
  let matched = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (!canGetVideo()) {
    queueMicrotask(() => {
      for (const cb of [...failureHandlers]) cb("Camera isn\u2019t available in this browser.");
    });
  }

  const unsub = camera.onMessage((frame) => {
    for (const f of parser.push(frame)) {
      let m: { t?: string; sid?: string; pub?: string; fp?: string };
      try {
        m = JSON.parse(new TextDecoder().decode(f)) as typeof m;
      } catch {
        continue;
      }
      if (!matched && m.t === "match" && m.sid === sessionId && typeof m.pub === "string" && typeof m.fp === "string") {
        matched = true;
        try {
          matchedPub = fromBase64Url(m.pub);
        } catch {
          matchedPub = null;
        }
        matchedFp = m.fp;
        if (timer) clearInterval(timer);
        timer = null;
        for (const cb of [...matchHandlers]) cb({ receiverFingerprint: m.fp, receiverPub: m.pub });
      }
    }
  });

  display.send(announceFrame);
  if (canGetVideo()) {
    timer = setInterval(() => {
      if (!stopped && !matched) display.send(announceFrame);
    }, burstMs);
  }

  return {
    sessionId,
    wordPair: pair,
    senderFingerprint: fp,
    display,
    onMatch(cb) {
      matchHandlers.add(cb);
    },
    notifyGo() {
      if (stopped || matchedPub === null) return;
      if (timer) clearInterval(timer);
      timer = null;
      const goFrame = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "go", sid: sessionId })));
      let plays = 0;
      const burst = () => {
        if (stopped || plays >= 3) return;
        plays++;
        display.send(goFrame);
        if (!stopped) setTimeout(burst, 800);
      };
      burst();
      const sessionKey = deriveKxSessionKey(sessionId, matchedPub as Uint8Array, kp.secretKey).key;
      const receiverFingerprint = matchedFp;
      for (const cb of [...startHandlers]) {
        cb({ sessionKey, channel: display, receiverFingerprint });
      }
    },
    start(cb) {
      startHandlers.add(cb);
    },
    onFailure(cb) {
      failureHandlers.add(cb);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      unsub();
      display.close();
      camera.close();
      matchHandlers.clear();
      startHandlers.clear();
      failureHandlers.clear();
    },
  };
}

export interface LightMatcher {
  readonly pin: { sessionId: string; sessionKey: Uint8Array; channel: TransportEndpoint } | null;
  /** The display transport for the match QR while pairing. */
  readonly display: LightTransport;
  confirm(): void;
  onGo(cb: () => void): void;
  postReady(): void;
  onFailure?(cb: (message: string) => void): void;
  cancel(): void;
}

export function matchLightSession(
  session: VisibleSession,
  opts: LightAnnounceOptions = {},
): LightMatcher {
  const burstMs = opts.burstMs ?? DEFAULT_BURST_MS;
  const kp = keypair();
  const receiverFp = fingerprint(kp.publicKey);
  const channel = new LightTransport({ tx: true, rx: true, camera: true });
  const parser = new FrameParser();
  const goHandlers = new Set<() => void>();
  const failureHandlers = new Set<(message: string) => void>();
  let pin: { sessionId: string; sessionKey: Uint8Array; channel: TransportEndpoint } | null = null;
  let goDone = false;
  let stopped = false;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  const unsub = channel.onMessage((frame) => {
    for (const f of parser.push(frame)) {
      let m: { t?: string; sid?: string };
      try {
        m = JSON.parse(new TextDecoder().decode(f)) as typeof m;
      } catch {
        continue;
      }
      if ((m.t === "go" || m.t === "hello") && m.sid === session.sessionId && !goDone) {
        // "go" is explicit; "hello" is the sender's first transfer frame and
        // doubles as a fallback if the go burst was missed by the camera.
        goDone = true;
        for (const cb of [...goHandlers]) cb();
      }
    }
  });

  if (!canGetVideo()) {
    queueMicrotask(() => {
      for (const cb of [...failureHandlers]) cb("Camera isn\u2019t available in this browser.");
    });
  }

  return {
    get pin() {
      return pin;
    },
    display: channel as unknown as LightTransport,
    confirm() {
      if (pin || stopped) return;
      const senderPub = fromBase64Url(session.senderPub);
      const sessionKey = deriveKxSessionKey(session.sessionId, senderPub, kp.secretKey).key;
      pin = {
        sessionId: session.sessionId,
        sessionKey,
        channel,
      };
      const matchFrame = frameMessage(
        new TextEncoder().encode(
          JSON.stringify({
            t: "match",
            sid: session.sessionId,
            pub: toBase64Url(kp.publicKey),
            fp: receiverFp,
          }),
        ),
      );
      const burst = () => {
        if (stopped || goDone) return;
        channel.send(matchFrame);
        burstTimer = setTimeout(burst, burstMs);
      };
      burst();
    },
    onGo(cb) {
      goHandlers.add(cb);
    },
    postReady() {
      /* light has no return path after go — the sender re-sends everything */
    },
    onFailure(cb) {
      failureHandlers.add(cb);
    },
    cancel() {
      stopped = true;
      if (burstTimer) clearTimeout(burstTimer);
      burstTimer = null;
      unsub();
      channel.close();
      goHandlers.clear();
      failureHandlers.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Nearby scanning over light                                          */

export interface LightScanHandle {
  stop(): void;
  framesScanned(): number;
}

export function scanLightSessions(
  onSessions: (list: VisibleSession[]) => void,
  onError?: (message: string) => void,
  opts: { preview?: HTMLElement } = {},
): LightScanHandle {
  const camera = new LightTransport({ tx: false, rx: true, camera: true, preview: opts.preview });
  const parser = new FrameParser();
  const map = new Map<string, VisibleSession>();
  let stopped = false;

  const unsub = camera.onMessage((frame) => {
    if (stopped) return;
    for (const f of parser.push(frame)) {
      let d: Partial<SessionAnnouncement>;
      try {
        d = JSON.parse(new TextDecoder().decode(f)) as Partial<SessionAnnouncement>;
      } catch {
        continue;
      }
      if (typeof d.sessionId !== "string" || typeof d.wordPair !== "string" || typeof d.senderPub !== "string") continue;
      try {
        fromBase64Url(d.senderPub);
      } catch {
        continue;
      }
      map.set(d.sessionId, {
        sessionId: d.sessionId,
        wordPair: d.wordPair,
        senderFingerprint: typeof d.senderFingerprint === "string" ? d.senderFingerprint : "",
        senderPub: d.senderPub,
        file: d.file && typeof d.file.name === "string" ? { name: d.file.name, size: Number(d.file.size) || 0 } : null,
        seenAt: Date.now(),
      });
      onSessions([...map.values()].sort((a, b) => a.seenAt - b.seenAt));
    }
  });

  if (!canGetVideo()) {
    queueMicrotask(() => {
      onError?.("Camera isn\u2019t available in this browser.");
    });
  }

  return {
    stop() {
      stopped = true;
      unsub();
      camera.close();
    },
    framesScanned: () => camera.framesScanned,
  };
}