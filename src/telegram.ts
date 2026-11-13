const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Split on paragraph/line/space boundaries, each chunk <= max chars. */
export function splitMessage(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf("\n\n", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let d = a.length ^ b.length;
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(token: string, method: string, body: unknown, tick?: () => void): Promise<any> {
  const delays = [1000, 3000];
  for (let i = 0; ; i++) {
    tick?.();
    let retryable = true;
    try {
      const res = await fetch(API(token, method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j: any = await res.json().catch(() => ({}));
      if (j.ok) return j;
      if (res.status === 429 && i < 2) { await sleep(Math.min((j.parameters?.retry_after ?? 1) * 1000, 10_000)); continue; }
      if (res.status >= 400 && res.status < 500) { retryable = false; throw new Error(`telegram ${method} ${res.status}: ${j.description}`); }
      throw new Error(`telegram ${method} failed ${res.status}`);
    } catch (e) {
      if (!retryable || i >= 2) throw e;
    }
    await sleep(delays[i]);
  }
}

/** Sends HTML text (caller escapes untrusted text). Splits long messages. */
export async function sendMessage(token: string, chatId: string | number, html: string, tick?: () => void) {
  for (const part of splitMessage(html)) {
    await call(token, "sendMessage", { chat_id: chatId, text: part, parse_mode: "HTML", disable_web_page_preview: true }, tick);
  }
}
export const sendTyping = (token: string, chatId: string | number, tick?: () => void) =>
  call(token, "sendChatAction", { chat_id: chatId, action: "typing" }, tick).catch(() => {});

export const setWebhook = (token: string, url: string, secret: string) =>
  call(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });

export const COMMANDS = [
  ["start", "Introduce yourself / onboarding"], ["help", "What I can do"], ["memory", "What I remember about you"],
  ["forget", "Forget a fact: /forget <n> or all"], ["jobs", "Reminders, watches, schedules"], ["cancel", "Cancel a job: /cancel <n>"],
  ["status", "Today's AI allowance and uptime"], ["pause", "Pause proactive messages"], ["resume", "Resume proactive messages"],
  ["summary", "What I did in the last 24 hours"], ["reset", "Clear conversation history"],
] as const;
export const setCommands = (token: string) =>
  call(token, "setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
