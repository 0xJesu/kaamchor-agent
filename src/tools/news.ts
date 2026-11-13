import { Counter, fetchText } from "../counter";

export type Headline = { title: string; source: string; date: string; url: string };

const dec = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const tag = (x: string, t: string) => dec(x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "");

/** Hand-written RSS parse (no libs: CPU/size limits). */
export function parseNewsRss(xml: string, max = 5): Headline[] {
  const out: Headline[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    let title = tag(item, "title"); const source = tag(item, "source");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const d = new Date(tag(item, "pubDate"));
    out.push({ title, source, date: isNaN(+d) ? "" : d.toISOString().slice(0, 10), url: tag(item, "link") });
    if (out.length >= max) break;
  }
  return out;
}

export async function getNews(c: Counter, topic: string, max = 5): Promise<Headline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic + " when:2d")}&hl=en-IN&gl=IN&ceid=IN:en`;
  return parseNewsRss(await fetchText(c, url, { maxBytes: 300_000 }), max);
}

/** Small stable hash for dedup of headlines. */
export function hashTitle(t: string): string {
  let h = 5381; const s = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
