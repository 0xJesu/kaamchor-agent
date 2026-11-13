import { Agent } from "agents";
import type { Env } from "./env";
import { CapError, Counter } from "./counter";
import { checkBudget, gate, limits, usedToday, type Sql } from "./budget";
import { agentLoop, complete, LimitError } from "./llm";
import {
  addFact, addMessage, applyFold, deleteFact, foldCandidates, getProfile, getSummary, initDb, listFacts,
  logActivity, purge, recentMessages, setProfile,
} from "./memory";
import { chatPrompt, foldPrompt } from "./prompts";
import { escapeHtml, sendMessage, sendTyping } from "./telegram";
import { TOOLS } from "./tools";
import { GitHub } from "./tools/github";
import type { ToolHost } from "./tools";
import { getNews, hashTitle } from "./tools/news";
import { formatIST, formatISTDateTime, parseWhen } from "./time";
import { handleCommand, handlePending, onboardingAnswer } from "./commands";
import * as jobs from "./jobs";

export type Job = { n: number; kind: "system" | "watch" | "reminder"; label: string; next: string; id?: number; scheduleId?: string };

export class KaamAgent extends Agent<Env> {
  get q(): Sql { return ((s: TemplateStringsArray, ...v: any[]) => this.sql(s, ...v)) as Sql; }
  get cfg(): Env { return this.env; }

  async onStart() {
    initDb(this.q);
    if (!getProfile(this.q, "started_at")) setProfile(this.q, "started_at", new Date().toISOString());
  }

  // ---------- Telegram entry ----------
  send(html: string) { return sendMessage(this.env.TELEGRAM_BOT_TOKEN, this.env.OWNER_TELEGRAM_ID, html); }

  async handleUpdate(update: any): Promise<void> {
    const t0 = Date.now(); const m = update?.message;
    try {
      initDb(this.q);
      if (!m) return;
      if (this.q`SELECT 1 FROM processed_updates WHERE update_id = ${update.update_id}`.length) return;
      this.q`INSERT INTO processed_updates (update_id, created_at) VALUES (${update.update_id}, ${new Date().toISOString()})`;
      purge(this.q);
      const owner = this.env.OWNER_TELEGRAM_ID;
      if (String(m.from?.id) !== owner || String(m.chat?.id) !== owner) {
        logActivity(this.q, "unauthorized", `update ${update.update_id} from non-owner ignored`);
        return;
      }
      console.log(JSON.stringify({ type: "update", update_id: update.update_id, msg: m.text ? "text" : "other", len: m.text?.length ?? 0 }));
      if (typeof m.text !== "string") { await this.send("I can only read text messages and links for now. Photos, voice notes and files aren't supported yet."); return; }
      // Commands are instant; anything that may call the model runs in its own alarm invocation
      // (survives after the webhook returns, gets its own logs, no 30 s waitUntil cutoff).
      const text = m.text.trim();
      if (text.startsWith("/") && !/^\/summary/i.test(text)) { await this.route(text); return; }
      await this.schedule(0, "processText", { text }, { retry: { maxAttempts: 1 } });
      return;
    } catch (e) {
      console.log(JSON.stringify({ type: "error", where: "handleUpdate", error: String(e).slice(0, 300) }));
      logActivity(this.q, "error", String(e).slice(0, 200));
      await this.send("Something went wrong on my side. Please try again in a minute.").catch(() => {});
    } finally {
      console.log(JSON.stringify({ type: "handled", duration_ms: Date.now() - t0 }));
    }
  }

  private async fail(e: unknown) {
    console.log(JSON.stringify({ type: "error", where: "route", error: String(e).slice(0, 300) }));
    logActivity(this.q, "error", String(e).slice(0, 200));
    await this.send("Something went wrong on my side. Please try again in a minute.").catch(() => {});
  }

  /** Alarm callback for model-bound messages. */
  async processText(p: { text: string }) {
    const t0 = Date.now();
    try { await this.route(p.text); }
    catch (e) { await this.fail(e); }
    finally { console.log(JSON.stringify({ type: "processed", duration_ms: Date.now() - t0 })); }
  }

  private async route(text: string) {
    if (await handlePending(this, text)) return;
    if (text.startsWith("/")) return handleCommand(this, text);
    if (await onboardingAnswer(this, text)) return;
    return this.chat(text);
  }

  // ---------- Conversation ----------
  async chat(text: string) {
    const sql = this.q; const env = this.env;
    const g = checkBudget(sql, env, "chat");
    if (g !== "ok") {
      logActivity(sql, "limit", `chat blocked (${g})`);
      await this.send(g === "resting"
        ? "I'm resting to save energy for your scheduled updates. Back at full power at 5:30 AM IST."
        : "I've used up today's free AI allowance, so I can't think right now. Reminders and commands still work. Back at 5:30 AM IST.");
      return;
    }
    const c = new Counter();
    try {
      c.tick(); await sendTyping(env.TELEGRAM_BOT_TOKEN, env.OWNER_TELEGRAM_ID);
      const allowed = new Set<string>(text.match(/https?:\/\/[^\s<>"')]+/g) ?? []);
      const host = this.makeHost(c, allowed);
      const city = getProfile(sql, "city") ?? "";
      const facts = listFacts(sql), summary = getSummary(sql);
      const toolList = TOOLS.map((t) => `${t.function.name}(${Object.keys((t.function.parameters as any).properties).join(", ")}): ${t.function.description}`).join("\n");
      const t0 = Date.now();
      const r = await agentLoop(env, sql, host, {
        system: (json) => chatPrompt({ name: env.AGENT_NAME, city, now: formatISTDateTime(new Date()), facts, summary, json, toolList }),
        history: recentMessages(sql), user: text,
      });
      addMessage(sql, "user", text); addMessage(sql, "assistant", r.text);
      await this.send(escapeHtml(r.text));
      logActivity(sql, "message", `handled in ${Date.now() - t0}ms, tools: ${r.tools.join(",") || "none"}${r.capped ? " (cap hit)" : ""}`, r.neurons);
      for (const t of r.tools) logActivity(sql, "tool", t);
      console.log(JSON.stringify({ type: "chat", duration_ms: Date.now() - t0, neurons: Math.round(r.neurons), tools: r.tools, subrequests: c.sub, model_calls: c.modelCalls }));
      await this.maybeFold();
    } catch (e) {
      await this.failChat(e);
    }
  }

  private async failChat(e: unknown) {
    const sql = this.q;
    if (e instanceof LimitError) {
      logActivity(sql, "limit", "Workers AI limit reached");
      if (getProfile(sql, "limit_notified") !== new Date().toISOString().slice(0, 10)) {
        setProfile(sql, "limit_notified", new Date().toISOString().slice(0, 10));
        await this.send("I've hit today's free AI limit, so I'll be quiet until it resets at 5:30 AM IST. Reminders and commands still work.");
      }
      return;
    }
    console.log(JSON.stringify({ type: "error", where: "chat", error: String(e).slice(0, 300) }));
    logActivity(sql, "error", `chat: ${String(e).slice(0, 150)}`);
    await this.send("I hit a snag thinking about that, try again in a minute.").catch(() => {});
  }

  private async maybeFold() {
    const sql = this.q;
    const rows = foldCandidates(sql);
    if (!rows || checkBudget(sql, this.env, "chat") !== "ok") return;
    try {
      const { text } = await complete(this.env, sql, new Counter(), foldPrompt(getSummary(sql), rows.map((r) => `${r.role}: ${r.content.slice(0, 400)}`).join("\n")), 200);
      if (text) applyFold(sql, rows.map((r) => r.id), text);
    } catch (e) { console.log(JSON.stringify({ type: "error", where: "fold", error: String(e).slice(0, 200) })); }
  }

  // ---------- Tool host ----------
  makeHost(c: Counter, allowedUrls: Set<string>): ToolHost {
    const sql = this.q;
    return {
      counter: c, allowedUrls,
      gh: new GitHub(this.env.GITHUB_TOKEN ?? "", c),
      sub: async (role, system, user, max) => {
        const model = role === "code" ? this.env.CODER_MODEL_ID : this.env.THINK_MODEL_ID;
        const r = await complete(this.env, sql, c, system, max, { model, thinking: role === "think", user });
        logActivity(sql, "tool", `${role}-model`, r.neurons);
        return r.text || "(empty)";
      },
      remember: (fact, category) => { const r = addFact(sql, fact, category); if (r.ok) logActivity(sql, "memory", `remember: ${fact}`); return r; },
      forget: (id) => { const ok = deleteFact(sql, id); if (ok) logActivity(sql, "memory", `forget #${id}`); return ok; },
      setReminder: (when, text) => this.setReminder(when, text),
      createWatch: (topic, hours) => this.createWatch(c, topic, hours),
      listJobs: () => this.jobsList().map((j) => ({ number: j.n, kind: j.kind, what: j.label, next: j.next })),
      cancelJob: (n) => this.cancelJobN(n),
    };
  }

  async setReminder(when: string, text: string) {
    const sql = this.q;
    const due = parseWhen(when);
    if (!due) return { error: `could not understand the time "${when}"` };
    if (due.getTime() < Date.now() + 5_000) return { error: "that time is in the past" };
    if (sql<{ c: number }>`SELECT COUNT(*) c FROM reminders WHERE sent = 0`[0].c >= 20) return { error: "20 pending reminders already; cancel one first" };
    const clean = text.slice(0, 200);
    sql`INSERT INTO reminders (text, due_at, sent) VALUES (${clean}, ${due.toISOString()}, 0)`;
    const id = sql<{ id: number }>`SELECT last_insert_rowid() id`[0].id;
    const s = await this.schedule(due, "sendReminder", { id });
    sql`UPDATE reminders SET schedule_id = ${s.id} WHERE id = ${id}`;
    logActivity(sql, "reminder_set", `${clean} @ ${formatIST(due)}`);
    return { ok: true, due: formatIST(due), text: clean };
  }

  async createWatch(c: Counter, topic: string, hours: number) {
    const sql = this.q;
    if (sql<{ c: number }>`SELECT COUNT(*) c FROM watches`[0].c >= 5) return { error: "5 watches already; cancel one first" };
    const every = Math.max(2, Math.min(hours || 3, 168));
    const seen = (await getNews(c, topic, 10).catch(() => [])).map((h) => hashTitle(h.title)); // seed: only NEW items ping later
    sql`INSERT INTO watches (topic, every_hours, last_checked_at, seen_hashes) VALUES (${topic.slice(0, 100)}, ${every}, ${new Date().toISOString()}, ${JSON.stringify(seen)})`;
    const id = sql<{ id: number }>`SELECT last_insert_rowid() id`[0].id;
    const s = await this.schedule(every * 3600, "watchCheck", { id });
    sql`UPDATE watches SET schedule_id = ${s.id} WHERE id = ${id}`;
    logActivity(sql, "watch_set", `${topic} every ${every}h`);
    return { ok: true, topic, every_hours: every, first_check: formatIST(new Date(Date.now() + every * 3600_000)) };
  }

  /** Numbered list shared by /jobs, /cancel and the list_jobs/cancel_job tools. */
  jobsList(): Job[] {
    const sql = this.q; const out: Job[] = [];
    const sys: Record<string, string> = { morningBriefing: "Morning briefing", eveningWrapup: "Evening wrap-up", demoEnd: "Demo-end report" };
    const cron = this.getSchedules().filter((s) => sys[s.callback]).sort((a, b) => a.callback.localeCompare(b.callback));
    for (const s of cron) out.push({ n: 0, kind: "system", label: sys[s.callback], next: formatIST(new Date(s.time * 1000)), scheduleId: s.id });
    for (const w of sql<any>`SELECT * FROM watches ORDER BY id`) {
      const s = w.schedule_id ? this.getSchedule(w.schedule_id) : undefined;
      out.push({ n: 0, kind: "watch", id: w.id, scheduleId: w.schedule_id, label: `Watch "${w.topic}" every ${w.every_hours}h`, next: s ? formatIST(new Date(s.time * 1000)) : "-" });
    }
    for (const r of sql<any>`SELECT * FROM reminders WHERE sent = 0 ORDER BY due_at`) {
      out.push({ n: 0, kind: "reminder", id: r.id, scheduleId: r.schedule_id, label: `Reminder: ${r.text}`, next: formatIST(new Date(r.due_at)) });
    }
    return out.map((j, i) => ({ ...j, n: i + 1 }));
  }

  async cancelJobN(n: number) {
    const j = this.jobsList().find((x) => x.n === n);
    if (!j) return { error: `no job number ${n}` };
    if (j.kind === "system") return { error: "built-in schedules can't be cancelled; use /pause to silence them" };
    if (j.scheduleId) await this.cancelSchedule(j.scheduleId);
    if (j.kind === "watch") this.q`DELETE FROM watches WHERE id = ${j.id!}`;
    else this.q`DELETE FROM reminders WHERE id = ${j.id!}`;
    logActivity(this.q, "job_cancel", j.label);
    return { ok: true, cancelled: j.label };
  }

  // ---------- Scheduled callbacks (see jobs.ts) ----------
  async morningBriefing(p: any) { return jobs.run(this, "morningBriefing", p, () => jobs.morning(this)); }
  async eveningWrapup(p: any) { return jobs.run(this, "eveningWrapup", p, () => jobs.evening(this)); }
  async watchCheck(p: { id: number; retry?: boolean }) { return jobs.run(this, "watchCheck", p, () => jobs.watch(this, p.id)); }
  async sendReminder(p: { id: number; retry?: boolean }) { return jobs.run(this, "sendReminder", p, () => jobs.reminder(this, p.id)); }
  async demoEnd(p: any) { return jobs.run(this, "demoEnd", p, () => jobs.demoEnd(this)); }

  /** Called by /setup. Idempotent: replaces the daily schedules. */
  async setupSchedules() { return jobs.setup(this); }

  uptime() { const s = getProfile(this.q, "started_at"); return s ? Date.now() - new Date(s).getTime() : 0; }
  budgetInfo() { const l = limits(this.env); const used = usedToday(this.q); return { ...l, used, gate: gate(used, "chat", l) }; }
}
