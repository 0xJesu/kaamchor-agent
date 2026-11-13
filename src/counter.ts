// Per-invocation caps: Workers Free allows 50 subrequests; we stop at 44 (demo mode: more model/tool calls per message).
export class CapError extends Error {}
export class Counter {
  sub = 0; modelCalls = 0; toolCalls = 0; readUrls = 0;
  constructor(public maxSub = 44, public maxModel = 10, public maxTools = 14) {}
  /** Call before every outbound fetch / AI call / Telegram call. */
  tick(n = 1) { this.sub += n; if (this.sub > this.maxSub) throw new CapError("subrequest cap"); }
  model() { if (++this.modelCalls > this.maxModel) throw new CapError("model call cap"); this.tick(); }
  tool() { if (++this.toolCalls > this.maxTools) throw new CapError("tool call cap"); }
}

/** fetch with timeout, counted against the subrequest cap. Returns text capped at maxBytes. */
export async function fetchText(c: Counter, url: string, opts: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  c.tick();
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), headers: { "user-agent": "Mozilla/5.0 KaamAgent", ...opts.headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readCapped(res, opts.maxBytes ?? 1_000_000);
}

export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder(); let out = ""; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length; out += dec.decode(value, { stream: true });
    if (n >= maxBytes) { await reader.cancel(); break; }
  }
  return out;
}
