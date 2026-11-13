import { CapError, Counter } from "../counter";
import { formatISTDateTime } from "../time";
import { getNews } from "./news";
import { readUrl } from "./readUrl";
import { webSearch } from "./search";
import { getWeather } from "./weather";
import { extractCode, type GitHub } from "./github";

/** Implemented by the agent: everything that touches its own storage/schedules. */
export interface ToolHost {
  counter: Counter;
  /** URLs the model may read: those in the owner's message, plus any returned by search/news this turn. */
  allowedUrls: Set<string>;
  remember(fact: string, category: string): { ok: boolean; msg: string };
  forget(id: number): boolean;
  setReminder(when: string, text: string): Promise<unknown>;
  createWatch(topic: string, everyHours: number): Promise<unknown>;
  listJobs(): unknown;
  cancelJob(n: number): Promise<unknown>;
  gh: GitHub;
  /** Runs a sub-model: "think" = strong reasoner, "code" = coder model. Returns text. */
  sub(role: "think" | "code", system: string, user: string, maxTokens: number): Promise<string>;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: "function" as const, function: { name, description, parameters: { type: "object", properties, required } } });
const str = (description: string) => ({ type: "string", description });

export const TOOLS = [
  fn("web_search", "Search the web (Wikipedia + DuckDuckGo). Returns up to 5 results with snippets and URLs. Good for facts and definitions, weak for breaking news.", { query: str("search query") }, ["query"]),
  fn("get_news", "Recent news headlines (up to 5) on a topic, with source and date.", { topic: str("news topic") }, ["topic"]),
  fn("get_weather", "Current weather and today's forecast for a city.", { city: str("city name") }, ["city"]),
  fn("read_url", "Fetch a web page the owner shared (or a search result) and return its text (first ~6000 chars).", { url: str("http(s) URL") }, ["url"]),
  fn("remember", "Save a durable fact about the owner (short sentence). Never passwords, card/ID numbers, OTPs.", { fact: str("short sentence"), category: { type: "string", enum: ["preference", "person", "plan", "other"] } }, ["fact", "category"]),
  fn("forget", "Delete a stored fact by its ID.", { fact_id: { type: "integer" } }, ["fact_id"]),
  fn("set_reminder", "One-time reminder. 'when' is an ISO time in IST (2026-11-14T18:00) or relative: 'in 10 minutes', 'tomorrow 9am', 'at 6 PM'.", { when: str("when"), text: str("what to remind") }, ["when", "text"]),
  fn("create_watch", "Recurring news check on a topic. Only pings the owner when something significant is new.", { topic: str("topic"), every_hours: { type: "number", description: "hours between checks, minimum 2, default 3" } }, ["topic"]),
  fn("list_jobs", "List scheduled reminders and watches.", {}, []),
  fn("cancel_job", "Cancel a reminder or watch by its number from list_jobs.", { job_number: { type: "integer" } }, ["job_number"]),
  fn("plan", "THINK FIRST for any multi-step or coding task: produces a numbered step-by-step plan (which repo files to inspect, what to change, how to verify). Call before acting.", { goal: str("the goal"), context: str("what you already know (repo layout, constraints)") }, ["goal"]),
  fn("think", "Deep reasoning on a hard question, design choice or bug diagnosis. Returns a concise conclusion.", { question: str("the question"), context: str("relevant facts/code") }, ["question"]),
  fn("best_answer", "Polish step: critique and rewrite a draft answer into the best final reply for the owner, using the evidence gathered.", { question: str("owner's question"), draft: str("your draft answer"), evidence: str("key facts from tools") }, ["question", "draft"]),
  fn("gh_repos", "List the owner's GitHub repositories (most recently pushed first).", {}, []),
  fn("gh_tree", "List files in a repo (default branch unless ref given).", { repo: str("name or owner/name"), ref: str("branch, optional") }, ["repo"]),
  fn("gh_read", "Read one file from a repo (first 12k chars).", { repo: str("repo"), path: str("file path"), ref: str("branch, optional") }, ["repo", "path"]),
  fn("gh_search", "Search code in a repo for a keyword.", { repo: str("repo"), query: str("keyword") }, ["repo", "query"]),
  fn("gh_list", "List open issues or pull requests of a repo.", { repo: str("repo"), kind: { type: "string", enum: ["issues", "prs"] } }, ["repo", "kind"]),
  fn("gh_branch", "Create a feature branch (from the default branch). Required before any edit. Use a name like kaam/add-readme.", { repo: str("repo"), branch: str("new branch name") }, ["repo", "branch"]),
  fn("code_edit", "CODER: edit an existing file on a feature branch. A specialist coding model rewrites the file following your instruction and commits it. Give a precise, complete instruction.", { repo: str("repo"), path: str("file path"), branch: str("feature branch (not the default branch)"), instruction: str("exactly what to change"), message: str("commit message") }, ["repo", "path", "branch", "instruction"]),
  fn("code_create", "CODER: create a new file on a feature branch from a spec and commit it.", { repo: str("repo"), path: str("new file path"), branch: str("feature branch"), instruction: str("what the file must contain/do"), context: str("relevant facts/code you gathered, optional"), message: str("commit message") }, ["repo", "path", "branch", "instruction"]),
  fn("gh_pr", "Open a pull request from a feature branch into the default branch. Never merges.", { repo: str("repo"), branch: str("feature branch"), title: str("PR title"), body: str("PR description") }, ["repo", "branch", "title"]),
  fn("get_time", "Current date and time in IST.", {}, []),
];

export const TOOL_NAMES = TOOLS.map((t) => t.function.name);

export async function runTool(name: string, a: any, h: ToolHost): Promise<unknown> {
  try {
    switch (name) {
      case "web_search": {
        const hits = await webSearch(h.counter, String(a.query));
        hits.forEach((x) => x.url && h.allowedUrls.add(x.url));
        return hits.length ? hits : { note: "no results" };
      }
      case "get_news": {
        const items = await getNews(h.counter, String(a.topic));
        items.forEach((x) => x.url && h.allowedUrls.add(x.url));
        return items.map(({ title, source, date }) => ({ title, source, date }));
      }
      case "get_weather": return await getWeather(h.counter, String(a.city));
      case "read_url": {
        if (h.counter.readUrls >= 2) return { error: "read_url limit (2 per message) reached" };
        if (!h.allowedUrls.has(String(a.url))) return { error: "URL not allowed: it must come from the owner's message or a search/news result" };
        h.counter.readUrls++;
        return await readUrl(h.counter, String(a.url));
      }
      case "remember": return h.remember(a.fact, a.category);
      case "forget": return { deleted: h.forget(Number(a.fact_id)) };
      case "set_reminder": return await h.setReminder(String(a.when), String(a.text));
      case "create_watch": return await h.createWatch(String(a.topic), Number(a.every_hours) || 3);
      case "list_jobs": return h.listJobs();
      case "cancel_job": return await h.cancelJob(Number(a.job_number));
      case "plan": return await h.sub("think", "You are a staff engineer planning work for a GitHub coding agent. Tools available: gh_repos, gh_tree, gh_read, gh_search, gh_list, gh_branch, code_edit, code_create, gh_pr. Output a numbered plan of at most 8 short steps naming the tool for each step. Edits happen only on a new feature branch, then a PR. No prose beyond the plan.", `Goal: ${a.goal}
Context: ${a.context ?? ""}`, 1200);
      case "think": return await h.sub("think", "You are a careful senior engineer. Reason step by step, then give a concise conclusion (max 200 words).", `${a.question}

Context:
${a.context ?? ""}`, 1500);
      case "best_answer": return await h.sub("think", "You write the final reply to the owner. Critique the draft for accuracy against the evidence, then output ONLY the improved final reply: direct, specific, friendly, plain text, no markdown tables. Do not invent anything not in the evidence.", `Question: ${a.question}
Draft: ${a.draft}
Evidence: ${a.evidence ?? ""}`, 1200);
      case "gh_repos": return await h.gh.repos();
      case "gh_tree": return await h.gh.tree(String(a.repo), a.ref);
      case "gh_read": return await h.gh.read(String(a.repo), String(a.path), a.ref);
      case "gh_search": return await h.gh.search(String(a.repo), String(a.query));
      case "gh_list": return await h.gh.list(String(a.repo), a.kind === "prs" ? "prs" : "issues");
      case "gh_branch": return await h.gh.branch(String(a.repo), String(a.branch));
      case "gh_pr": return await h.gh.pr(String(a.repo), String(a.branch), String(a.title), String(a.body ?? ""));
      case "code_edit": {
        const repo = await h.gh.repoName(String(a.repo));
        const f = await h.gh.getFile(repo, String(a.path), String(a.branch));
        if (!f) return { error: "file not found on that branch (is the branch created? is the path right?)" };
        if (f.text.length > 20_000) return { error: "file too large for a single edit (>20k chars)" };
        const out = await h.sub("code", "You are an expert programmer. Apply the instruction to the file. Output ONLY the complete new file contents inside one fenced code block. Keep everything not related to the instruction unchanged.", `File: ${a.path}
Instruction: ${a.instruction}

--- CURRENT FILE ---
${f.text}`, 6000);
        const code = extractCode(out);
        if (code.trim().length < 5) return { error: "coder returned nothing usable" };
        return await h.gh.put(repo, String(a.path), code, String(a.branch), String(a.message || `kaam: ${String(a.instruction).slice(0, 60)}`), f.sha);
      }
      case "code_create": {
        // Give the coder real repo context so the file fits this project, not a generic template.
        const repoFull = await h.gh.repoName(String(a.repo));
        const ctx: string[] = [];
        for (const f of ["README.md", "package.json"]) {
          const got = await h.gh.getFile(repoFull, f, String(a.branch)).catch(() => null);
          if (got) ctx.push(`--- ${f} ---\n${got.text.slice(0, 4000)}`);
        }
        const out = await h.sub("code", "You are an expert programmer. Write the requested file so it fits THIS repository: use its real commands, names and structure from the context. Output ONLY the complete file contents inside one fenced code block.",
          `File: ${a.path}\nSpec: ${a.instruction}\n${a.context ? `Extra context: ${a.context}\n` : ""}\nRepository context:\n${ctx.join("\n\n") || "(none)"}`, 6000);
        const code = extractCode(out);
        if (code.trim().length < 5) return { error: "coder returned nothing usable" };
        return await h.gh.put(String(a.repo), String(a.path), code, String(a.branch), String(a.message || `kaam: add ${a.path}`));
      }
      case "get_time": return { now: formatISTDateTime(new Date()) };
      default: return { error: `unknown tool ${name}` };
    }
  } catch (e) {
    const msg = String(e);
    if (e instanceof CapError) throw e;
    console.log(JSON.stringify({ type: "tool_error", tool: name, error: msg.slice(0, 200) }));
    return { error: name.startsWith("gh_") || name.startsWith("code_") ? msg.slice(0, 250) : "source unavailable" };
  }
}
