import QRCode from "qrcode/lib/core/qrcode";
import jsQR from "jsqr";
import type { TransportEndpoint } from "../transports.ts";
import { FrameParser, frameMessage } from "../frames.ts";
import { createSessionId, deriveKxSessionKey, fingerprint, keypair, wordPair } from "../crypto.ts";
import { crc16 } from "../crc16.ts";
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
 * Fountain symbols — one QR per encoded symbol, no fragmentation or ordering.
 *
 * Each symbol is its own broadcast unit: the header carries the total symbol
 * count K (2 bytes), the encoded symbol id (4 bytes), the payload length and a
 * per-symbol CRC16. The receiver collects K+ε symbols in any order, missing
 * frames are simply re-collected from the next pass, and the LT decoder
 * recovers the file once enough independent symbols arrive.
 *
 * Layout: [0x53][0x46][kHi][kLo][id 0..3][lenHi][lenLo][crcHi][crcLo][data...]
 */
export const FOUNTAIN_MAGIC1 = 0x53; // 'S'
export const FOUNTAIN_MAGIC2 = 0x46; // 'F'
export const FOUNTAIN_HEADER = 12;
/** Data bytes per fountain symbol (total symbol count capped by 2-byte field). */
export const FOUNTAIN_MAX_K = 0xffff;
export const FOUNTAIN_MAX_PAYLOAD = LIGHT_FRAG_SIZE - FOUNTAIN_HEADER;

/** Wrap an encoded symbol payload as a self-contained QR payload. */
export function fountainSymbol(k: number, id: number, data: Uint8Array): Uint8Array {
  if (data.length < 1 || data.length > FOUNTAIN_MAX_PAYLOAD) {
    throw new Error(`fountain symbol payload ${data.length} out of range`);
  }
  const out = new Uint8Array(FOUNTAIN_HEADER + data.length);
  out[0] = FOUNTAIN_MAGIC1;
  out[1] = FOUNTAIN_MAGIC2;
  out[2] = (k >> 8) & 0xff;
  out[3] = k & 0xff;
  new DataView(out.buffer).setUint32(4, id >>> 0, false);
  out[8] = (data.length >> 8) & 0xff;
  out[9] = data.length & 0xff;
  const c = crc16(data);
  out[10] = (c >> 8) & 0xff;
  out[11] = c & 0xff;
  out.set(data, FOUNTAIN_HEADER);
  return out;
}

/** Parse and CRC-verify a fountain symbol QR payload, or null when corrupt. */
export function parseFountainSymbol(
  payload: Uint8Array,
): { k: number; id: number; data: Uint8Array } | null {
  if (
    payload.length < FOUNTAIN_HEADER ||
    payload[0] !== FOUNTAIN_MAGIC1 ||
    payload[1] !== FOUNTAIN_MAGIC2
  ) {
    return null;
  }
  const k = (payload[2] << 8) | payload[3];
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const id = dv.getUint32(4, false);
  const len = (payload[8] << 8) | payload[9];
  if (len < 1 || len > FOUNTAIN_MAX_PAYLOAD || payload.length !== FOUNTAIN_HEADER + len) return null;
  const data = payload.slice(FOUNTAIN_HEADER, FOUNTAIN_HEADER + len);
  const c = (payload[10] << 8) | payload[11];
  if (crc16(data) !== c) return null;
  return { k, id, data };
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

export interface QrDesign {
  /** Module ink color, default black. */
  ink?: readonly [number, number, number];
  /** Paper (background) color, default white. */
  paper?: readonly [number, number, number];
  /** Module corner rounding as a fraction of a module (0–0.5). */
  round?: number;
}

/**
 * Rasterize a module matrix to RGBA pixels (black modules, white background,
 * with a surrounding quiet zone). Pure computation — works in tests and on
 * canvas via putImageData. A custom design (ink/paper color, rounded module
 * corners) keeps the QR decodable — jsQR only needs dark/light contrast.
 */
export function paintQr(
  matrix: QrMatrix,
  scale = 8,
  quiet = 4,
  design: QrDesign = {},
): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const n = matrix.size;
  const size = (n + quiet * 2) * scale;
  const ink = design.ink ?? [0, 0, 0];
  const paper = design.paper ?? [255, 255, 255];
  const r = Math.max(0, Math.min(0.5, design.round ?? 0)) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const set = (x: number, y: number, v: readonly [number, number, number]) => {
    const i = (y * size + x) * 4;
    rgba[i] = v[0];
    rgba[i + 1] = v[1];
    rgba[i + 2] = v[2];
    rgba[i + 3] = 255;
  };
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = paper[0];
    rgba[i * 4 + 1] = paper[1];
    rgba[i * 4 + 2] = paper[2];
    rgba[i * 4 + 3] = 255;
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if ((matrix.bits[y * n + x] & 1) === 0) continue;
      const px = (x + quiet) * scale;
      const py = (y + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          let dark = true;
          if (r > 0) {
            // Distance to the nearest module edge — rounded corners cut the
            // pixels past the corner radius.
            const nx = Math.min(dx, scale - 1 - dx);
            const ny = Math.min(dy, scale - 1 - dy);
            if (nx < r && ny < r) {
              const cx = r - nx - 0.5;
              const cy = r - ny - 0.5;
              if (cx * cx + cy * cy > r * r) dark = false;
            }
          }
          if (dark) set(px + dx, py + dy, ink);
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

export type CameraFacing = "environment" | "user";

export interface CameraHandle {
  stop(): void;
  framesScanned(): number;
  /** Current camera facing, or null if the camera never started. */
  facing(): CameraFacing | null;
  /** Swap between the front and back cameras. Resolves false if the
   *  switch failed (e.g. one camera only) and the previous stream stays. */
  switchCamera(): Promise<boolean>;
  /** Attach the live video element to a preview container. */
  attachPreview(el: HTMLElement): void;
  /** Milliseconds since a QR was last decoded from the stream (0 = never). */
  lastDecodeMs(): number;
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
  opts: { onError?: (message: string) => void; preview?: HTMLElement; facing?: CameraFacing } = {},
): CameraHandle {
  const W = 640;
  const H = 480;
  let preview = opts.preview ?? null;
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let host: HTMLDivElement | null = null;
  let raf = 0;
  let frame = 0;
  let scanned = 0;
  let stopped = false;
  let errSent = false;
  let lastDecode = 0;
  let facing: CameraFacing | null = opts.facing ?? "environment";

  const noop: CameraHandle = {
    stop() {},
    framesScanned: () => 0,
    facing: () => null,
    switchCamera: async () => false,
    attachPreview() {},
    lastDecodeMs: () => 0,
  };

  if (!canGetVideo()) {
    queueMicrotask(() => {
      if (!stopped && !errSent) {
        errSent = true;
        opts.onError?.("Camera isn\u2019t available in this browser.");
      }
    });
    return noop;
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
            if (payload) {
              lastDecode = Date.now();
              onDecode(payload);
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : 0;
  };

  const stopStream = () => {
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
    if (host) {
      host.remove();
      host = null;
    }
  };

  const attachStream = (s: MediaStream): boolean => {
    if (stopped) {
      s.getTracks().forEach((t) => t.stop());
      return false;
    }
    stream = s;
    video = document.createElement("video");
    video.srcObject = s;
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.autoplay = true;
    canvas = document.createElement("canvas");
    // Keep the video connected to the document from the moment it is created.
    // Some matchers start the camera before any preview box is rendered, and
    // the receiver's preview box is recreated between screens (React unmounts
    // the old one). A video that is detached from the DOM when play() is
    // called — or that gets detached by a re-render — pauses and goes black
    // on several browsers, so the element is parked in a hidden host until a
    // preview container claims it, and play() is re-issued on every attach.
    if (preview) {
      preview.replaceChildren(video);
    } else if (document.body) {
      if (!host) {
        host = document.createElement("div");
        host.style.position = "fixed";
        host.style.left = "-100000px";
        host.style.top = "0";
        host.style.width = "1px";
        host.style.height = "1px";
        host.style.overflow = "hidden";
        host.setAttribute("aria-hidden", "true");
        document.body.appendChild(host);
      }
      host.replaceChildren(video);
    }
    void video
      .play()
      .then(() => {
        raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : 0;
      })
      .catch(() => {
        /* play() interrupted by an early stop() — nothing to do */
      });
    return true;
  };

  const request = (f: CameraFacing) =>
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: f,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: f } }));

  request(facing ?? "environment")
    .then(attachStream)
    .catch(() => {
      if (!stopped && !errSent) {
        errSent = true;
        opts.onError?.("Couldn\u2019t start the camera (permission denied?).");
      }
    });

  return {
    stop() {
      stopped = true;
      stopStream();
    },
    framesScanned: () => scanned,
    facing: () => facing,
    async switchCamera() {
      if (stopped || facing === null) return false;
      const next: CameraFacing = facing === "environment" ? "user" : "environment";
      stopStream();
      facing = next;
      try {
        return await request(next).then(attachStream);
      } catch {
        facing = null;
        if (!stopped && !errSent) {
          errSent = true;
          opts.onError?.("Couldn\u2019t switch the camera.");
        }
        return false;
      }
    },
    attachPreview(el: HTMLElement) {
      preview = el;
      if (video && el) {
        el.replaceChildren(video);
        // The receiver's preview box is recreated between screens (React
        // unmounts the previous one), which detaches the video from the DOM
        // and pauses it on some browsers. Re-issue play() so the camera
        // doesn't stay frozen/black after re-attaching.
        if (video.paused) void video.play().catch(() => {});
      }
    },
    lastDecodeMs: () => lastDecode,
  };
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */

export interface LightTransportOptions {
  tx?: boolean;
  rx?: boolean;
  camera?: boolean;
  preview?: HTMLElement;
  facing?: CameraFacing;
  /** QR display pace in ms; the transfer frame rate. Defaults to LIGHT_FRAME_MS. */
  frameMs?: number;
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
  private symbolHandlers = new Set<(sym: { k: number; id: number; data: Uint8Array }) => void>();
  private closeHandlers = new Set<() => void>();
  private closed = false;
  private rescanned = 0;
  private resFrags = 0;
  private lastDecode = 0;
  private _frameMs: number;

  constructor(opts: LightTransportOptions = {}) {
    this.txOn = opts.tx !== false;
    this._frameMs = opts.frameMs ?? LIGHT_FRAME_MS;
    if (opts.camera) {
      this.cam = startCameraDecoder((payload) => this.onQrPayload(payload), {
        preview: opts.preview,
        facing: opts.facing,
      });
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

  /** Current camera facing, or null when no camera is attached. */
  cameraFacing(): CameraFacing | null {
    return this.cam ? this.cam.facing() : null;
  }

  /** Swap the attached camera between front and back. */
  async switchCamera(): Promise<boolean> {
    return this.cam ? this.cam.switchCamera() : false;
  }

  /** Attach the camera preview to a container element. */
  attachPreview(el: HTMLElement): void {
    this.cam?.attachPreview(el);
  }

  /** The QR fragment currently on display, or null while idle. */
  currentFrag(): Uint8Array | null {
    return this.frags.length > 0 ? this.frags[this.cursor] : null;
  }

  /** Display pace (ms per QR). Mutating it mid-transfer changes the cadence. */
  get frameMs(): number {
    return this._frameMs;
  }

  set frameMs(ms: number) {
    if (Number.isFinite(ms) && ms > 0) this._frameMs = ms;
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

  /** Display one fountain symbol as a single QR (no fragmentation). */
  sendSymbol(payload: Uint8Array): void {
    if (this.closed || !this.txOn) return;
    this.frags = [payload];
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
    // Fountain symbols are self-contained broadcast units — route them
    // straight to the symbol handlers, bypassing fragment reassembly.
    const sym = parseFountainSymbol(payload);
    if (sym) {
      for (const cb of [...this.symbolHandlers]) cb(sym);
      return;
    }
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

  /** Receive fountain symbols (already CRC-verified, transport-valid). */
  onSymbol(cb: (sym: { k: number; id: number; data: Uint8Array }) => void): () => void {
    this.symbolHandlers.add(cb);
    return () => this.symbolHandlers.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  /**
   * Display pacing: resolves after one full rotation of the current
   * fragment buffer, so the UI can show every fragment for `frameMs`
   * before the next message replaces it on screen.
   */
  idle(): Promise<void> {
    const rotations = Math.max(this.frags.length, 1) * this._frameMs;
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
    this.symbolHandlers.clear();
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
  /** Re-start announcing after a completed broadcast, so a receiver that
   *  missed the transfer can match and receive it again. */
  reannounce(): void;
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
    let m: { t?: string; sid?: string; pub?: string; fp?: string };
    try {
      m = JSON.parse(new TextDecoder().decode(frame)) as typeof m;
    } catch {
      return;
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
    reannounce() {
      if (stopped) return;
      matched = false;
      matchedPub = null;
      matchedFp = "";
      if (timer) clearInterval(timer);
      display.send(announceFrame);
      timer = setInterval(() => {
        if (!stopped && !matched) display.send(announceFrame);
      }, burstMs);
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
  /** Swap the matching camera between front and back. */
  switchCamera(): Promise<boolean>;
  cameraFacing(): CameraFacing | null;
  /** Milliseconds since the matching camera last decoded a QR. */
  lastDecodeMs(): number;
  /** Attach the live camera preview to a container element. */
  attachPreview(el: HTMLElement): void;
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
  const goHandlers = new Set<() => void>();
  const failureHandlers = new Set<(message: string) => void>();
  let pin: { sessionId: string; sessionKey: Uint8Array; channel: TransportEndpoint } | null = null;
  let goDone = false;
  let stopped = false;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  const unsub = channel.onMessage((frame) => {
    let m: { t?: string; sid?: string };
    try {
      m = JSON.parse(new TextDecoder().decode(frame)) as typeof m;
    } catch {
      return;
    }
    if ((m.t === "go" || m.t === "hello") && m.sid === session.sessionId && !goDone) {
      // "go" is explicit; "hello" is the sender's first transfer frame and
      // doubles as a fallback if the go burst was missed by the camera.
      goDone = true;
      for (const cb of [...goHandlers]) cb();
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
    switchCamera: () => channel.switchCamera(),
    cameraFacing: () => channel.cameraFacing(),
    lastDecodeMs: () => channel.lastDecodeMs,
    attachPreview: (el) => channel.attachPreview(el),
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
  /** Swap the scanning camera between front and back. */
  switchCamera(): Promise<boolean>;
  /** Current camera facing, or null when unavailable. */
  cameraFacing(): CameraFacing | null;
  /** Milliseconds since a QR was last decoded (0 = never). */
  lastDecodeMs(): number;
  /** Attach the live camera preview to a container element. */
  attachPreview(el: HTMLElement): void;
}

export function scanLightSessions(
  onSessions: (list: VisibleSession[]) => void,
  onError?: (message: string) => void,
  opts: { preview?: HTMLElement; facing?: CameraFacing } = {},
): LightScanHandle {
  const camera = new LightTransport({
    tx: false,
    rx: true,
    camera: true,
    preview: opts.preview,
    facing: opts.facing,
  });
  const map = new Map<string, VisibleSession>();
  let stopped = false;

  const unsub = camera.onMessage((frame) => {
    if (stopped) return;
    let d: Partial<SessionAnnouncement>;
    try {
      d = JSON.parse(new TextDecoder().decode(frame)) as Partial<SessionAnnouncement>;
    } catch {
      return;
    }
    if (typeof d.sessionId !== "string" || typeof d.wordPair !== "string" || typeof d.senderPub !== "string") return;
    try {
      fromBase64Url(d.senderPub);
    } catch {
      return;
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
    switchCamera: () => camera.switchCamera(),
    cameraFacing: () => camera.cameraFacing(),
    lastDecodeMs: () => camera.lastDecodeMs,
    attachPreview: (el) => camera.attachPreview(el),
  };
}