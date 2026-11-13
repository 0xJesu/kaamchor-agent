import { describe, expect, it, vi } from "vitest";

// Stub the Agents SDK so the Worker entry can load in plain Node.
const handle = vi.fn();
vi.mock("agents", () => ({ Agent: class {}, getAgentByName: async () => ({ handleUpdate: handle }) }));
vi.mock("../src/agent", () => ({ KaamAgent: class {} }));

const { default: worker } = await import("../src/index");
const env: any = { TELEGRAM_WEBHOOK_SECRET: "s".repeat(32), OWNER_TELEGRAM_ID: "42", TELEGRAM_BOT_TOKEN: "t", AGENT: {} };
const ctx: any = { waitUntil: (p: Promise<unknown>) => void p };
const post = (body: unknown, secret?: string) =>
  worker.fetch(new Request("https://x.dev/telegram", { method: "POST", headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {}, body: JSON.stringify(body) }), env, ctx);
const msg = (id: number) => ({ update_id: 1, message: { from: { id }, chat: { id }, text: "hi" } });

describe("worker routes", () => {
  it("A3: forged webhook (no / wrong secret) -> 401, nothing forwarded", async () => {
    expect((await post(msg(42))).status).toBe(401);
    expect((await post(msg(42), "wrong")).status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });
  it("A2: non-owner -> 200 but never forwarded", async () => {
    expect((await post(msg(999), env.TELEGRAM_WEBHOOK_SECRET)).status).toBe(200);
    expect(handle).not.toHaveBeenCalled();
  });
  it("owner update -> 200 and forwarded once", async () => {
    expect((await post(msg(42), env.TELEGRAM_WEBHOOK_SECRET)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it("/setup needs key; unknown paths 404; /health ok", async () => {
    expect((await worker.fetch(new Request("https://x.dev/setup?key=nope"), env, ctx)).status).toBe(401);
    expect((await worker.fetch(new Request("https://x.dev/other"), env, ctx)).status).toBe(404);
    expect(await (await worker.fetch(new Request("https://x.dev/health"), env, ctx)).text()).toMatch(/^ok/);
  });
});
