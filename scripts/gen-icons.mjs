import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");

const INK = [17, 17, 17, 255];
const PAPER = [250, 250, 247, 255];
const ACCENT = [232, 89, 12, 255];

let crcTable = null;
function crc32(buf, start, end) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    rgb.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function draw(size, maskable) {
  const c = size / 2;
  const px = Buffer.alloc(size * size * 4);
  const safe = maskable ? 0.4 : 0.6;
  const flagLen = size * safe;
  const flagW = Math.max(2, size * 0.16);
  const angA = Math.PI / 7;
  const angB = -Math.PI / 7;
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  const inFlag = (pxx, pyy, a) => {
    const [rx, ry] = rot(pxx, pyy, -a);
    const u = rx + flagLen / 2;
    return ry >= -flagW / 2 && ry <= flagW / 2 && u >= 0 && u <= flagLen && Math.abs(rx) <= flagLen * 0.55;
  };
  const round = (x, y) => Math.sqrt(x * x + y * y);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const i = (y * size + x) * 4;
      let col = INK;
      const inA = inFlag(dx, dy, angA) && round(dx, dy) < flagLen * 0.72;
      const inB = inFlag(dx, dy, angB) && round(dx, dy) < flagLen * 0.72;
      if (inA && inB) col = PAPER;
      else if (inA) col = ACCENT;
      else if (inB) col = PAPER;
      // rounded square backdrop
      const half = size * 0.5;
      const rCorner = size * 0.22;
      const bx = Math.max(Math.abs(dx) - (half - rCorner), 0);
      const by = Math.max(Math.abs(dy) - (half - rCorner), 0);
      if (Math.hypot(bx, by) > rCorner) col = [0, 0, 0, 0];
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = col[3];
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), encodePng(size, draw(size, false)));
  writeFileSync(join(OUT, `maskable-${size}.png`), encodePng(size, draw(size, true)));
}
console.log("icons written to public/icons");