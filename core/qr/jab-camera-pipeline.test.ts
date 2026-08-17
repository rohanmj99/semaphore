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
});