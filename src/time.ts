// IST = UTC+5:30, no DST, so a fixed offset is exact.
const OFF = 330 * 60_000;
export const toIST = (d: Date) => new Date(d.getTime() + OFF); // read with getUTC* fields
export const pad = (n: number) => String(n).padStart(2, "0");

export function formatIST(d: Date): string {
  const t = toIST(d);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][t.getUTCMonth()];
  let h = t.getUTCHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${t.getUTCDate()} ${mon}, ${h}:${pad(t.getUTCMinutes())} ${ap} IST`;
}
export const formatISTDateTime = (d: Date) =>
  `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][toIST(d).getUTCDay()]} ${formatIST(d)}`;
export const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);
/** Start of the current IST day as a real instant. */
export const istMidnight = (d: Date) => {
  const t = toIST(d); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - OFF);
};
/** Next 00:00 UTC (Workers AI reset). */
export const nextUtcMidnight = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

/** "08:00" IST -> UTC cron "30 2 * * *" */
export function istToCron(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const mins = (((h * 60 + m - 330) % 1440) + 1440) % 1440;
  return `${mins % 60} ${Math.floor(mins / 60)} * * *`;
}

export function inQuietHours(d: Date, range: string): boolean {
  const [a, b] = range.split("-").map((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); });
  const t = toIST(d); const now = t.getUTCHours() * 60 + t.getUTCMinutes();
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

const UNITS: Record<string, number> = { s: 1e3, sec: 1e3, second: 1e3, m: 6e4, min: 6e4, minute: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5 };
function clock(s: string): { h: number; m: number } | null {
  const r = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!r) return null;
  let h = +r[1]; const m = r[2] ? +r[2] : 0; const ap = r[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  if (h > 23 || m > 59) return null;
  return { h, m };
}
/** Parses ISO ("2026-11-14T18:00" = IST unless it has a zone), "in 10 minutes", "tomorrow 9am", "at 6 PM". Returns null if unparseable. */
export function parseWhen(input: string, now = new Date()): Date | null {
  const s = input.trim().toLowerCase();
  const rel = s.match(/^in\s+(\d+(?:\.\d+)?)\s*([a-z]+?)s?$/);
  if (rel && UNITS[rel[2]]) return new Date(now.getTime() + +rel[1] * UNITS[rel[2]]);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const hasZone = /(z|[+-]\d{2}:?\d{2})$/.test(s);
    const d = new Date(hasZone ? input : input.trim() + (s.length <= 10 ? "T09:00:00+05:30" : "+05:30"));
    return isNaN(+d) ? null : d;
  }
  const tm = s.match(/^(today|tomorrow)?\s*(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
  if (tm) {
    const c = clock(tm[2]); if (!c) return null;
    const t = toIST(now);
    let d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), c.h, c.m) - OFF);
    if (tm[1] === "tomorrow") d = new Date(d.getTime() + 864e5);
    else if (d <= now && tm[1] !== "today") d = new Date(d.getTime() + 864e5); // "at 6 PM" already passed -> tomorrow
    return d;
  }
  return null;
}
