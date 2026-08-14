import { concatB, readU32be, u32be } from "./util.ts";

/** Length-prefixed message framing used over stream transports (loopback / WebRTC). */
export function frameMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  u32be(payload.length, out, 0);
  out.set(payload, 4);
  return out;
}

export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0);

  /** Feed raw transport bytes; returns complete frames in order. */
  push(data: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    this.buf = concatB([this.buf, data]);
    while (this.buf.length >= 4) {
      const len = readU32be(this.buf, 0);
      if (len > 64 * 1024 * 1024) {
        this.buf = new Uint8Array(0);
        throw new Error("frame too large");
      }
      if (this.buf.length < 4 + len) break;
      out.push(this.buf.slice(4, 4 + len));
      this.buf = this.buf.slice(4 + len);
    }
    return out;
  }

  get pending(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

export interface WireMessage {
  t: string;
  [k: string]: unknown;
}

export function encodeMessage(msg: WireMessage): Uint8Array {
  return frameMessage(new TextEncoder().encode(JSON.stringify(msg)));
}

export function parseMessage(frame: Uint8Array): WireMessage {
  return JSON.parse(new TextDecoder().decode(frame)) as WireMessage;
}