import { describe, expect, it } from "vitest";
import { FragmentReassembler, fragmentWire } from "./sound.ts";
import { Demodulator, Modulator, simulateChannel } from "./ofdm.ts";
import { frameMessage } from "../frames.ts";

/** Play a wire message through the modem + a simulated acoustic channel. */
function transmit(
  frame: Uint8Array,
  opts: { drop?: (index: number) => boolean; snr?: number; quiet?: boolean } = {},
): Uint8Array[] {
  const mod = new Modulator({ quiet: opts.quiet });
  const demod = new Demodulator(!!opts.quiet);
  const re = new FragmentReassembler(!!opts.quiet);
  const delivered: Uint8Array[] = [];
  const frags = fragmentWire(frame, !!opts.quiet);
  let wave = new Float64Array(0);
  frags.forEach((f, i) => {
    if (opts.drop?.(i)) return;
    const m = mod.modulate(f);
    const n = new Float64Array(wave.length + m.length);
    n.set(wave);
    n.set(m, wave.length);
    wave = n;
  });
  const noisy = simulateChannel(wave, opts.snr ?? 22);
  for (let i = 0; i < noisy.length; i += 8192) {
    for (const f of demod.push(noisy.subarray(i, i + 8192))) {
      const wire = re.push(f.payload);
      if (wire) delivered.push(wire);
    }
  }
  return delivered;
}

describe("sound fragment codec", () => {
  it("fragments a message into modem payloads and back", () => {
    const frame = new TextEncoder().encode(JSON.stringify({ t: "hello", sid: "a".repeat(16), pad: "x".repeat(120) }));
    const frags = fragmentWire(frame);
    expect(frags.length).toBeGreaterThan(1);
    for (const f of frags) expect(f.length).toBe(45);
    const re = new FragmentReassembler();
    const out: Uint8Array[] = [];
    for (const f of frags) {
      const w = re.push(f);
      if (w) out.push(w);
    }
    expect(out).toEqual([frame]);
  });

  it("single-fragment message round-trips", () => {
    const frame = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "go" })));
    expect(transmit(frame)).toEqual([frame]);
  });

  it("multi-fragment message round-trips through a noisy channel", () => {
    const frame = frameMessage(
      new TextEncoder().encode(JSON.stringify({ t: "announce", payload: "x".repeat(300) })),
    );
    expect(transmit(frame, { snr: 18 })).toEqual([frame]);
  });

  it("drops the whole message when any fragment is lost", () => {
    const frame = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "chunk", p: "y".repeat(200) })));
    const delivered = transmit(frame, { drop: (i) => i === 1 });
    expect(delivered.length).toBe(0);
  });

  it("recovers for the next message after a dropped one", () => {
    const f1 = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "chunk", p: "y".repeat(200) })));
    const f2 = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "have" })));
    const all = transmit(f1, { drop: (i) => i === 1 });
    expect(all.length).toBe(0);
    // a fresh transmit() is a new channel instance — recovery must hold within one stream
    const mod = new Modulator();
    const demod = new Demodulator();
    const re = new FragmentReassembler();
    const got: Uint8Array[] = [];
    const feed = (frags: Uint8Array[], snr = 22) => {
      let wave = new Float64Array(0);
      for (const f of frags) {
        const m = mod.modulate(f);
        const n = new Float64Array(wave.length + m.length);
        n.set(wave);
        n.set(m, wave.length);
        wave = n;
      }
      for (let i = 0; i < wave.length; i += 8192) {
        for (const fr of demod.push(simulateChannel(wave.subarray(i, i + 8192), snr))) {
          const w = re.push(fr.payload);
          if (w) got.push(w);
        }
      }
    };
    feed(fragmentWire(f1).filter((_, i) => i !== 1));
    feed(fragmentWire(f2));
    expect(got).toEqual([f2]);
  });

  it("quiet mode codec uses 16-byte frames", () => {
    const frame = frameMessage(new TextEncoder().encode(JSON.stringify({ t: "go", sid: "b".repeat(16) })));
    const frags = fragmentWire(frame, true);
    expect(frags[0].length).toBe(16);
    expect(frags[0][4]).toBeLessThanOrEqual(11);
    const re = new FragmentReassembler(true);
    const delivered: Uint8Array[] = [];
    for (const f of frags) {
      const w = re.push(f);
      if (w) delivered.push(w);
    }
    expect(delivered).toEqual([frame]);
  });

  it("rejects malformed fragments", () => {
    const re = new FragmentReassembler();
    expect(re.push(new Uint8Array(45))).toBeNull();
    const bad = fragmentWire(frameMessage(new TextEncoder().encode("x")))[0];
    bad[4] = 50; // len beyond capacity
    expect(re.push(bad)).toBeNull();
    expect(re.push(new Uint8Array(3))).toBeNull();
  });
});
