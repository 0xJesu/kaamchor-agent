import type { Sql } from "./budget";

export const MAX_FACTS = 40;
export type Fact = { id: number; text: string; category: string; created_at: string };

export function initDb(sql: Sql) {
  sql`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, created_at TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS summary (id INTEGER PRIMARY KEY, content TEXT, updated_at TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, category TEXT, created_at TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS watches (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, every_hours REAL, last_checked_at TEXT, seen_hashes TEXT, schedule_id TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, due_at TEXT, schedule_id TEXT, sent INTEGER DEFAULT 0)`;
  sql`CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, detail TEXT, neurons REAL, created_at TEXT)`;
  sql`CREATE TABLE IF NOT EXISTS usage_daily (utc_date TEXT PRIMARY KEY, neurons REAL, calls INTEGER, blocked INTEGER)`;
  sql`CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, created_at TEXT)`;
  sql`INSERT OR IGNORE INTO profile (key, value) VALUES ('schema_version', '1')`;
}

export const getProfile = (sql: Sql, key: string) => sql<{ value: string }>`SELECT value FROM profile WHERE key = ${key}`[0]?.value;
export const setProfile = (sql: Sql, key: string, value: string) =>
  void sql`INSERT INTO profile (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

// Never store secrets/IDs/cards/OTPs.
const SENSITIVE = /(\b\d(?:[ -]?\d){11,18}\b)|(\b(password|passcode|passwd|otp|cvv|pin|api[_ ]?key|secret|token)\b)|(\b[A-Z]{5}\d{4}[A-Z]\b)/i;
export const isSensitive = (s: string) => SENSITIVE.test(s);
export const mask = (s: string) =>
  s.replace(/\d(?:[ -]?\d){7,}/g, "[num]").replace(/\b(otp|password|pin|cvv)\b\s*(is|:|=)?\s*\S+/gi, "$1 [hidden]");

export const listFacts = (sql: Sql) => sql<Fact>`SELECT * FROM facts ORDER BY id`;

export function addFact(sql: Sql, text: string, category: string): { ok: boolean; msg: string } {
  text = String(text ?? "").trim().slice(0, 200);
  if (!text) return { ok: false, msg: "empty fact" };
  if (isSensitive(text)) return { ok: false, msg: "looks sensitive (password/card/ID/OTP) - not saved" };
  const cat = ["preference", "person", "plan", "other"].includes(category) ? category : "other";
  const all = listFacts(sql);
  if (all.some((f) => f.text.toLowerCase() === text.toLowerCase())) return { ok: true, msg: "already known" };
  if (all.length >= MAX_FACTS) return { ok: false, msg: `memory full (${MAX_FACTS} facts); owner must /forget something` };
  sql`INSERT INTO facts (text, category, created_at) VALUES (${text}, ${cat}, ${new Date().toISOString()})`;
  return { ok: true, msg: "saved" };
}
export const deleteFact = (sql: Sql, id: number) => {
  const had = sql`SELECT id FROM facts WHERE id = ${id}`.length > 0;
  sql`DELETE FROM facts WHERE id = ${id}`;
  return had;
};

// --- history ---
export const WINDOW = 12;
export type Msg = { role: "user" | "assistant"; content: string };
export const addMessage = (sql: Sql, role: string, content: string) =>
  void sql`INSERT INTO messages (role, content, created_at) VALUES (${role}, ${content.slice(0, 3000)}, ${new Date().toISOString()})`;
export const recentMessages = (sql: Sql): Msg[] =>
  sql<Msg>`SELECT role, content FROM messages ORDER BY id DESC LIMIT ${WINDOW}`.reverse();
export const getSummary = (sql: Sql) => sql<{ content: string }>`SELECT content FROM summary WHERE id = 1`[0]?.content ?? "";
/** Oldest 6 messages if history exceeds the window, else null. */
export function foldCandidates(sql: Sql) {
  const n = sql<{ c: number }>`SELECT COUNT(*) c FROM messages`[0].c;
  if (n <= WINDOW) return null;
  return sql<{ id: number; role: string; content: string }>`SELECT id, role, content FROM messages ORDER BY id LIMIT 6`;
}
export function applyFold(sql: Sql, ids: number[], summary: string) {
  sql`INSERT INTO summary (id, content, updated_at) VALUES (1, ${summary}, ${new Date().toISOString()})
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`;
  for (const id of ids) sql`DELETE FROM messages WHERE id = ${id}`;
}

// --- activity log ---
export const logActivity = (sql: Sql, type: string, detail: string, neurons = 0) =>
  void sql`INSERT INTO activity_log (type, detail, neurons, created_at) VALUES (${type}, ${mask(detail).slice(0, 300)}, ${neurons}, ${new Date().toISOString()})`;

export function purge(sql: Sql) {
  const d7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const h48 = new Date(Date.now() - 48 * 36e5).toISOString();
  sql`DELETE FROM activity_log WHERE created_at < ${d7}`;
  sql`DELETE FROM processed_updates WHERE created_at < ${h48}`;
}
