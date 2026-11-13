import type { KaamAgent } from "./agent";
import { Counter } from "./counter";
import { checkBudget } from "./budget";
import { complete, LimitError } from "./llm";
import { getProfile, listFacts, logActivity, setProfile } from "./memory";
import { briefingPrompt, summaryPrompt, watchJudgePrompt, wrapupPrompt } from "./prompts";
import { escapeHtml } from "./telegram";
import { getNews, hashTitle } from "./tools/news";
import { getWeather } from "./tools/weather";
import { formatIST, formatISTDateTime, inQuietHours, istMidnight, istToCron, parseWhen } from "./time";

/** Runs a job; on failure retries once after 5 minutes, then logs and waits for the next run. */
export async function run(a: KaamAgent, name: string, payload: any, fn: () => Promise<void>) {
  // Watches chain themselves: schedule the next check first so a failure can't break the chain.
  if (name === "watchCheck" && !payload?.retry) await rescheduleWatch(a, payload.id);
  const t0 = Date.now();
  try {
    await fn();
    console.log(JSON.stringify({ type: "job", job: name, duration_ms: Date.now() - t0 }));
  } catch (e) {
    console.log(JSON.stringify({ type: "error", where: name, error: String(e).slice(0, 300) }));
    if (payload?.retry) { logActivity(a.q, "error", `${name} failed twice, giving up: ${String(e).slice(0, 120)}`); return; }
    logActivity(a.q, "error", `${name} failed, retrying in 5 min: ${String(e).slice(0, 120)}`);
    await a.schedule(300, name as any, { ...(payload ?? {}), retry: true });
  }
}

const paused = (a: KaamAgent) => getProfile(a.q, "paused") === "1";
const quiet = (a: KaamAgent) => inQuietHours(new Date(), a.cfg.QUIET_HOURS);

/** Model call for a job; null if budget/limit blocks it. */
async function ask(a: KaamAgent, prompt: string, max = 450): Promise<{ text: string; neurons: number } | null> {
  if (checkBudget(a.q, a.cfg, "job") !== "ok") { logActivity(a.q, "limit", "job model call blocked by budget"); return null; }
  try { return await complete(a.cfg, a.q, new Counter(), prompt, max); }
  catch (e) { if (e instanceof LimitError) { logActivity(a.q, "limit", "Workers AI limit hit during job"); return null; } throw e; }
}

const topics = (a: KaamAgent) => (getProfile(a.q, "topics") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 2);

export async function morning(a: KaamAgent) {
  if (paused(a) || quiet(a)) { logActivity(a.q, "job_skipped", "morning briefing (paused or quiet hours)"); return; }
  const c = new Counter(); const lines: string[] = [];
  const city = getProfile(a.q, "city");
  if (city) {
    const w: any = await getWeather(c, city).catch(() => ({ error: "weather unavailable" }));
    lines.push(w.error ? `Weather: ${w.error}` : `Weather in ${w.place}: now ${w.now}; today ${w.today}`);
  }
  for (const t of topics(a)) {
    const n = await getNews(c, t, 3).catch(() => []);
    lines.push(`Headlines on "${t}":` + (n.length ? "\n" + n.map((h) => `- ${h.title} (${h.source}, ${h.date})`).join("\n") : " none found"));
  }
  const end = new Date(istMidnight(new Date()).getTime() + 864e5);
  const rem = a.q<any>`SELECT text, due_at FROM reminders WHERE sent = 0 AND due_at < ${end.toISOString()} ORDER BY due_at`;
  if (rem.length) lines.push("Today's reminders:\n" + rem.map((r) => `- ${formatIST(new Date(r.due_at))}: ${r.text}`).join("\n"));
  const held: string[] = JSON.parse(getProfile(a.q, "held") ?? "[]");
  if (held.length) lines.push("Watch findings overnight:\n" + held.map((h) => `- ${h}`).join("\n"));
  const data = lines.join("\n") || "(no data)";

  const r = await ask(a, briefingPrompt({ name: a.cfg.AGENT_NAME, now: formatISTDateTime(new Date()), city: city ?? "", facts: listFacts(a.q), data }));
  const body = r?.text || `Good morning!\n${data}`;
  await a.send(escapeHtml(body));
  setProfile(a.q, "held", "[]");
  logActivity(a.q, "briefing", "morning briefing sent", r?.neurons ?? 0);
}

export async function evening(a: KaamAgent) {
  if (paused(a) || quiet(a)) { logActivity(a.q, "job_skipped", "evening wrap-up (paused or quiet hours)"); return; }
  const stats = activityStats(a, istMidnight(new Date()));
  const found = a.q<any>`SELECT detail FROM activity_log WHERE type = 'watch_found' AND created_at >= ${istMidnight(new Date()).toISOString()}`;
  const rem = a.q<any>`SELECT text, due_at FROM reminders WHERE sent = 0 ORDER BY due_at LIMIT 10`;
  const data = `Today so far: ${stats}\nPending reminders: ${rem.length ? rem.map((r) => `${r.text} (${formatIST(new Date(r.due_at))})`).join("; ") : "none"}\nWatch findings today: ${found.length ? found.map((f) => f.detail).join("; ") : "none"}`;
  const r = await ask(a, wrapupPrompt({ name: a.cfg.AGENT_NAME, now: formatISTDateTime(new Date()), data }), 300);
  await a.send(escapeHtml(r?.text || `Evening wrap-up\n${data}`));
  logActivity(a.q, "wrapup", "evening wrap-up sent", r?.neurons ?? 0);
}

export function activityStats(a: KaamAgent, since: Date): string {
  const rows = a.q<{ type: string; c: number; n: number }>`SELECT type, COUNT(*) c, COALESCE(SUM(neurons),0) n FROM activity_log WHERE created_at >= ${since.toISOString()} GROUP BY type`;
  const by = Object.fromEntries(rows.map((r) => [r.type, r.c]));
  const neurons = Math.round(rows.reduce((s, r) => s + r.n, 0));
  const tools = a.q<{ detail: string; c: number }>`SELECT detail, COUNT(*) c FROM activity_log WHERE type = 'tool' AND created_at >= ${since.toISOString()} GROUP BY detail ORDER BY c DESC`;
  return `${by.message ?? 0} messages handled; ${tools.reduce((s, t) => s + t.c, 0)} tool uses (${tools.map((t) => `${t.detail}×${t.c}`).join(", ") || "none"}); ` +
    `${(by.briefing ?? 0) + (by.wrapup ?? 0)} briefings/wrap-ups; ${by.reminder_sent ?? 0} reminders sent; ${by.watch_check ?? 0} watch checks (${by.watch_found ?? 0} findings); ` +
    `${by.error ?? 0} errors; ${by.limit ?? 0} limit hits; ${by.unauthorized ?? 0} blocked non-owner messages; ~${neurons} Neurons used`;
}

export async function summary(a: KaamAgent): Promise<string> {
  const since = new Date(Date.now() - 864e5);
  const stats = activityStats(a, since);
  const notable = a.q<any>`SELECT type, detail FROM activity_log WHERE created_at >= ${since.toISOString()} AND type IN ('watch_found','reminder_sent','briefing','wrapup','error','reminder_set','watch_set') ORDER BY id DESC LIMIT 12`;
  const data = `${stats}\nNotable:\n${notable.map((n) => `- ${n.type}: ${n.detail}`).join("\n")}`;
  let r: { text: string } | null = null;
  try { r = await ask(a, summaryPrompt({ name: a.cfg.AGENT_NAME, stats: data }), 350); } catch { /* fall through to plain stats */ }
  return r?.text || `Last 24 hours:\n${data}`;
}

function parseJudge(raw: string): { significant: boolean; message: string } | null {
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { const o = JSON.parse(raw.slice(i, j + 1)); return { significant: o.significant === true, message: String(o.message ?? "") }; } catch { return null; }
}

export async function watch(a: KaamAgent, id: number) {
  const w = a.q<any>`SELECT * FROM watches WHERE id = ${id}`[0];
  if (!w) return;
  const c = new Counter();
  const news = await getNews(c, w.topic, 10);
  const seen: string[] = JSON.parse(w.seen_hashes || "[]");
  const fresh = news.filter((h) => !seen.includes(hashTitle(h.title)));
  a.q`UPDATE watches SET last_checked_at = ${new Date().toISOString()} WHERE id = ${id}`;
  logActivity(a.q, "watch_check", `${w.topic}: ${fresh.length} new`);
  if (!fresh.length) return; // zero model calls
  const r = await ask(a, watchJudgePrompt(w.topic, fresh.map((h) => `- ${h.title} (${h.source}, ${h.date})`).join("\n")), 250);
  if (!r) return; // budget blocked: leave items unseen, retry next check
  const merged = [...seen, ...fresh.map((h) => hashTitle(h.title))].slice(-30);
  a.q`UPDATE watches SET seen_hashes = ${JSON.stringify(merged)} WHERE id = ${id}`;
  const j = parseJudge(r.text);
  if (!j?.significant || !j.message) return;
  logActivity(a.q, "watch_found", `${w.topic}: ${j.message}`, r.neurons);
  if (paused(a) || quiet(a)) {
    const held: string[] = JSON.parse(getProfile(a.q, "held") ?? "[]");
    setProfile(a.q, "held", JSON.stringify([...held, `${w.topic}: ${j.message}`].slice(-10)));
    return;
  }
  await a.send(`🔔 <b>${escapeHtml(w.topic)}</b>\n${escapeHtml(j.message)}`);
}

export async function rescheduleWatch(a: KaamAgent, id: number) {
  const w = a.q<any>`SELECT every_hours FROM watches WHERE id = ${id}`[0];
  if (!w) return;
  const s = await a.schedule(w.every_hours * 3600, "watchCheck" as any, { id });
  a.q`UPDATE watches SET schedule_id = ${s.id} WHERE id = ${id}`;
}

/** Reminders use no model and ignore pause / quiet hours. */
export async function reminder(a: KaamAgent, id: number) {
  const r = a.q<any>`SELECT * FROM reminders WHERE id = ${id}`[0];
  if (!r || r.sent) return;
  await a.send(`⏰ <b>Reminder:</b> ${escapeHtml(r.text)}`);
  a.q`UPDATE reminders SET sent = 1 WHERE id = ${id}`;
  logActivity(a.q, "reminder_sent", r.text);
}

export async function demoEnd(a: KaamAgent) {
  await a.send(escapeHtml(await summary(a)));
  logActivity(a.q, "summary", "demo-end report sent");
}

export async function setup(a: KaamAgent): Promise<string> {
  for (const s of a.getSchedules()) if (["morningBriefing", "eveningWrapup", "demoEnd"].includes(s.callback)) await a.cancelSchedule(s.id);
  const e = a.cfg;
  await a.schedule(istToCron(e.MORNING_BRIEFING_TIME), "morningBriefing" as any, {});
  await a.schedule(istToCron(e.EVENING_WRAPUP_TIME), "eveningWrapup" as any, {});
  let out = `morning ${e.MORNING_BRIEFING_TIME} IST, evening ${e.EVENING_WRAPUP_TIME} IST`;
  if (e.DEMO_END_AT) {
    const d = parseWhen(e.DEMO_END_AT);
    if (d && d.getTime() > Date.now()) { await a.schedule(d, "demoEnd" as any, {}); out += `, demo-end report ${formatIST(d)}`; }
  }
  return out;
}
