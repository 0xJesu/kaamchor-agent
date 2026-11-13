import { Counter, fetchText } from "../counter";

type Hit = { title: string; snippet: string; url: string };
const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'");

/** DuckDuckGo Instant Answer + Wikipedia search. Free and keyless; both are best-effort. */
export async function webSearch(c: Counter, query: string): Promise<Hit[]> {
  const q = encodeURIComponent(query);
  const [ddg, wiki] = await Promise.allSettled([
    fetchText(c, `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`, { maxBytes: 200_000 }),
    fetchText(c, `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=4&origin=*`, { maxBytes: 200_000 }),
  ]);
  const hits: Hit[] = [];
  if (ddg.status === "fulfilled") {
    const j = JSON.parse(ddg.value);
    if (j.AbstractText) hits.push({ title: j.Heading || query, snippet: String(j.AbstractText).slice(0, 400), url: j.AbstractURL });
    for (const t of j.RelatedTopics ?? []) if (t.Text && t.FirstURL && hits.length < 3) hits.push({ title: t.Text.slice(0, 60), snippet: t.Text.slice(0, 300), url: t.FirstURL });
  }
  if (wiki.status === "fulfilled") {
    for (const r of JSON.parse(wiki.value).query?.search ?? []) {
      hits.push({ title: r.title, snippet: strip(r.snippet), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}` });
    }
  }
  if (!hits.length && ddg.status === "rejected" && wiki.status === "rejected") throw new Error("source unavailable");
  return hits.slice(0, 5);
}
