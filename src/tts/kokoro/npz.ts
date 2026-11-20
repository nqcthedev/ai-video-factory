import { unzipSync } from "fflate";

/** Parse a NumPy .npy buffer holding little-endian float32 data. */
export function parseNpyFloat32(buf: Uint8Array): { shape: number[]; data: Float32Array } {
  if (buf[0] !== 0x93 || String.fromCharCode(...buf.subarray(1, 6)) !== "NUMPY") throw new Error("not a .npy file");
  const major = buf[6]!;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder("latin1").decode(buf.subarray(headerStart, headerStart + headerLen));
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error(`unsupported dtype in npy header: ${header}`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran-order arrays not supported");
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  const shape = (shapeMatch?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const dataStart = headerStart + headerLen;
  const count = shape.reduce((a, b) => a * b, 1);
  // Copy into an aligned buffer (the zip entry offset is not guaranteed to be 4-byte aligned).
  const bytes = buf.slice(dataStart, dataStart + count * 4);
  return { shape, data: new Float32Array(bytes.buffer, bytes.byteOffset, count) };
}

/** Read every float32 array of a .npz archive (Kokoro ships its voice packs this way). */
export function parseNpz(buf: Uint8Array): Map<string, { shape: number[]; data: Float32Array }> {
  const files = unzipSync(buf);
  const out = new Map<string, { shape: number[]; data: Float32Array }>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".npy")) continue;
    out.set(name.replace(/\.npy$/, ""), parseNpyFloat32(bytes));
  }
  return out;
}
