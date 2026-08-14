import type { TransportEndpoint } from "../transports.ts";
import { FrameParser, frameMessage } from "../frames.ts";
import { createSessionId, deriveKxSessionKey, fingerprint, keypair, wordPair } from "../crypto.ts";
import { fromBase64Url, nextId, toBase64Url } from "../util.ts";
import { CANONICAL_FS, Demodulator, Modulator, type ModemFrame } from "./ofdm.ts";
import { resampleLinear } from "./dsp.ts";
import type { SessionAnnouncement, VisibleSession } from "../pairing.ts";

/**
 * Sound channel — acoustic OFDM modem transport.
 *
 * Wire messages are fragmented into small frames that fit one modem payload,
 * played through the speaker, captured on the other device's mic and
 * reassembled. Messages play strictly in order; a lost fragment forces a
 * reset of the partial message (the session layer re-cycles everything in
 * broadcast mode, so nothing is permanently lost).
 */

export const SOUND_FRAG_MAGIC = 0x7e;

/** Data bytes per modem frame. Normal frames are 45 bytes, quiet 16. */
export function fragmentCapacity(quiet: boolean): number {
  return quiet ? 11 : 40;
}

export function fragmentLength(quiet: boolean): number {
  return quiet ? 16 : 45;
}

/**
 * Split one wire message into modem payloads:
 * [magic][totalHi][totalLo][seq][len][data...]
 */
export function fragmentWire(frame: Uint8Array, quiet = false): Uint8Array[] {
  const cap = fragmentCapacity(quiet);
  const len = fragmentLength(quiet);
  const out: Uint8Array[] = [];
  for (let off = 0, seq = 0; off < frame.length || out.length === 0; off += cap, seq++) {
    const data = frame.subarray(off, off + cap);
    const frag = new Uint8Array(len);
    frag[0] = SOUND_FRAG_MAGIC;
    frag[1] = (frame.length >> 8) & 0xff;
    frag[2] = frame.length & 0xff;
    frag[3] = seq & 0xff;
    frag[4] = data.length;
    frag.set(data, 5);
    out.push(frag);
  }
  return out;
}

/**
 * In-order fragment reassembly. Delivers a complete wire message (the
 * concatenation of all its fragments) or null when the stream is corrupt /
 * out of sequence (partial message dropped).
 */
export class FragmentReassembler {
  private expectedLen = 0;
  private nextSeq = 0;
  private got = 0;
  private parts: Uint8Array[] = [];

  constructor(private readonly quiet = false) {}

  reset(): void {
    this.expectedLen = 0;
    this.nextSeq = 0;
    this.got = 0;
    this.parts = [];
  }

  push(frag: Uint8Array): Uint8Array | null {
    if (frag.length !== fragmentLength(this.quiet) || frag[0] !== SOUND_FRAG_MAGIC) {
      this.reset();
      return null;
    }
    const totalLen = (frag[1] << 8) | frag[2];
    const seq = frag[3];
    const len = frag[4];
    if (totalLen === 0 || totalLen > 64 * 1024 * 1024 || len > fragmentCapacity(this.quiet)) {
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
      // Stray mid-message fragment after a loss — drop it and the partial message.
      this.reset();
      return null;
    }
    this.nextSeq = (seq + 1) & 0xff;
    this.parts.push(frag.slice(5, 5 + len));
    this.got += len;
    if (this.got === this.expectedLen) {
      const out = concatBytes(this.parts);
      this.reset();
      return out;
    }
    return null;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function audioCtor(): typeof AudioContext | null {
  if (typeof AudioContext !== "undefined") return AudioContext;
  const w = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  if (typeof w.webkitAudioContext === "function") {
    return w.webkitAudioContext;
  }
  return null;
}

export function soundSupported(): boolean {
  return audioCtor() !== null;
}

function canGetUserMedia(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
}

export function soundRxSupported(): boolean {
  return soundSupported() && canGetUserMedia();
}

/* ------------------------------------------------------------------ */
/* Mic → demodulator → reassembler pipeline                             */

export interface MicDecoderHandle {
  stop(): void;
  noiseFloor(): number;
  snr(): number;
  framesDecoded(): number;
}

function analyseBuffer(ctx: AudioContext, analyser: AnalyserNode, dest: Float32Array<ArrayBuffer>, outRate: number): Float64Array | null {
  analyser.getFloatTimeDomainData(dest);
  const inRate = ctx.sampleRate;
  if (inRate === outRate) {
    const out = new Float64Array(dest.length);
    for (let i = 0; i < dest.length; i++) out[i] = dest[i];
    return out;
  }
  const out = resampleLinear(Float64Array.from(dest), inRate, outRate);
  return out.length > 0 ? out : null;
}

/**
 * Listen to the mic (or an arbitrary sample source) and feed a Demodulator.
 * Used by the sound scanner and by receiver-side data transport.
 */
export function startMicDecoder(
  onFrame: (frame: ModemFrame) => void,
  opts: { quiet?: boolean; sourceFn?: () => Float64Array; onError?: (message: string) => void } = {},
): MicDecoderHandle {
  const quiet = !!opts.quiet;
  const demod = new Demodulator(quiet);
  const dest = new Float32Array(2048);
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let stream: MediaStream | null = null;
  let raf = 0;
  let stopped = false;

  const step = () => {
    if (stopped) return;
    if (!analyser) return;
    const samples = analyseBuffer(ctx as AudioContext, analyser, dest, CANONICAL_FS);
    if (samples) {
      const frames = demod.push(samples);
      for (const f of frames) onFrame(f);
    }
    raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(step) : 0;
  };

  const Ctor = audioCtor();
  const micOK = canGetUserMedia();
  if (!Ctor || !micOK) {
    queueMicrotask(() => {
      if (!stopped) opts.onError?.("Microphone isn\u2019t supported in this browser.");
    });
  } else {
    Promise.resolve()
      .then(
        () =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              sampleRate: 44100,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          }),
      )
      .catch(() =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false },
        }),
      )
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        try {
          ctx = new Ctor({ sampleRate: 44100 });
        } catch {
          try {
            ctx = new Ctor();
          } catch {
            ctx = null;
          }
        }
        if (!ctx) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const src = ctx.createMediaStreamSource(s);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 4096;
        src.connect(analyser);
        if (typeof (ctx as AudioContext & { resume?: () => Promise<void> }).resume === "function") {
          void (ctx as AudioContext & { resume: () => Promise<void> }).resume();
        }
        raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(step) : 0;
      })
      .catch(() => {
        if (!stopped) opts.onError?.("Microphone access was blocked. Allow mic permission to hear tones.");
      });
  }

  return {
    stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      void ctx?.close();
      ctx = null;
      analyser = null;
    },
    noiseFloor: () => demod.noiseFloor,
    snr: () => demod.lastSnr,
    framesDecoded: () => demod.framesDecoded,
  };
}

/* ------------------------------------------------------------------ */
/* Speaker playback engine                                              */

interface FragJob {
  wave: Float64Array;
  duration: number;
}

/**
 * Paced playback of 45-byte modem frames through the speaker. Frames are
 * queued by send() and played back-to-back with a small gap; idle() resolves
 * once the queue has fully drained.
 */
export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private queue: FragJob[] = [];
  private nextTime = 0;
  private playing = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor() {}

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = audioCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor({ sampleRate: CANONICAL_FS });
    } catch {
      try {
        this.ctx = new Ctor();
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx) {
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -24;
      this.compressor.ratio.value = 12;
      this.compressor.connect(this.ctx.destination);
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.9;
      this.gain.connect(this.compressor);
    }
    return this.ctx;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  enqueue(modulated: Float64Array): void {
    if (this.closed) return;
    const ctx = this.ensureCtx();
    this.queue.push({ wave: modulated, duration: modulated.length / CANONICAL_FS });
    if (ctx) void this.pump(ctx);
  }

  /** True while the player still has scheduled/unplayed audio or queued frames. */
  get active(): boolean {
    return this.playing || this.queue.length > 0;
  }

  /** Resolves once everything queued so far has been played (or failed). */
  idle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(ctx: AudioContext): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const job = this.queue.shift() as FragJob;
        let wave = job.wave;
        if (ctx.sampleRate !== CANONICAL_FS) {
          wave = resampleLinear(wave, CANONICAL_FS, ctx.sampleRate);
        }
        const j = wave as Float64Array;
        const buffer = ctx.createBuffer(1, j.length, ctx.sampleRate);
        buffer.copyToChannel(Float32Array.from(j), 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const start = Math.max(ctx.currentTime + 0.02, this.nextTime);
        const end = start + job.duration;
        this.nextTime = end + 0.02;
        if (this.gain) {
          src.connect(this.gain);
        } else {
          src.connect(ctx.destination);
        }
        src.start(start);
        await new Promise<void>((resolve) => {
          src.onended = () => resolve();
        });
        if (this.closed) return;
      }
      this.nextTime = 0;
    } finally {
      this.playing = false;
      this.settleIdle();
    }
  }

  private settleIdle(): void {
    if (this.active) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.settleIdle();
    void this.ctx?.close();
    this.ctx = null;
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */

export interface SoundTransportOptions {
  quiet?: boolean;
  tx?: boolean;
  rx?: boolean;
  onMicError?: (message: string) => void;
}

export class SoundTransport implements TransportEndpoint {
  readonly kind = "sound" as const;
  readonly id = nextId();
  private readonly quiet: boolean;
  private readonly txOn: boolean;
  private readonly onMicError?: (message: string) => void;
  private readonly player: SoundPlayer;
  private readonly reassembler: FragmentReassembler;
  private readonly parser = new FrameParser();
  private mic: MicDecoderHandle | null = null;
  private msgHandlers = new Set<(frame: Uint8Array) => void>();
  private closeHandlers = new Set<() => void>();
  private closed = false;
  private framesRcvd = 0;

  constructor(opts: SoundTransportOptions = {}) {
    this.quiet = !!opts.quiet;
    this.txOn = opts.tx !== false;
    this.onMicError = opts.onMicError;
    this.player = new SoundPlayer();
    this.reassembler = new FragmentReassembler(this.quiet);
    if (opts.rx) this.startRx();
  }

  get noiseFloor(): number {
    return this.mic ? this.mic.noiseFloor() : 0;
  }

  get snr(): number {
    return this.mic ? this.mic.snr() : 0;
  }

  get framesDecoded(): number {
    return this.framesRcvd;
  }

  private startRx(): void {
    this.mic = startMicDecoder(
      (frame) => this.onModemFrame(frame),
      { quiet: this.quiet, onError: this.onMicError },
    );
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    if (!this.txOn) return;
    const mod = new Modulator({ quiet: this.quiet });
    for (const frag of fragmentWire(frame, this.quiet)) {
      this.player.enqueue(mod.modulate(frag));
    }
  }

  /** Queue of unplayed frames (for broadcast pacing / diagnostics). */
  get backlog(): number {
    return this.player.queueLength;
  }

  /** Resolves when everything sent so far has been played. */
  idle(): Promise<void> {
    return this.player.idle();
  }

  private onModemFrame(frame: ModemFrame): void {
    this.framesRcvd++;
    const wire = this.reassembler.push(frame.payload);
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mic?.stop();
    this.mic = null;
    this.player.close();
    for (const cb of [...this.closeHandlers]) cb();
    this.msgHandlers.clear();
    this.closeHandlers.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Pairing over sound                                                   */

export interface SoundSenderQueue {
  sessionId: string;
  wordPair: string;
  senderFingerprint: string;
  onMatch(cb: (peer: { receiverFingerprint: string; receiverPub: string }) => void): void;
  notifyGo(): void;
  start(
    cb: (keys: { sessionKey: Uint8Array; channel: TransportEndpoint; receiverFingerprint: string }) => void,
  ): void;
  onFailure?(cb: (message: string) => void): void;
  stop(): void;
}

const DEFAULT_BURST_MS = 2500;

export interface SoundAnnounceOptions {
  quiet?: boolean;
  announceEveryMs?: number;
  listenMs?: number;
  burstMs?: number;
}

export function advertiseSound(
  file: { name: string; size: number } | null,
  opts: SoundAnnounceOptions = {},
): SoundSenderQueue {
  const quiet = !!opts.quiet;
  const burstMs = opts.burstMs ?? DEFAULT_BURST_MS;
  const kp = keypair();
  const sessionId = createSessionId();
  const pair = wordPair(kp.publicKey);
  const fp = fingerprint(kp.publicKey);
  const tx = new SoundTransport({ quiet, tx: true, rx: false });
  const rx = new SoundTransport({ quiet, tx: false, rx: true });
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
  let txActive = false;

  if (!soundSupport()) {
    // UI should gate this earlier; belt & braces.
    queueMicrotask(() => {
      for (const cb of [...failureHandlers]) cb("Sound isn\u2019t available in this browser.");
    });
  }

  const unsub = rx.onMessage((frame) => {
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

  const announceStep = () => {
    if (stopped) return;
    if (matched || txActive) return;
    txActive = true;
    tx.send(announceFrame);
    void tx.idle().then(() => {
      txActive = false;
    });
  };

  if (soundSupport()) {
    timer = setInterval(announceStep, burstMs);
    announceStep();
  }

  return {
    sessionId,
    wordPair: pair,
    senderFingerprint: fp,
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
        tx.send(goFrame);
        void tx.idle().then(() => {
          if (!stopped) setTimeout(burst, 800);
        });
      };
      burst();
      const sessionKey = deriveKxSessionKey(sessionId, matchedPub as Uint8Array, kp.secretKey).key;
      const receiverFingerprint = matchedFp;
      for (const cb of [...startHandlers]) {
        cb({ sessionKey, channel: tx, receiverFingerprint });
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
      tx.close();
      rx.close();
      matchHandlers.clear();
      startHandlers.clear();
      failureHandlers.clear();
    },
  };
}

export function soundSupport(): boolean {
  return soundSupported();
}

export interface SoundMatcher {
  readonly pin: { sessionId: string; sessionKey: Uint8Array; channel: TransportEndpoint } | null;
  confirm(): void;
  onGo(cb: () => void): void;
  postReady(): void;
  onFailure?(cb: (message: string) => void): void;
  cancel(): void;
}

export function matchSoundSession(
  session: VisibleSession,
  opts: SoundAnnounceOptions = {},
): SoundMatcher {
  const quiet = !!opts.quiet;
  const kp = keypair();
  const receiverFp = fingerprint(kp.publicKey);
  const channel = new SoundTransport({ quiet, tx: true, rx: true });
  const parser = new FrameParser();
  const goHandlers = new Set<() => void>();
  const failureHandlers = new Set<(message: string) => void>();
  let pin: { sessionId: string; sessionKey: Uint8Array; channel: TransportEndpoint } | null = null;
  let goDone = false;
  let stopped = false;

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
        // doubles as a fallback if the go burst was missed by the mic.
        goDone = true;
        for (const cb of [...goHandlers]) cb();
      }
    }
  });

  return {
    get pin() {
      return pin;
    },
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
        void channel.idle().then(() => {
          if (stopped || goDone) return;
          // Leave a listening gap so the sender's go can get through.
          setTimeout(burst, 2000);
        });
      };
      burst();
    },
    onGo(cb) {
      goHandlers.add(cb);
    },
    postReady() {
      /* sound has no return path after go — the sender re-sends everything */
    },
    onFailure(cb) {
      failureHandlers.add(cb);
    },
    cancel() {
      stopped = true;
      unsub();
      channel.close();
      goHandlers.clear();
      failureHandlers.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Nearby scanning over sound                                          */

export interface SoundScanHandle {
  stop(): void;
  noiseFloor(): number;
  snr(): number;
  framesDecoded(): number;
}

export function scanSoundSessions(
  onSessions: (list: VisibleSession[]) => void,
  onError?: (message: string) => void,
  opts: SoundAnnounceOptions = {},
): SoundScanHandle {
  const quiet = !!opts.quiet;
  const rx = new SoundTransport({ quiet, tx: false, rx: true, onMicError: onError });
  const parser = new FrameParser();
  const map = new Map<string, VisibleSession>();
  let stopped = false;

  const unsub = rx.onMessage((frame) => {
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

  if (!soundRxSupport()) {
    onError?.("Sound listening isn\u2019t available in this browser.");
  }

  return {
    stop() {
      stopped = true;
      unsub();
      rx.close();
    },
    noiseFloor: () => rx.noiseFloor,
    snr: () => rx.snr,
    framesDecoded: () => rx.framesDecoded,
  };
}

export function soundRxSupport(): boolean {
  return soundRxSupported();
}