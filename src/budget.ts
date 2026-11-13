import { neuronCost } from "./models";
import { utcDate } from "./time";
import type { Env } from "./env";

export type Sql = <T = Record<string, any>>(s: TemplateStringsArray, ...v: (string | number | boolean | null)[]) => T[];
export type Gate = "ok" | "resting" | "blocked";

export const limits = (env: Env) => ({
  limit: +env.DAILY_NEURON_LIMIT, reserve: +env.JOB_RESERVE, margin: +env.HARD_STOP_MARGIN,
  factor: +env.BUDGET_SAFETY_FACTOR || 1.2,
});

export function usedToday(sql: Sql): number {
  return sql<{ neurons: number }>`SELECT neurons FROM usage_daily WHERE utc_date = ${utcDate()}`[0]?.neurons ?? 0;
}

/** Pure threshold logic (unit-tested). kind=job may use the reserve. */
export function gate(used: number, kind: "chat" | "job", l: { limit: number; reserve: number; margin: number }, limitFlag = false): Gate {
  if (limitFlag || used >= l.limit - l.margin) return "blocked";
  if (kind === "chat" && used >= l.limit - l.reserve) return "resting";
  return "ok";
}

export function checkBudget(sql: Sql, env: Env, kind: "chat" | "job"): Gate {
  const flag = sql<{ value: string }>`SELECT value FROM profile WHERE key = 'ai_limit_date'`[0]?.value === utcDate();
  return gate(usedToday(sql), kind, limits(env), flag);
}

export function setLimitFlag(sql: Sql) {
  sql`INSERT INTO profile (key, value) VALUES ('ai_limit_date', ${utcDate()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
}

/** Records usage; returns neurons charged. Falls back to chars/4 if usage is missing. */
export function recordUsage(sql: Sql, env: Env, model: string, usage: any, promptChars: number, outChars: number): number {
  const inTok = usage?.prompt_tokens ?? Math.ceil(promptChars / 4);
  const outTok = usage?.completion_tokens ?? Math.ceil(outChars / 4);
  const n = neuronCost(model, inTok, outTok, limits(env).factor);
  const d = utcDate();
  sql`INSERT INTO usage_daily (utc_date, neurons, calls, blocked) VALUES (${d}, ${n}, 1, 0)
      ON CONFLICT(utc_date) DO UPDATE SET neurons = neurons + ${n}, calls = calls + 1`;
  return n;
}
