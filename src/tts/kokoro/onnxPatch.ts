/**
 * Expose an intermediate tensor of an ONNX model as an extra graph output, by editing the
 * protobuf bytes directly (no onnx/protobuf dependency).
 *
 * Why: Kokoro predicts a duration (in 25 ms frames) for every phoneme token internally
 * (`/encoder/Cast_output_0`, the rounded+clamped `pred_dur`). Exposing it gives exact
 * phoneme — and therefore word — timestamps for free, which drive the karaoke captions.
 *
 * ModelProto.graph is field 7; GraphProto.output is field 12 (repeated ValueInfoProto);
 * ValueInfoProto.name is field 1. Appending a field to a length-delimited message is valid
 * protobuf, so we only need to rewrite the graph's length prefix.
 */
export const KOKORO_DURATION_TENSOR = "/encoder/Cast_output_0";

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    if (b === undefined) throw new Error("truncated varint");
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
}

function encodeVarint(n: number): Uint8Array {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

function lengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  return concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Iterate top-level protobuf fields: [fieldNumber, wireType, start, payloadStart, end]. */
function* fields(buf: Uint8Array): Generator<[number, number, number, number, number]> {
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const [tag, p1] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    let payloadStart = p1;
    let end: number;
    if (wire === 0) end = readVarint(buf, p1)[1];
    else if (wire === 1) end = p1 + 8;
    else if (wire === 5) end = p1 + 4;
    else if (wire === 2) {
      const [len, p2] = readVarint(buf, p1);
      payloadStart = p2;
      end = p2 + len;
    } else throw new Error(`unsupported wire type ${wire}`);
    yield [field, wire, start, payloadStart, end];
    pos = end;
  }
}

/** Names already declared as graph outputs (used to make patching idempotent). */
export function listGraphOutputs(model: Uint8Array): string[] {
  for (const [field, wire, , ps, end] of fields(model)) {
    if (field !== 7 || wire !== 2) continue;
    const graph = model.subarray(ps, end);
    const names: string[] = [];
    for (const [gf, gw, , gps, gend] of fields(graph)) {
      if (gf !== 12 || gw !== 2) continue;
      for (const [vf, vw, , vps, vend] of fields(graph.subarray(gps, gend))) {
        if (vf === 1 && vw === 2) names.push(new TextDecoder().decode(graph.subarray(gps + vps, gps + vend)));
      }
    }
    return names;
  }
  throw new Error("ONNX model has no graph");
}

export function addGraphOutput(model: Uint8Array, tensorName: string): Uint8Array {
  if (listGraphOutputs(model).includes(tensorName)) return model;
  const valueInfo = lengthDelimited(1, new TextEncoder().encode(tensorName));
  const parts: Uint8Array[] = [];
  let patched = false;
  for (const [field, wire, start, ps, end] of fields(model)) {
    if (field === 7 && wire === 2 && !patched) {
      parts.push(lengthDelimited(7, concat([model.subarray(ps, end), lengthDelimited(12, valueInfo)])));
      patched = true;
    } else parts.push(model.subarray(start, end));
  }
  if (!patched) throw new Error("ONNX model has no graph");
  return concat(parts);
}
