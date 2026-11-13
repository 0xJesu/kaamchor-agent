import type { KaamAgent } from "./agent";
import { deleteFact, getProfile, listFacts, logActivity, setProfile } from "./memory";
import { escapeHtml, sendTyping } from "./telegram";
import { formatIST, nextUtcMidnight } from "./time";
import { summary } from "./jobs";

const YES = /^(yes|y|yeah|yep|confirm|haan|ha|ok|okay)$/i;
const rep = (a: KaamAgent, html: string) => a.send(html);

export async function handleCommand(a: KaamAgent, text: string) {
  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.slice(1).split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();
  const sql = a.q;
  logActivity(sql, "command", `/${cmd}`);
  switch (cmd) {
    case "start": return start(a);
    case "help":
      return rep(a, `<b>${escapeHtml(a.cfg.AGENT_NAME)}</b> — your personal agent.\n\n<b>Commands</b>\n/memory – what I remember\n/forget &lt;n&gt; or all\n/jobs – reminders, watches, schedules\n/cancel &lt;n&gt;\n/status – today's AI allowance\n/pause /resume – proactive messages\n/summary – last 24 hours\n/reset – clear chat history\n\n<b>Just ask</b>\n• "What's the weather tomorrow?"\n• "News on Cloudflare"\n• "Remind me at 6 PM to call Rahul"\n• "Watch for news about Cloudflare and tell me if something big happens"\n• Send a link: "summarise this"\n• "I'm vegetarian" — I'll remember it`);
    case "memory": {
      const f = listFacts(sql);
      return rep(a, f.length ? `<b>What I remember</b>\n${f.map((x) => `${x.id}. ${escapeHtml(x.text)} <i>(${x.category})</i>`).join("\n")}\n\nDelete with /forget &lt;n&gt;` : "I don't remember anything about you yet. Tell me something!");
    }
    case "forget": {
      if (arg.toLowerCase() === "all") { setProfile(sql, "pending_confirm", "forget_all"); return rep(a, "Delete ALL remembered facts? Reply <b>yes</b> to confirm."); }
      const n = parseInt(arg, 10);
      if (!n) return rep(a, "Use /forget &lt;n&gt; (number from /memory) or /forget all.");
      return rep(a, deleteFact(sql, n) ? `Forgotten fact ${n}.` : `No fact number ${n}.`);
    }
    case "jobs": {
      const j = a.jobsList();
      return rep(a, j.length ? `<b>Scheduled</b>\n${j.map((x) => `${x.n}. ${escapeHtml(x.label)} — next ${x.next}`).join("\n")}\n\nCancel with /cancel &lt;n&gt;` : "Nothing scheduled.");
    }
    case "cancel": {
      const n = parseInt(arg, 10);
      if (!n) return rep(a, "Use /cancel &lt;n&gt; (number from /jobs).");
      const r: any = await a.cancelJobN(n);
      return rep(a, r.error ? escapeHtml(r.error) : `Cancelled: ${escapeHtml(r.cancelled)}`);
    }
    case "status": {
      const b = a.budgetInfo();
      const chatLeft = Math.max(0, b.limit - b.reserve - b.used), jobLeft = Math.max(0, Math.min(b.reserve, b.limit - b.margin - b.used));
      const mins = Math.round((nextUtcMidnight(new Date()).getTime() - Date.now()) / 60000);
      const up = Math.floor(a.uptime() / 36e5);
      return rep(a, `<b>Status</b>\nNeurons today: ${Math.round(b.used)} / ${b.limit}\nChat allowance left: ${Math.round(chatLeft)}\nJob reserve left: ${Math.round(jobLeft)}\nMode: ${b.gate === "ok" ? "normal" : b.gate === "resting" ? "resting (jobs only)" : "model calls blocked"}\nResets in ${Math.floor(mins / 60)}h ${mins % 60}m (5:30 AM IST)\nUp since first start: ${up}h\nProactive messages: ${getProfile(sql, "paused") === "1" ? "paused" : "on"}\nTime: ${formatIST(new Date())}`);
    }
    case "pause": setProfile(sql, "paused", "1"); return rep(a, "Paused. No briefings, wrap-ups or watch pings. Reminders still fire. /resume to undo.");
    case "resume": setProfile(sql, "paused", "0"); return rep(a, "Resumed. I'll message you again with briefings and updates.");
    case "summary": {
      await sendTyping(a.cfg.TELEGRAM_BOT_TOKEN, a.cfg.OWNER_TELEGRAM_ID);
      return rep(a, escapeHtml(await summary(a)));
    }
    case "reset": setProfile(sql, "pending_confirm", "reset"); return rep(a, "Clear our conversation history? (Your memory facts stay.) Reply <b>yes</b> to confirm.");
    default: return rep(a, "I don't know that command. Try /help.");
  }
}

/** Handles a yes/no answer to /forget all or /reset. Returns true if consumed. */
export async function handlePending(a: KaamAgent, text: string): Promise<boolean> {
  const p = getProfile(a.q, "pending_confirm");
  if (!p) return false;
  setProfile(a.q, "pending_confirm", "");
  if (text.startsWith("/")) return false;
  if (!YES.test(text)) { await rep(a, "Okay, cancelled."); return true; }
  if (p === "forget_all") { a.q`DELETE FROM facts`; logActivity(a.q, "memory", "forgot all facts"); await rep(a, "Done, I've forgotten everything I knew about you."); }
  if (p === "reset") { a.q`DELETE FROM messages`; a.q`DELETE FROM summary`; logActivity(a.q, "command", "history reset"); await rep(a, "Conversation history cleared. I still remember your facts."); }
  return true;
}

// ---- onboarding: name -> topics -> city ----
async function start(a: KaamAgent) {
  setProfile(a.q, "onboarding_step", "name");
  await rep(a, `Hi, I'm <b>${escapeHtml(a.cfg.AGENT_NAME)}</b>, your personal agent. I remember things about you, set reminders, watch the news, and message you first with a morning briefing and evening wrap-up.\n\nThree quick questions. First: <b>what should I call you?</b>`);
}

const ownFact = (a: KaamAgent, prefix: string, text: string) => {
  a.q`DELETE FROM facts WHERE text LIKE ${prefix + "%"}`;
  a.q`INSERT INTO facts (text, category, created_at) VALUES (${text}, 'other', ${new Date().toISOString()})`;
};

export async function onboardingAnswer(a: KaamAgent, text: string): Promise<boolean> {
  const step = getProfile(a.q, "onboarding_step");
  if (!step) return false;
  const v = text.slice(0, 120).trim();
  if (step === "name") {
    setProfile(a.q, "name", v); ownFact(a, "Owner's name is", `Owner's name is ${v}`);
    setProfile(a.q, "onboarding_step", "topics");
    await rep(a, `Nice to meet you, ${escapeHtml(v)}! Which <b>topics</b> should I follow for your briefing? (up to 2, e.g. "AI, cricket")`);
  } else if (step === "topics") {
    const t = v.split(/[,;&]| and /i).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(", ");
    setProfile(a.q, "topics", t); ownFact(a, "Follows news topics:", `Follows news topics: ${t}`);
    setProfile(a.q, "onboarding_step", "city");
    await rep(a, "Got it. Last one: which <b>city</b> should I use for weather?");
  } else {
    setProfile(a.q, "city", v); ownFact(a, "Lives in", `Lives in ${v}`);
    setProfile(a.q, "onboarding_step", ""); setProfile(a.q, "onboarding_done", "1");
    await rep(a, `All set! Briefing at ${a.cfg.MORNING_BRIEFING_TIME} IST and wrap-up at ${a.cfg.EVENING_WRAPUP_TIME} IST. Ask me anything, or try /help.`);
  }
  logActivity(a.q, "command", `onboarding ${step}`);
  return true;
}
