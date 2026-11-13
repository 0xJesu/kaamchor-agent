import { getAgentByName } from "agents";
import type { Env } from "./env";
import { safeEqual, setCommands, setWebhook } from "./telegram";
export { KaamAgent } from "./agent";

const VERSION = "1.0.0";
const stub = (env: Env): Promise<any> => (getAgentByName as any)(env.AGENT, env.OWNER_TELEGRAM_ID);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") return new Response(`ok ${VERSION}`);

    if (url.pathname === "/telegram" && req.method === "POST") {
      const hdr = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(hdr, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
      let update: any;
      try { update = await req.json(); } catch { return new Response("ok"); }
      const from = update?.message?.from?.id;
      if (String(from) !== env.OWNER_TELEGRAM_ID) {
        // Never reply to strangers; log id only (not payload).
        console.log(JSON.stringify({ type: "unauthorized", update_id: update?.update_id }));
        return new Response("ok");
      }
      // Return 200 immediately; do the work in the background so Telegram never retries.
      ctx.waitUntil((async () => {
        try { await (await stub(env)).handleUpdate(update); }
        catch (e) { console.log(JSON.stringify({ type: "error", where: "forward", error: String(e).slice(0, 200) })); }
      })());
      return new Response("ok");
    }

    if (url.pathname === "/setup" && req.method === "GET") {
      if (!safeEqual(url.searchParams.get("key") ?? "", env.TELEGRAM_WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
      try {
        await setWebhook(env.TELEGRAM_BOT_TOKEN, `${url.origin}/telegram`, env.TELEGRAM_WEBHOOK_SECRET);
        await setCommands(env.TELEGRAM_BOT_TOKEN);
        const sched = await (await stub(env)).setupSchedules();
        return new Response(`setup ok: webhook registered, commands set, schedules: ${sched}\n`);
      } catch (e) {
        return new Response(`setup failed: ${String(e).replace(env.TELEGRAM_BOT_TOKEN, "***").slice(0, 300)}\n`, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
};
