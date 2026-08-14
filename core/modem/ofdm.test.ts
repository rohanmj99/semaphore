import { describe, expect, it } from "vitest";
import {
  CANONICAL_FS,
  Demodulator,
  Modulator,
  resolveParams,
  simulateChannel,
} from "./ofdm.ts";

function makePayload(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s >> 16) & 0xff;
  }
  return out;
}

function feedAll(demod: Demodulator, wave: Float64Array, chunk = 4096): ReturnType<Demodulator["push"]>[] {
  const results: ReturnType<Demodulator["push"]>[] = [];
  for (let i = 0; i < wave.length; i += chunk) {
    results.push(demod.push(wave.subarray(i, i + chunk)));
  }
  return results;
}

describe("acoustic modem in-band (sender synth → receiver decode)", () => {
  it("modulates a frame and demodulates it back", () => {
    const mod = new Modulator();
    const payload = makePayload(45);
    const wave = mod.modulate(payload);
    // frame includes trailing silence; demodulator may return in last chunk
    const demod = new Demodulator();
    const results = feedAll(demod, wave);
    const frames = results.flat();
    expect(frames.length).toBe(1);
    expect(frames[0].payload).toEqual(payload);
  });

  it("survives a noisy channel at 24 dB SNR", () => {
    const mod = new Modulator();
    const payload = makePayload(45);
    const wave = simulateChannel(mod.modulate(payload), 24, 1);
    const demod = new Demodulator();
    expect(demod.push(wave).map((f) => f.payload)).toEqual([payload]);
  });

  it("survives at 18 dB SNR (quiet-ish conversation)", () => {
    const mod = new Modulator();
    const payload = makePayload(45);
    const wave = simulateChannel(mod.modulate(payload), 18, 1);
    const demod = new Demodulator();
    expect(demod.push(wave).map((f) => f.payload)).toEqual([payload]);
  });

  it("delivers many frames in sequence", () => {
    const mod = new Modulator();
    const demod = new Demodulator();
    const payloads: Uint8Array[] = [];
    let wave = new Float64Array(0);
    for (let i = 0; i < 5; i++) {
      const p = makePayload(45, i + 1);
      payloads.push(p);
      wave = new Float64Array([...wave, ...mod.modulate(p)]);
    }
    const frames = feedAll(demod, wave).flat();
    expect(frames.map((f) => f.payload)).toEqual(payloads);
  });

  it("drops corrupted frames instead of emitting garbage", () => {
    const mod = new Modulator();
    const payload = makePayload(45);
    const wave = mod.modulate(payload);
    const demod = new Demodulator();
    demod.push(wave);
    expect(demod.push(simulateChannel(new Float64Array(30000), -10)).length).toBe(0);
  });

  it("quiet mode round-trips at low amplitude", () => {
    const mod = new Modulator({ quiet: true });
    const payload = makePayload(16);
    const wave = simulateChannel(mod.modulate(payload), 22, 1);
    const demod = new Demodulator(true);
    expect(demod.push(wave).map((f) => f.payload)).toEqual([payload]);
  });

  it("reports a noise floor and SNR", () => {
    const mod = new Modulator();
    const demod = new Demodulator();
    demod.push(simulateChannel(mod.modulate(makePayload(45)), 20));
    expect(demod.noiseFloor).toBeGreaterThan(0);
    expect(demod.lastSnr).toBeGreaterThan(8);
  });

  it("modulator rejects wrong-sized payloads", () => {
    const mod = new Modulator();
    expect(() => mod.modulate(new Uint8Array(10))).toThrow(/payload/);
  });

  it("params: 16 normal carriers in 1.5–5.25 kHz", () => {
    const p = resolveParams();
    expect(p.carriers.length).toBe(16);
    expect(p.carriers[0]).toBe(1500);
    expect(p.carriers[15]).toBe(5250);
    expect(p.symbolLen).toBe(CANONICAL_FS / 100);
  });

  it("payload throughput sanity: ~86 B/s useful classic rate", () => {
    const mod = new Modulator();
    const wave = mod.modulate(makePayload(45));
    const seconds = wave.length / CANONICAL_FS;
    expect(45 / seconds).toBeGreaterThan(50);
    expect(45 / seconds).toBeLessThan(150);
  });
});