export interface Env {
  AI: Ai;
  AGENT: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_ID: string;
  GITHUB_TOKEN: string;
  CODER_MODEL_ID: string; THINK_MODEL_ID: string; THINKING: string;
  AGENT_NAME: string; MODEL_ID: string; FALLBACK_MODEL_ID: string; TIMEZONE: string;
  MORNING_BRIEFING_TIME: string; EVENING_WRAPUP_TIME: string; QUIET_HOURS: string;
  DAILY_NEURON_LIMIT: string; JOB_RESERVE: string; HARD_STOP_MARGIN: string;
  BUDGET_SAFETY_FACTOR: string; DEMO_END_AT: string;
}
