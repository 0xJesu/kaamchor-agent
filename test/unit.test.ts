import { describe, expect, it } from "vitest";
import { gate } from "../src/budget";
import { parseProtocol } from "../src/llm";
import { isSensitive, mask } from "../src/memory";
import { neuronCost } from "../src/models";
import { escapeHtml, safeEqual, splitMessage } from "../src/telegram";
import { inQuietHours, istToCron, parseWhen } from "../src/time";
import { hashTitle, parseNewsRss } from "../src/tools/news";
import { htmlToText, isSafeUrl } from "../src/tools/readUrl";
import { Counter, CapError } from "../src/counter";

// 2026-11-13 10:00 IST = 04:30 UTC
const NOW = new Date("2026-11-13T04:30:00Z");

describe("time", () => {
  it("parses relative", () => expect(parseWhen("in 10 minutes", NOW)!.getTime()).toBe(NOW.getTime() + 600_000));
  it("parses 'at 6 PM' (today, later)", () => expect(parseWhen("at 6 PM", NOW)!.toISOString()).toBe("2026-11-13T12:30:00.000Z"));
  it("'at 9am' already passed -> tomorrow", () => expect(parseWhen("at 9am", NOW)!.toISOString()).toBe("2026-11-14T03:30:00.000Z"));
  it("parses 'tomorrow 9am'", () => expect(parseWhen("tomorrow 9am", NOW)!.toISOString()).toBe("2026-11-14T03:30:00.000Z"));
  it("ISO without zone is IST", () => expect(parseWhen("2026-11-13T18:00", NOW)!.toISOString()).toBe("2026-11-13T12:30:00.000Z"));
  it("garbage -> null", () => expect(parseWhen("whenever", NOW)).toBeNull());
  it("cron conversion", () => { expect(istToCron("08:00")).toBe("30 2 * * *"); expect(istToCron("20:00")).toBe("30 14 * * *"); expect(istToCron("04:00")).toBe("30 22 * * *"); });
  it("quiet hours wrap midnight", () => {
    const at = (h: string) => new Date(`2026-11-13T${h}:00+05:30`);
    expect(inQuietHours(at("23:30"), "23:00-07:00")).toBe(true);
    expect(inQuietHours(at("03:00"), "23:00-07:00")).toBe(true);
    expect(inQuietHours(at("07:00"), "23:00-07:00")).toBe(false);
    expect(inQuietHours(at("20:00"), "23:00-07:00")).toBe(false);
  });
});

describe("telegram helpers", () => {
  it("escapes html", () => expect(escapeHtml("<b>&")).toBe("&lt;b&gt;&amp;"));
  it("splits long text under 4000", () => {
    const parts = splitMessage(("word ".repeat(300) + "\n").repeat(10));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, "")).toBe(("word".repeat(300)).repeat(10));
  });
  it("safeEqual", () => { expect(safeEqual("abc", "abc")).toBe(true); expect(safeEqual("abc", "abd")).toBe(false); expect(safeEqual("abc", "abcd")).toBe(false); });
});

describe("budget", () => {
  const l = { limit: 10000, reserve: 2000, margin: 500 };
  it("normal below 8000", () => expect(gate(7999, "chat", l)).toBe("ok"));
  it("resting at 8000 for chat, jobs still ok", () => { expect(gate(8000, "chat", l)).toBe("resting"); expect(gate(8000, "job", l)).toBe("ok"); });
  it("blocked above 9500 for everyone", () => { expect(gate(9500, "chat", l)).toBe("blocked"); expect(gate(9500, "job", l)).toBe("blocked"); });
  it("limit flag blocks", () => expect(gate(0, "job", l, true)).toBe("blocked"));
  it("cost estimate", () => expect(neuronCost("@cf/qwen/qwen3-30b-a3b-fp8", 5500, 300, 1.2)).toBeCloseTo(((5500 * 4625 + 300 * 30475) / 1e6) * 1.2));
});

describe("JSON fallback protocol", () => {
  it("parses reply", () => expect(parseProtocol('{"reply":"hi"}')).toEqual({ kind: "text", text: "hi" }));
  it("parses tool in fences + think", () =>
    expect(parseProtocol('<think>hmm</think>```json\n{"tool":"get_weather","args":{"city":"Guwahati"}}\n```')).toEqual({ kind: "tool", name: "get_weather", args: { city: "Guwahati" } }));
  it("rejects unknown tool and junk", () => { expect(parseProtocol('{"tool":"rm_rf","args":{}}')).toBeNull(); expect(parseProtocol("no json")).toBeNull(); });
});

describe("SSRF guard", () => {
  it.each(["http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://172.16.0.1/",
    "http://[::1]/", "http://[fd00::1]/", "file:///etc/passwd", "ftp://x.com/", "http://2130706433/", "http://intranet/", "http://user:pw@example.com/", "http://foo.internal/"])
    ("blocks %s", (u) => expect(isSafeUrl(u)).toBe(false));
  it.each(["https://example.com/a?b=1", "http://news.ycombinator.com"])("allows %s", (u) => expect(isSafeUrl(u)).toBe(true));
  it("strips html", () => expect(htmlToText("<html><head><title>x</title></head><script>evil()</script><p>Hello&nbsp;<b>world</b></p></html>")).toBe("Hello world"));
});

describe("sensitive data", () => {
  it("detects cards, otp, password", () => {
    expect(isSensitive("my card is 4111 1111 1111 1111")).toBe(true);
    expect(isSensitive("my password is hunter2")).toBe(true);
    expect(isSensitive("OTP 123456")).toBe(true);
    expect(isSensitive("I'm vegetarian")).toBe(false);
  });
  it("masks", () => expect(mask("card 4111111111111111 otp 99")).not.toMatch(/4111111111111111|otp 99/));
});

describe("news", () => {
  const xml = `<rss><channel><item><title>Cloudflare ships X - The Verge</title><link>https://n/1</link><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate><source url="x">The Verge</source></item>
  <item><title><![CDATA[Big &amp; news - Wired]]></title><link>https://n/2</link><pubDate>Thu, 12 Nov 2026 09:00:00 GMT</pubDate><source>Wired</source></item></channel></rss>`;
  it("parses rss", () => {
    const h = parseNewsRss(xml);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ title: "Cloudflare ships X", source: "The Verge", date: "2026-11-12" });
    expect(h[1].title).toBe("Big & news");
  });
  it("hash is case/punct insensitive", () => expect(hashTitle("Hello, World!")).toBe(hashTitle("hello world")));
});

describe("caps", () => {
  it("subrequest cap at 44", () => { const c = new Counter(); for (let i = 0; i < 44; i++) c.tick(); expect(() => c.tick()).toThrow(CapError); });
  it("model call cap at 10, tool cap at 14", () => {
    const c = new Counter(); for (let i = 0; i < 10; i++) c.model(); expect(() => c.model()).toThrow(CapError);
    const d = new Counter(); for (let i = 0; i < 14; i++) d.tool(); expect(() => d.tool()).toThrow(CapError);
  });
});

import { extractCode } from "../src/tools/github";
describe("extractCode", () => {
  it("keeps nested fences inside the outer block", () => {
    const out = "Here you go:\n```markdown\n# Title\n\n```bash\nnpm test\n```\n\nDone.\n```\nHope it helps";
    expect(extractCode(out)).toBe("# Title\n\n```bash\nnpm test\n```\n\nDone.\n");
  });
  it("plain code without fences passes through", () => expect(extractCode("const a = 1;  ")).toBe("const a = 1;\n"));
});
