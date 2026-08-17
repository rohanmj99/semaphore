/**
 * JAB-style 8-color matrix codec for the light channel.
 *
 * Inspired by JAB Code (the colored alternative to QR): data is spread
 * across 8 module colors (3 bits each) so a frame holds roughly 3× the
 * payload of a black/white code of the same size. Both ends of Semaphore
 * run this codec, so it is a self-contained JAB-style design rather than
 * an ISO-JAB-conformant implementation:
 *
 *   - Palette: the 8 RGB cube corners (black, red, green, blue, yellow,
 *     magenta, cyan, white).
 *   - A 1-module black border ring around the whole grid.
 *   - Top-left L-locator: a 6-module arm along the top edge (horizontal
 *     black/white band rows) and a 6-module arm along the left edge
 *     (vertical black/white band columns). The alternating bands run the
 *     full arm length, which makes scale detection very robust.
 *   - Bottom-right corner marker: a solid black 6×6 block. The locator
 *     and marker are diagonally opposite, so the decoder can detect a
 *     180° rotation (camera held upside down) by checking which corner
 *     is the marker.
 *   - Data region: the (N−14)×(N−14) interior. Each module carries 3
 *     bits, masked with a deterministic per-position 3-bit pattern so
 *     the eight colors stay evenly distributed on screen (helps camera
 *     white balance and color classification).
 *   - Error correction: Reed–Solomon over GF(2⁸), RS(255,191) blocks
 *     (t = 32 byte errors per block), interleaved per 191-byte block,
 *     payload [lenHi][lenLo][data…] followed by zero-padding.
 *
 * Grid sizes are chosen from the payload: sides 32/40/48/56/64/72/80
 * (grid N = side + 14) give payload capacities of 189/380/571/762/1144/
 * 1335/1717 bytes. A 1400-byte light fragment fits a side-80 grid
 * (N = 94); a 1 KB fountain symbol fits side 64 (N = 78).
 */

export interface JabMatrix {
  /** Full grid size in modules (locator included). */
  size: number;
  /** 3-bit color index per module (0–7), row-major. */
  colors: Uint8Array;
}

/** The 8-color palette: RGB cube corners, index = bit-encoded RGB (R=1, G=2, B=4). */
export const JAB_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0 black
  [255, 0, 0], // 1 red
  [0, 255, 0], // 2 green
  [255, 255, 0], // 3 yellow
  [0, 0, 255], // 4 blue
  [255, 0, 255], // 5 magenta
  [0, 255, 255], // 6 cyan
  [255, 255, 255], // 7 white
];

/** Data-region sides in modules (grid N = side + 14). */
export const JAB_SIDES = [32, 40, 48, 56, 64, 72, 80] as const;

export const JAB_BANDS = 6;
export const JAB_MARKER = 6;

/* ------------------------------------------------------------------ */
/* GF(2^8) arithmetic, polynomial 0x11d                                */

const GF_POLY = 0x11d;
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLY;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfInv(a: number): number {
  return GF_EXP[255 - GF_LOG[a]];
}

/* ------------------------------------------------------------------ */
/* Reed–Solomon RS(255,191), t = 32                                    */

export const RS_DATA = 191;
export const RS_PARITY = 64;
export const RS_LEN = 255;

/** Generator polynomial g(x) = ∏(x + α^i), leading coefficient first. */
const RS_GEN = (() => {
  let g = new Uint8Array([1]);
  for (let i = 0; i < RS_PARITY; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gfMul(g[j], GF_EXP[i]);
      next[j + 1] ^= g[j];
    }
    g = next;
  }
  const gen = new Uint8Array(RS_PARITY + 1);
  for (let j = 0; j <= RS_PARITY; j++) gen[j] = g[RS_PARITY - j];
  return gen;
})();

export function rsEncodeBlock(data: Uint8Array): Uint8Array {
  const parity = new Uint8Array(RS_PARITY);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ parity[0];
    parity.copyWithin(0, 1);
    parity[RS_PARITY - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < RS_PARITY; j++) parity[j] ^= gfMul(RS_GEN[j + 1], factor);
    }
  }
  const out = new Uint8Array(RS_LEN);
  out.set(data);
  out.set(parity, RS_DATA);
  return out;
}

/** Berlekamp–Massey: error locator σ(x), low→high coefficients, σ(0) = 1. */
function berlekampMassey(syn: Uint8Array): Uint8Array {
  const n = syn.length;
  const C = new Array<number>(n + 1).fill(0);
  let B = new Array<number>(n + 1).fill(0);
  C[0] = 1;
  B[0] = 1;
  let L = 0;
  let m = 1;
  let lastD = 1;
  for (let i = 0; i < n; i++) {
    let d = syn[i];
    for (let j = 1; j <= L; j++) d ^= gfMul(C[j], syn[i - j]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gfMul(d, gfInv(lastD));
    if (2 * L <= i) {
      const T = C.slice();
      for (let j = 0; j + m <= n; j++) C[j + m] ^= gfMul(coef, B[j]);
      L = i + 1 - L;
      B = T;
      lastD = d;
      m = 1;
    } else {
      for (let j = 0; j + m <= n; j++) C[j + m] ^= gfMul(coef, B[j]);
      m++;
    }
  }
  return new Uint8Array(C.slice(0, L + 1));
}

/**
 * Decode one 255-byte RS block. Returns the 191 data bytes, or null when
 * the block has more errors than t (or the errors are undecodable).
 */
function rsDecodeBlock(code: Uint8Array): Uint8Array | null {
  const syn = new Uint8Array(RS_PARITY);
  let hasError = false;
  for (let i = 0; i < RS_PARITY; i++) {
    const xi = GF_EXP[i];
    let s = 0;
    for (let j = 0; j < RS_LEN; j++) s = gfMul(s, xi) ^ code[j];
    syn[i] = s;
    if (s !== 0) hasError = true;
  }
  if (!hasError) return code.slice(0, RS_DATA);

  const sigma = berlekampMassey(syn);
  const deg = sigma.length - 1;
  if (deg === 0 || deg > RS_PARITY / 2) return null;

  // Chien search: an error at code index (RS_LEN-1-p) is a root at α^{-p}.
  const positions: number[] = [];
  for (let p = 0; p < RS_LEN; p++) {
    const xp = GF_EXP[(255 - (p % 255)) % 255];
    let v = 0;
    let x = 1;
    for (let j = 0; j < sigma.length; j++) {
      v ^= gfMul(sigma[j], x);
      x = gfMul(x, xp);
    }
    if (v === 0) positions.push(p);
  }
  if (positions.length !== deg) return null;

  // Ω(x) = S(x)·σ(x) mod x^64 with S(x) = Σ syn[i]·x^i
  const omega = new Uint8Array(RS_PARITY);
  for (let i = 0; i < RS_PARITY; i++) {
    if (syn[i] === 0) continue;
    for (let j = 0; j < sigma.length && i + j < RS_PARITY; j++) {
      omega[i + j] ^= gfMul(syn[i], sigma[j]);
    }
  }
  // σ'(x): drop even coefficients, shift odd ones down.
  const deriv = new Uint8Array(Math.max(0, sigma.length - 1));
  for (let j = 1; j < sigma.length; j += 2) deriv[j - 1] = sigma[j];

  const out = code.slice();
  for (const p of positions) {
    const xp = GF_EXP[(255 - (p % 255)) % 255];
    const ap = GF_EXP[p % 255];
    let omegaVal = 0;
    let x = 1;
    for (let j = 0; j < omega.length; j++) {
      omegaVal ^= gfMul(omega[j], x);
      x = gfMul(x, xp);
    }
    let derivVal = 0;
    x = 1;
    for (let j = 0; j < deriv.length; j++) {
      derivVal ^= gfMul(deriv[j], x);
      x = gfMul(x, xp);
    }
    if (derivVal === 0) return null;
    // Error magnitude e_p = α^p · Ω(α^{-p}) / σ'(α^{-p}).
    const e = gfMul(gfMul(ap, omegaVal), gfInv(derivVal));
    out[RS_LEN - 1 - p] ^= e;
  }
  // Verify the corrected codeword — undecodable errors must not slip through.
  for (let i = 0; i < RS_PARITY; i++) {
    const xi = GF_EXP[i];
    let s = 0;
    for (let j = 0; j < RS_LEN; j++) s = gfMul(s, xi) ^ out[j];
    if (s !== 0) return null;
  }
  return out.slice(0, RS_DATA);
}

/* ------------------------------------------------------------------ */
/* Grid math + masking                                                 */

/** Total RS data bytes a side fits (caller passes payload length + 2 header). */
function sideCapacity(side: number): number {
  const C = Math.floor((3 * side * side) / 8);
  return Math.floor(C / RS_LEN) * RS_DATA;
}

function gridSideFor(bytes: number): number {
  for (const s of JAB_SIDES) {
    if (bytes <= sideCapacity(s)) return s;
  }
  return -1;
}

/** Deterministic 3-bit mask for the module at physical position (x, y). */
function maskFor(n: number, x: number, y: number): number {
  let h =
    (Math.imul(n >>> 0, 0x9e3779b1) ^
      Math.imul(x >>> 0, 0x85ebca6b) ^
      Math.imul(y >>> 0, 0xc2b2ae35)) >>>
    0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h & 7;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */

/** Encode a payload as a JAB module matrix. Throws when too large. */
export function encodeJab(data: Uint8Array): JabMatrix {
  const side = gridSideFor(data.length + 2);
  if (side < 0) {
    throw new Error(`payload ${data.length} bytes is too large for a JAB code`);
  }
  const n = side + 14;
  const C = Math.floor((3 * side * side) / 8);
  const blocksMax = Math.floor(C / RS_LEN);

  const payload = new Uint8Array(data.length + 2);
  payload[0] = (data.length >> 8) & 0xff;
  payload[1] = data.length & 0xff;
  payload.set(data, 2);

  // RS blocks, zero-padded to the grid's full codeword capacity (the all-zero
  // tail is a valid codeword, so the decoder can decode every block).
  const blocks = Math.ceil(payload.length / RS_DATA);
  const stream = new Uint8Array(blocksMax * RS_LEN);
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(RS_DATA);
    block.set(payload.subarray(b * RS_DATA, b * RS_DATA + RS_DATA));
    stream.set(rsEncodeBlock(block), b * RS_LEN);
  }

  // Pack 3 bits per data module, MSB-first.
  const dataColors = new Uint8Array(side * side);
  let bit = 0;
  for (let m = 0; m < side * side; m++) {
    let idx = 0;
    for (let k = 0; k < 3; k++) {
      const b = bit + k;
      const byte = b >> 3 < stream.length ? stream[b >> 3] : 0;
      idx = (idx << 1) | ((byte >> (7 - (b & 7))) & 1);
    }
    bit += 3;
    dataColors[m] = idx;
  }

  const colors = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const border = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      const marker = x >= n - JAB_MARKER - 1 && y >= n - JAB_MARKER - 1;
      const topArm = y >= 1 && y <= JAB_BANDS && x >= 1 && x <= n - 2;
      const leftArm = x >= 1 && x <= JAB_BANDS && y >= 1 && y <= n - 2;
      if (border || marker) {
        colors[y * n + x] = 0;
      } else if (topArm) {
        colors[y * n + x] = y % 2 === 1 ? 0 : 7;
      } else if (leftArm) {
        colors[y * n + x] = x % 2 === 1 ? 0 : 7;
      } else {
        const dx = x - JAB_BANDS - 1;
        const dy = y - JAB_BANDS - 1;
        colors[y * n + x] = dataColors[dy * side + dx] ^ maskFor(n, x, y);
      }
    }
  }
  return { size: n, colors };
}

/** Rasterize a JAB matrix to RGBA pixels with a white quiet zone. */
export function paintJab(
  matrix: JabMatrix,
  scale = 8,
  quiet = 4,
): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const n = matrix.size;
  const size = (n + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = JAB_PALETTE[matrix.colors[y * n + x] & 7];
      const px = (x + quiet) * scale;
      const py = (y + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((py + dy) * size + px) * 4;
        for (let dx = 0; dx < scale; dx++) {
          const i = row + dx * 4;
          rgba[i] = c[0];
          rgba[i + 1] = c[1];
          rgba[i + 2] = c[2];
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return { width: size, height: size, rgba };
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */

const DARK_LUM = 130;
const DARK_SAT = 70;

function isDark(r: number, g: number, b: number): boolean {
  const lum = (r + g + b) / 3;
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return lum < DARK_LUM && max - min < DARK_SAT;
}

function sampleModule(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  left: number,
  top: number,
  scale: number,
  mx: number,
  my: number,
): [number, number, number] {
  const cx = left + (mx + 0.5) * scale;
  const cy = top + (my + 0.5) * scale;
  const rw = Math.max(0, Math.floor(scale * 0.28));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let dy = -rw; dy <= rw; dy++) {
    const py = Math.round(cy + dy);
    if (py < 0 || py >= h) continue;
    for (let dx = -rw; dx <= rw; dx++) {
      const px = Math.round(cx + dx);
      if (px < 0 || px >= w) continue;
      const i = (py * w + px) * 4;
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
      count++;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [r / count, g / count, b / count];
}

/** Mean RGB of a 1-px band just outside / inside the bbox edges. */
function bandMean(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  outside: boolean,
): [number, number, number] {
  const topD = outside ? -1 : 1;
  const bottomD = outside ? 1 : -1;
  const leftD = outside ? -1 : 1;
  const rightD = outside ? 1 : -1;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const add = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const i = (py * w + px) * 4;
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    count++;
  };
  for (let x = left; x <= right; x++) {
    add(x, top + topD);
    add(x, bottom + bottomD);
  }
  for (let y = top; y <= bottom; y++) {
    add(left + leftD, y);
    add(right + rightD, y);
  }
  return [r / count, g / count, b / count];
}

/** Data byte capacity of the grid for a decoded size n. */
function gridCapacity(n: number): { side: number; blocksMax: number } {
  const side = n - 14;
  const C = Math.floor((3 * side * side) / 8);
  return { side, blocksMax: Math.floor(C / RS_LEN) };
}

function classify(r: number, g: number, b: number, black: [number, number, number], white: [number, number, number]): number {
  const dr = Math.max(1, white[0] - black[0]);
  const dg = Math.max(1, white[1] - black[1]);
  const db = Math.max(1, white[2] - black[2]);
  const nr = Math.min(1, Math.max(0, (r - black[0]) / dr));
  const ng = Math.min(1, Math.max(0, (g - black[1]) / dg));
  const nb = Math.min(1, Math.max(0, (b - black[2]) / db));
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 8; i++) {
    const pr = i & 1 ? 1 : 0;
    const pg = i & 2 ? 1 : 0;
    const pb = i & 4 ? 1 : 0;
    const d = (nr - pr) * (nr - pr) + (ng - pg) * (ng - pg) + (nb - pb) * (nb - pb);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Count black / non-black modules in a 6×6 corner block of the grid. */
function cornerStats(colors: Uint8Array, n: number, cx: number, cy: number): { black: number; nonBlack: number } {
  let black = 0;
  let nonBlack = 0;
  for (let y = cy; y < cy + 6; y++) {
    for (let x = cx; x < cx + 6; x++) {
      if ((colors[y * n + x] & 7) === 0) black++;
      else nonBlack++;
    }
  }
  return { black, nonBlack };
}

/**
 * Decode a JAB code from raw RGBA pixels. Returns the payload bytes or
 * null when no code could be decoded. Handles 0° and 180° rotation.
 */
export function decodeJab(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array | null {
  if (w < 60 || h < 60) return null;

  // Only the border rows and the top-arm stripe rows run black across the
  // whole code width, so the longest dark run in the frame anchors the
  // vertical extent; the border columns do the same horizontally.
  let maxRow = 0;
  for (let y = 0; y < h; y++) {
    let run = 0;
    let best = 0;
    const rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * 4;
      if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    if (best > maxRow) maxRow = best;
  }
  if (maxRow < 60) return null;
  const rowThr = maxRow * 0.75;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    let run = 0;
    let best = 0;
    const rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * 4;
      if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    if (best >= rowThr) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;
  let maxCol = 0;
  for (let x = 0; x < w; x++) {
    let run = 0;
    let best = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    if (best > maxCol) maxCol = best;
  }
  if (maxCol < 60) return null;
  const colThr = maxCol * 0.75;
  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x++) {
    let run = 0;
    let best = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    if (best >= colThr) {
      if (left < 0) left = x;
      right = x;
    }
  }
  if (left < 0) return null;
  // The quiet zone must exist around the whole code.
  if (top < 2 || left < 2 || right > w - 3 || bottom > h - 3) return null;

  const bw = right - left + 1;
  const bh = bottom - top + 1;
  if (bw < 60 || bh < 60) return null;

  // Module scale from the arm's stripe columns: the border column plus
  // black-stripe columns at module offsets 1, 3, 5 (spaced 2 modules apart).
  // The arm sits on the left (unrotated) or on the right (rotated 180°).
  const scanSpan = Math.max(64, Math.floor(bw * 0.15));
  const stripeScale = (from: number, dir: 1 | -1): number | null => {
    // Column darkness across the code height: arm modules are 1 module wide
    // and alternate dark/light, so the left arm reads (in modules):
    //   dark(2: border + stripe) light(1) dark(1) light(1) dark(1) light(1) …
    const dark: boolean[] = [];
    for (let k = 0; k <= scanSpan && k < bw; k++) {
      const x = from + dir * k;
      let d = 0;
      for (let y = top; y <= bottom; y++) {
        const i = (y * w + x) * 4;
        if (isDark(rgba[i], rgba[i + 1], rgba[i + 2])) d++;
      }
      dark.push(d / bh > 0.45);
    }
    const runs: Array<{ dark: boolean; len: number }> = [];
    for (const d of dark) {
      if (runs.length > 0 && runs[runs.length - 1].dark === d) runs[runs.length - 1].len++;
      else runs.push({ dark: d, len: 1 });
    }
    const seq = runs.slice(runs.findIndex((r) => r.dark));
    if (seq.length < 5) return null;
    // Modules 0..5 are guaranteed by design: border + stripes 1,3,5 dark,
    // stripes 2,4 light — runs dark(2) light(1) dark(1) light(1) dark(1).
    // Data modules beyond that are arbitrary, so they are not validated.
    const s = (seq[1].len + seq[3].len) / 2;
    if (s < 2.5) return null;
    const expect = [2, 1, 1, 1, 1];
    for (let i = 0; i < expect.length; i++) {
      if (Math.abs(seq[i].len / s - expect[i]) > 0.4) return null;
    }
    return s;
  };
  let scale = stripeScale(left, 1);
  let rotated = false;
  if (scale === null) {
    scale = stripeScale(right, -1);
    if (scale === null) return null;
    rotated = true;
  }

  // Grid size from the bounding box — must be one of the supported sizes.
  const n = Math.round(bw / scale);
  if (Math.abs(bw / scale - n) > 0.35 || Math.abs(bh / scale - n) > 0.35) return null;
  if (!JAB_SIDES.includes((n - 14) as (typeof JAB_SIDES)[number])) return null;

  // Quiet zone must be white — rejects dark backgrounds.
  const quiet = bandMean(rgba, w, h, left, top, right, bottom, true);
  if (quiet[0] < 170 || quiet[1] < 170 || quiet[2] < 170) return null;

  // Black reference from the top border row (all black); white from the
  // quiet zone — both invariant to arm stripes and data content.
  const bcy = top + Math.floor(scale / 2);
  let blkR = 0;
  let blkG = 0;
  let blkB = 0;
  let bcount = 0;
  for (let x = left; x <= right; x++) {
    const i = (bcy * w + x) * 4;
    blkR += rgba[i];
    blkG += rgba[i + 1];
    blkB += rgba[i + 2];
    bcount++;
  }
  const black: [number, number, number] = [blkR / bcount, blkG / bcount, blkB / bcount];

  // Sample and classify every module.
  const colors = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [r, g, b] = sampleModule(rgba, w, h, left, top, scale, x, y);
      colors[y * n + x] = classify(r, g, b, black, quiet);
    }
  }

  // Orientation: the only structurally unique corner is the solid black
  // marker (36 black, 0 white) — the L-locator and the two arm corners all
  // carry the same band pattern (26 black, 10 white). The marker must be
  // both the darkest and the least white corner; its diagonal opposite is
  // the L-locator. Marker at bottom-right = unrotated, at top-left = 180°.
  const tl = cornerStats(colors, n, 0, 0);
  const tr = cornerStats(colors, n, n - 6, 0);
  const bl = cornerStats(colors, n, 0, n - 6);
  const br = cornerStats(colors, n, n - 6, n - 6);
  const corners = [
    { at: "tl", black: tl.black, white: tl.nonBlack },
    { at: "tr", black: tr.black, white: tr.nonBlack },
    { at: "bl", black: bl.black, white: bl.nonBlack },
    { at: "br", black: br.black, white: br.nonBlack },
  ] as const;
  let marker: { at: "tl" | "tr" | "bl" | "br"; black: number; white: number } = corners[0];
  for (const c of corners) {
    if (c.black > marker.black || (c.black === marker.black && c.white < marker.white)) marker = c;
  }
  if (marker.black < 30 || marker.white > 5) return null;
  // The marker corner must agree with the arm-side detection.
  if (rotated && marker.at !== "tl") return null;
  if (!rotated && marker.at !== "br") return null;

  // Read the data modules (physical coordinates, unmasked) into a bitstream.
  const { side, blocksMax } = gridCapacity(n);
  const stream = new Uint8Array(blocksMax * RS_LEN);
  let bit = 0;
  for (let dy = 0; dy < side; dy++) {
    for (let dx = 0; dx < side; dx++) {
      let px: number;
      let py: number;
      if (rotated) {
        px = n - 1 - (dx + JAB_BANDS + 1);
        py = n - 1 - (dy + JAB_BANDS + 1);
      } else {
        px = dx + JAB_BANDS + 1;
        py = dy + JAB_BANDS + 1;
      }
      // The mask is defined on the code's own coordinates, so a rotated
      // image must unmask with the position the module had before rotation.
      const mx = rotated ? n - 1 - px : px;
      const my = rotated ? n - 1 - py : py;
      const idx = (colors[py * n + px] & 7) ^ maskFor(n, mx, my);
      for (let k = 0; k < 3; k++) {
        const b = bit + k;
        if ((idx >> (2 - k)) & 1) stream[b >> 3] |= 1 << (7 - (b & 7));
      }
      bit += 3;
    }
  }

  // RS-decode every block, then strip the length header.
  const dataOut = new Uint8Array(blocksMax * RS_DATA);
  for (let b = 0; b < blocksMax; b++) {
    const block = rsDecodeBlock(stream.subarray(b * RS_LEN, (b + 1) * RS_LEN));
    if (!block) return null;
    dataOut.set(block, b * RS_DATA);
  }
  const len = (dataOut[0] << 8) | dataOut[1];
  const cap = blocksMax * RS_DATA - 2;
  if (len < 1 || len > cap) return null;
  return dataOut.slice(2, 2 + len);
}

