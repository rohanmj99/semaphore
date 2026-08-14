import { nextId, toBase64Url, fromBase64Url } from "./util.ts";
import type { ChannelKind } from "./types.ts";
import { frameMessage, FrameParser, type WireMessage } from "./frames.ts";

export interface TransportEndpoint {
  readonly kind: ChannelKind;
  readonly id: string;
  send(frame: Uint8Array): void;
  onMessage(cb: (frame: Uint8Array) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

export interface LoopbackPair {
  a: TransportEndpoint;
  b: TransportEndpoint;
}

/** In-app bridge: pipes real bytes between two peers with no network at all. */
export function loopbackPair(): LoopbackPair {
  const idA = nextId();
  const idB = nextId();
  let aClosed = false;
  let bClosed = false;
  const aCbs = new Set<(f: Uint8Array) => void>();
  const bCbs = new Set<(f: Uint8Array) => void>();
  const aClose = new Set<() => void>();
  const bClose = new Set<() => void>();

  const deliver = (cbs: Set<(f: Uint8Array) => void>, f: Uint8Array) => queueMicrotask(() => {
    for (const cb of [...cbs]) cb(f);
  });

  const a: TransportEndpoint = {
    kind: "loopback",
    id: idA,
    send(f) {
      if (bClosed) throw new Error("peer closed");
      deliver(bCbs, f);
    },
    onMessage(cb) {
      aCbs.add(cb);
      return () => aCbs.delete(cb);
    },
    onClose(cb) {
      aClose.add(cb);
      return () => aClose.delete(cb);
    },
    close() {
      aClosed = true;
      for (const cb of [...bClose]) cb();
    },
  };
  const b: TransportEndpoint = {
    kind: "loopback",
    id: idB,
    send(f) {
      if (aClosed) throw new Error("peer closed");
      deliver(aCbs, f);
    },
    onMessage(cb) {
      bCbs.add(cb);
      return () => bCbs.delete(cb);
    },
    onClose(cb) {
      bClose.add(cb);
      return () => bClose.delete(cb);
    },
    close() {
      bClosed = true;
      for (const cb of [...aClose]) cb();
    },
  };
  return { a, b };
}

export interface PausedTransport extends TransportEndpoint {
  /** If true, frames are queued instead of delivered (used to simulate channel trouble). */
  pause(): void;
  resume(): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** JSON transport message helpers bound to an endpoint. */
export class JsonChannel {
  private parser = new FrameParser();
  private unsub: (() => void) | null = null;

  constructor(
    readonly endpoint: TransportEndpoint,
    private readonly onMessage: (m: WireMessage) => void,
    private readonly onRaw?: (f: Uint8Array) => void,
  ) {}

  attach() {
    this.unsub = this.endpoint.onMessage((f) => {
      for (const frame of this.parser.push(f)) {
        try {
          const m = JSON.parse(dec.decode(frame)) as WireMessage;
          this.onMessage(m);
        } catch {
          this.onRaw?.(frame);
        }
      }
    });
    return this;
  }

  send(m: WireMessage) {
    this.endpoint.send(frameMessage(enc.encode(JSON.stringify(m))));
  }

  sendRaw(bytes: Uint8Array) {
    this.endpoint.send(frameMessage(bytes));
  }

  detach() {
    this.unsub?.();
    this.unsub = null;
  }
}

/** Wraps arbitrary bytes payload for transport (base64url when needed). */
export function payloadOf(m: WireMessage): Uint8Array | null {
  if (typeof m.p === "string") return fromBase64Url(m.p);
  return null;
}

export function b64(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}