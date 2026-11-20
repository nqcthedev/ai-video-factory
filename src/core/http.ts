import { HttpError } from "./errors.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | object;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/** Parse "Retry-After" (seconds or HTTP date) and Google's "Please retry in 3h6m19.3s" / RetryInfo hints. */
export function parseRetryAfter(headers: Headers | undefined, body: string, now = Date.now()): number | undefined {
  const h = headers?.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(h);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const m = /retry in ((?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+s)?)/i.exec(body) ?? /"retryDelay":\s*"([\d.]+s)"/.exec(body);
  if (m?.[1]) return parseGoDuration(m[1]);
  return undefined;
}

export function parseGoDuration(s: string): number | undefined {
  const re = /([\d.]+)(h|ms|m|s)/g;
  let total = 0;
  let matched = false;
  for (const [, n, unit] of s.matchAll(re)) {
    matched = true;
    const v = Number(n);
    total += unit === "h" ? v * 3_600_000 : unit === "m" ? v * 60_000 : unit === "s" ? v * 1000 : v;
  }
  return matched ? Math.round(total) : undefined;
}

async function request(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = 120_000, fetch: f = globalThis.fetch, body, headers, ...rest } = opts;
  const isJsonBody = body !== undefined && typeof body === "object" && !(body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(body) && !(body instanceof Blob) && !(body instanceof FormData) &&
    !(body instanceof URLSearchParams) && !(body instanceof ReadableStream);
  const h = new Headers(headers);
  if (isJsonBody && !h.has("content-type")) h.set("content-type", "application/json");
  const res = await f(url, {
    ...rest,
    headers: h,
    body: isJsonBody ? JSON.stringify(body) : (body as BodyInit | undefined),
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError({ status: res.status, body: text, url, retryAfterMs: parseRetryAfter(res.headers, text) });
  }
  return res;
}

export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await request(url, opts);
  return (await res.json()) as T;
}

export async function httpBuffer(url: string, opts: HttpOptions = {}): Promise<{ data: Buffer; contentType: string | null; headers: Headers }> {
  const res = await request(url, opts);
  return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type"), headers: res.headers };
}

export async function httpRaw(url: string, opts: HttpOptions = {}): Promise<Response> {
  return request(url, opts);
}
