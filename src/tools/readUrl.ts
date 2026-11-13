import { Counter, readCapped } from "../counter";

/** SSRF guard: http(s) only, no localhost / private / link-local / loopback hosts. */
export function isSafeUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (h.includes(":")) { // IPv6 literal: block loopback, unspecified, ULA, link-local, v4-mapped
    if (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:")) return false;
  }
  if (/^\d+$/.test(h) || /^0x/i.test(h)) return false; // decimal / hex integer IPs
  return true;
}

export function htmlToText(html: string): string {
  return html
    .slice(0, 300_000) // keep regex work small (10 ms CPU limit)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

export async function readUrl(c: Counter, url: string): Promise<{ url: string; text: string } | { error: string }> {
  let cur = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (!isSafeUrl(cur)) return { error: "blocked or invalid URL" };
    c.tick();
    const res = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { "user-agent": "Mozilla/5.0 KaamAgent" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location")!, cur).toString();
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!/text|html|xml|json/i.test(ct)) { await res.body?.cancel(); return { error: "not a text page" }; }
    const body = await readCapped(res, 1_000_000);
    return { url: cur, text: (/html/i.test(ct) ? htmlToText(body) : body).slice(0, 6000) };
  }
  return { error: "too many redirects" };
}
