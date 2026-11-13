// Usage: npx wrangler login, then:  npx tsx scripts/eval-tools.ts [modelId]
// Runs 10 fixed prompts against a model (real Workers AI, uses a few hundred Neurons) and checks tool choice + args.
import { getPlatformProxy } from "wrangler";
import { TOOLS } from "../src/tools/index.ts";
import { parseResult } from "../src/llm.ts";

const model = process.argv[2] ?? "@cf/qwen/qwen3-30b-a3b-fp8";
const CASES: { q: string; tool: string | null; check?: (a: any) => boolean }[] = [
  { q: "What's the weather in Guwahati?", tool: "get_weather", check: (a) => /guwahati/i.test(a.city) },
  { q: "Any news on Cloudflare today?", tool: "get_news", check: (a) => /cloudflare/i.test(a.topic) },
  { q: "Remind me in 10 minutes to call Rahul", tool: "set_reminder", check: (a) => /10/.test(a.when) && /rahul/i.test(a.text) },
  { q: "I'm vegetarian and I hate morning meetings", tool: "remember", check: (a) => /vegetarian|meeting/i.test(a.fact) },
  { q: "Watch for news about OpenAI and tell me if something big happens", tool: "create_watch", check: (a) => /openai/i.test(a.topic) },
  { q: "What jobs and reminders do I have scheduled?", tool: "list_jobs" },
  { q: "Cancel job number 2", tool: "cancel_job", check: (a) => Number(a.job_number) === 2 },
  { q: "What time is it right now?", tool: "get_time" },
  { q: "Who is the current CEO of Cloudflare? Look it up.", tool: "web_search", check: (a) => /cloudflare/i.test(a.query) },
  { q: "Thanks, that's all!", tool: null },
];
const system = "You are a personal assistant. Use tools for anything current or when asked to remember, remind, watch or list. Reply briefly otherwise. /no_think";

const { env, dispose } = await getPlatformProxy<{ AI: any }>({ remoteBindings: true } as any);
let pass = 0;
for (const c of CASES) {
  try {
    const r = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: c.q }], tools: TOOLS, max_tokens: 300, chat_template_kwargs: { enable_thinking: false } });
    const f = parseResult(r).calls[0]; const args = f?.args ?? {};
    const ok = c.tool === null ? !f : f?.name === c.tool && args !== null && (c.check?.(args) ?? true);
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.q}  -> ${f ? `${f.name}(${JSON.stringify(args)})` : "text"}  tokens=${JSON.stringify(r?.usage ?? {})}`);
  } catch (e) { console.log(`ERROR ${c.q}: ${String(e).slice(0, 200)}`); }
}
console.log(`\n${model}: ${pass}/${CASES.length} correct`);
await dispose();
