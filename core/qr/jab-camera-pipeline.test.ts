import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { decodeJab, encodeJab, paintJab } from "./jab.ts";

function dataOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

interface CameraJob {
  label: string;
  cardW: number;
  cardH: number;
  rgbaB64: string;
  sceneW: number;
  sceneH: number;
  cardFrac: number;
  blur: number;
  noise: number;
  lift: number;
  cast: [number, number, number];
  /** Skip the camera-pipeline downscale: return the scene itself (the
   *  "sensor-resolution" mode, where the decoder sees native pixels). */
  direct?: boolean;
}

/** Renders a card the way a real camera sees it: the card sits in a larger
 *  scene at some distance (cardFrac of the frame), optionally blurred,
 *  noisy, brightened and color-cast, then the scene goes through the
 *  receiver's two-stage bilinear pipeline (scene → 480×480 camera canvas →
 *  640×480 decode box). Returns RGBA b64 ready for decodeJab. */
async function renderScene(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  jobs: CameraJob[],
): Promise<Array<{ label: string; b64: string }>> {
  const page = await browser.newPage();
  const results = await page.evaluate(async (jobs) => {
    const out: Array<{ label: string; b64: string }> = [];
    for (const j of jobs) {
      try {
        const bin = Uint8Array.from(atob(j.rgbaB64), (c) => c.charCodeAt(0));
        const card = document.createElement("canvas");
        card.width = j.cardW; card.height = j.cardH;
        card.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(bin), j.cardW, j.cardH), 0, 0);
        const scene = document.createElement("canvas");
        scene.width = j.sceneW; scene.height = j.sceneH;
        const sctx = scene.getContext("2d")!;
        sctx.fillStyle = "#fff"; sctx.fillRect(0, 0, j.sceneW, j.sceneH);
        const cs = Math.floor(j.sceneH * j.cardFrac);
        sctx.drawImage(card, (j.sceneW - cs) / 2, (j.sceneH - cs) / 2, cs, cs);
        if (j.blur > 0) {
          const tmp = document.createElement("canvas");
          tmp.width = j.sceneW; tmp.height = j.sceneH;
          const tctx = tmp.getContext("2d")!;
          tctx.filter = `blur(${j.blur}px)`;
          tctx.drawImage(scene, 0, 0);
          sctx.clearRect(0, 0, j.sceneW, j.sceneH);
          sctx.drawImage(tmp, 0, 0);
        }
        if (j.direct) {
          const data = new Uint8Array(sctx.getImageData(0, 0, j.sceneW, j.sceneH).data);
          if (j.noise > 0 || j.lift > 0 || j.cast[0] || j.cast[1] || j.cast[2]) {
            let s = 777;
            for (let i = 0; i < data.length; i += 4) {
              if (j.noise > 0) {
                s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
                const n = (s % (j.noise * 2 + 1)) - j.noise;
                data[i] = Math.max(0, Math.min(255, data[i] + n));
                data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
                data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
              }
              data[i] = Math.max(0, Math.min(255, data[i] + j.lift + j.cast[0]));
              data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + j.lift + j.cast[1]));
              data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + j.lift + j.cast[2]));
            }
          }
          let s2 = "";
          for (let k = 0; k < data.length; k += 20000) s2 += String.fromCharCode(...data.subarray(k, k + 20000));
          out.push({ label: j.label, b64: btoa(s2) });
          continue;
        }
        const cam = document.createElement("canvas");
        cam.width = 480; cam.height = 480;
        const cctx = cam.getContext("2d")!;
        cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, 480, 480);
        cctx.drawImage(scene, 0, 0, 480, 480);
        const dec = document.createElement("canvas");
        dec.width = 640; dec.height = 480;
        const dctx = dec.getContext("2d")!;
        dctx.fillStyle = "#fff"; dctx.fillRect(0, 0, 640, 480);
        dctx.drawImage(cam, 0, 0, 640, 480);
        const data = new Uint8Array(dctx.getImageData(0, 0, 640, 480).data);
        if (j.noise > 0 || j.lift > 0 || j.cast[0] || j.cast[1] || j.cast[2]) {
          let s = 777;
          for (let i = 0; i < data.length; i += 4) {
            if (j.noise > 0) {
              s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
              const n = (s % (j.noise * 2 + 1)) - j.noise;
              data[i] = Math.max(0, Math.min(255, data[i] + n));
              data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
              data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
            }
            data[i] = Math.max(0, Math.min(255, data[i] + j.lift + j.cast[0]));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + j.lift + j.cast[1]));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + j.lift + j.cast[2]));
          }
        }
        let s2 = "";
        for (let k = 0; k < data.length; k += 20000) s2 += String.fromCharCode(...data.subarray(k, k + 20000));
        out.push({ label: j.label, b64: btoa(s2) });
      } catch {
        out.push({ label: j.label, b64: "" });
      }
    }
    return out;
  }, jobs);
  await page.close();
  return results;
}

describe("jab camera pipeline", () => {
  it("decodes a fountain-size symbol through the two-stage bilinear camera pipeline", async () => {
    // The receiver's real pipeline: the sender's card is painted into the
    // camera canvas (480x480, bilinear), then the capture frame is stretched
    // into the decode box (640x480, bilinear). The fractional module size
    // (430px card / 78 modules ≈ 7.44 x 5.58 px) makes the measured arm runs
    // round to whole pixels and biased short, which used to select the wrong
    // grid side (66 instead of 64) and fail every decode.
    const payload = dataOf(1052, 42);
    const m = encodeJab(payload);
    const img = paintJab(m, 5, 4);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const b64 = await page.evaluate(async ({ rgbaB64, w, h }) => {
      const bin = Uint8Array.from(atob(rgbaB64), (c) => c.charCodeAt(0));
      const card = document.createElement("canvas");
      card.width = w; card.height = h;
      card.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(bin), w, h), 0, 0);
      const cam = document.createElement("canvas");
      cam.width = 480; cam.height = 480;
      const cctx = cam.getContext("2d")!;
      cctx.fillStyle = "#fff"; cctx.fillRect(0, 0, 480, 480);
      cctx.drawImage(card, 0, 0, 480, 480);
      const dec = document.createElement("canvas");
      dec.width = 640; dec.height = 480;
      const dctx = dec.getContext("2d")!;
      dctx.fillStyle = "#fff"; dctx.fillRect(0, 0, 640, 480);
      dctx.drawImage(cam, 0, 0, 640, 480);
      const data = dctx.getImageData(0, 0, 640, 480).data;
      const out = new Uint8Array(data);
      let s = "";
      for (let k = 0; k < out.length; k += 20000) s += String.fromCharCode(...out.subarray(k, k + 20000));
      return btoa(s);
    }, { rgbaB64: Buffer.from(img.rgba).toString("base64"), w: img.width, h: img.height });
    await browser.close();
    const got = decodeJab(new Uint8ClampedArray(Buffer.from(b64, "base64")), 640, 480);
    expect(got).toEqual(payload);
  });

  it("survives real-camera conditions: distance, blur, noise, brightness and WB cast", async () => {
    const payload = dataOf(1052, 42);
    const m = encodeJab(payload);
    const img = paintJab(m, 5, 4);
    const base: CameraJob = {
      label: "",
      cardW: img.width,
      cardH: img.height,
      rgbaB64: Buffer.from(img.rgba).toString("base64"),
      sceneW: 800,
      sceneH: 800,
      cardFrac: 0.8,
      blur: 0,
      noise: 0,
      lift: 0,
      cast: [0, 0, 0],
    };
    const cases: Array<CameraJob> = [
      { ...base, label: "held-closer", cardFrac: 0.8 },
      { ...base, label: "held-normal", cardFrac: 0.6 },
      { ...base, label: "held-far", cardFrac: 0.5 },
      { ...base, label: "held-farther", cardFrac: 0.4 },
      { ...base, label: "motion-blur", blur: 0.5 },
      { ...base, label: "sensor-noise", noise: 12 },
      { ...base, label: "bright-room", lift: 25 },
      { ...base, label: "wb-blue-cast", cast: [0, 0, 14] },
      { ...base, label: "wb-warm-cast", cast: [10, 4, 0] },
      { ...base, label: "combined", cardFrac: 0.5, blur: 0.4, noise: 10, lift: 12, cast: [4, 2, 0] },
    ];
    const browser = await chromium.launch({ headless: true });
    const rendered = await renderScene(browser, cases);
    await browser.close();
    for (const r of rendered) {
      const got = r.b64 ? decodeJab(new Uint8ClampedArray(Buffer.from(r.b64, "base64")), 640, 480) : null;
      expect(got, r.label).toEqual(payload);
    }
  });

  it("decodes far-hold scenes at sensor resolution (no 640x480 downscale)", async () => {
    // The camera decoder now decodes at the video's native resolution: a
    // 1920x1080 sensor keeps the code ~3x bigger on the decode grid than the
    // old fixed 640x480 box, which makes far holds readable. Render the scene
    // directly at 1280x720 (the decoder's cap) and decode at that size.
    const payload = dataOf(1052, 42);
    const m = encodeJab(payload);
    const img = paintJab(m, 5, 4);
    const base: CameraJob = {
      label: "",
      cardW: img.width,
      cardH: img.height,
      rgbaB64: Buffer.from(img.rgba).toString("base64"),
      sceneW: 1280,
      sceneH: 720,
      cardFrac: 0.5,
      blur: 0,
      noise: 0,
      lift: 0,
      cast: [0, 0, 0],
    };
    const cases: Array<CameraJob> = [
      { ...base, label: "sensor-far", cardFrac: 0.4, direct: true },
      { ...base, label: "sensor-farther", cardFrac: 0.3, direct: true },
      { ...base, label: "sensor-degraded", cardFrac: 0.35, blur: 0.6, noise: 10, lift: 12, cast: [4, 2, 0], direct: true },
    ];
    const browser = await chromium.launch({ headless: true });
    const rendered = await renderScene(browser, cases);
    await browser.close();
    for (const r of rendered) {
      const got = r.b64 ? decodeJab(new Uint8ClampedArray(Buffer.from(r.b64, "base64")), 1280, 720) : null;
      expect(got, r.label).toEqual(payload);
    }
  });
});