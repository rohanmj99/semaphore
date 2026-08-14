export class HaveBitmap {
  readonly totalChunks: number;
  private bits: Uint8Array;

  constructor(totalChunks: number, bits?: Uint8Array) {
    this.totalChunks = totalChunks;
    this.bits = bits ?? new Uint8Array(Math.max(1, Math.ceil(totalChunks / 8)));
  }

  /** Re-seed the bitmap size when the manifest arrives. Existing bits are kept. */
  rebuild(totalChunks: number) {
    const bits = new Uint8Array(Math.max(1, Math.ceil(totalChunks / 8)));
    const keep = Math.min(bits.length, this.bits.length);
    for (let i = 0; i < keep; i++) bits[i] = this.bits[i];
    (this as { totalChunks: number }).totalChunks = totalChunks;
    this.bits = bits;
  }

  has(i: number): boolean {
    return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
  }

  set(i: number) {
    this.bits[i >> 3] |= 1 << (i & 7);
  }

  get count(): number {
    let n = 0;
    for (const b of this.bits) {
      n += b.toString(2).split("1").length - 1;
    }
    return n;
  }

  get all(): boolean {
    return this.count >= this.totalChunks;
  }

  /** Chunk indices still missing (also the repair-priority list). */
  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (this.has(i) === false && i < this.totalChunks) out.push(i);
    }
    return out;
  }

  missingCount(): number {
    return this.totalChunks - this.count;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.bits.length + 4);
    out.set(this.bits, 0);
    new DataView(out.buffer).setUint32(out.length - 4, this.totalChunks, false);
    return out;
  }

  static fromBytes(b: Uint8Array): HaveBitmap {
    if (b.length < 5) throw new Error("invalid bitmap");
    const total = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(b.length - 4, false);
    return new HaveBitmap(total, b.subarray(0, b.length - 4));
  }

  /** Lossy JSON form for pairing QRs / tones. */
  toRleString(): string {
    const missing = this.missing();
    const runs: string[] = [];
    for (let i = 0; i < missing.length; i++) {
      let j = i;
      while (j + 1 < missing.length && missing[j + 1] === missing[j] + 1) j++;
      runs.push(j > i ? `${missing[i]}-${missing[j]}` : `${missing[i]}`);
      i = j;
    }
    return runs.join(",");
  }
}