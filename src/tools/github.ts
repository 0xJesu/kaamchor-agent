import { Counter } from "../counter";

// Safety model: the agent can read anything the token can see, but writes ONLY go to non-default branches
// (+ pull requests). No merge, no delete, no force-push, no default-branch commits.

export class GitHub {
  private defaults = new Map<string, string>();
  private login = "";
  constructor(private token: string, private c: Counter) {}

  private async api(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<any> {
    this.c.tick();
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${this.token}`, "user-agent": "kaam-agent", "x-github-api-version": "2022-11-28",
        accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
    return init.raw ? text : text ? JSON.parse(text) : {};
  }

  async me(): Promise<string> { return (this.login ||= (await this.api("/user")).login); }
  async repoName(r: string): Promise<string> { return r.includes("/") ? r : `${await this.me()}/${r}`; }

  async defaultBranch(repo: string): Promise<string> {
    if (!this.defaults.has(repo)) this.defaults.set(repo, (await this.api(`/repos/${repo}`)).default_branch);
    return this.defaults.get(repo)!;
  }

  async repos() {
    const r = await this.api("/user/repos?sort=pushed&per_page=15&affiliation=owner,collaborator");
    return r.map((x: any) => ({ name: x.full_name, private: x.private, description: x.description, default_branch: x.default_branch, pushed: x.pushed_at?.slice(0, 10) }));
  }

  async tree(repoIn: string, ref?: string) {
    const repo = await this.repoName(repoIn);
    const t = await this.api(`/repos/${repo}/git/trees/${encodeURIComponent(ref || (await this.defaultBranch(repo)))}?recursive=1`);
    const files = (t.tree as any[]).filter((n) => n.type === "blob" && !/(^|\/)(node_modules|\.git|dist|build|vendor|\.next)\//.test(n.path) && !/\.(png|jpe?g|gif|ico|woff2?|lock|map|pdf|zip)$/i.test(n.path));
    return { repo, total_files: files.length, files: files.slice(0, 200).map((n) => `${n.path} (${n.size}b)`), truncated: files.length > 200 };
  }

  async read(repoIn: string, path: string, ref?: string) {
    const repo = await this.repoName(repoIn);
    const text: string = await this.api(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, { raw: true });
    return { path, content: text.length > 12_000 ? text.slice(0, 12_000) + "\n…[truncated]" : text };
  }

  async search(repoIn: string, query: string) {
    const repo = await this.repoName(repoIn);
    const r = await this.api(`/search/code?q=${encodeURIComponent(`${query} repo:${repo}`)}&per_page=8`);
    return (r.items ?? []).map((i: any) => i.path);
  }

  async list(repoIn: string, kind: "issues" | "prs") {
    const repo = await this.repoName(repoIn);
    const r = await this.api(`/repos/${repo}/${kind === "prs" ? "pulls" : "issues"}?state=open&per_page=10`);
    return r.filter((x: any) => kind === "prs" || !x.pull_request).map((x: any) => ({ number: x.number, title: x.title, by: x.user?.login, url: x.html_url }));
  }

  /** Creates branch from the default branch. Idempotent if it already exists. */
  async branch(repoIn: string, name: string) {
    const repo = await this.repoName(repoIn);
    if (!/^[\w./-]{1,80}$/.test(name)) throw new Error("bad branch name");
    const base = await this.defaultBranch(repo);
    if (name === base) throw new Error("refusing: that is the default branch");
    const ref = await this.api(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    try {
      await this.api(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${name}`, sha: ref.object.sha }) });
      return { created: name, from: base };
    } catch (e) {
      if (String(e).includes("422")) return { exists: name };
      throw e;
    }
  }

  private async guard(repo: string, branch: string) {
    if (branch === (await this.defaultBranch(repo))) throw new Error(`refusing to write to default branch "${branch}"; create a feature branch first`);
  }

  /** File text + sha on a branch, or null if missing. */
  async getFile(repo: string, path: string, branch: string): Promise<{ text: string; sha: string } | null> {
    try {
      const j = await this.api(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(j) || j.encoding !== "base64") throw new Error("not a file");
      const bin = atob(j.content.replace(/\n/g, ""));
      return { text: new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))), sha: j.sha };
    } catch (e) {
      if (String(e).includes("404")) return null;
      throw e;
    }
  }

  async put(repoIn: string, path: string, content: string, branch: string, message: string, sha?: string) {
    const repo = await this.repoName(repoIn);
    await this.guard(repo, branch);
    if (sha === undefined) sha = (await this.getFile(repo, path, branch))?.sha;
    const bytes = new TextEncoder().encode(content);
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    const r = await this.api(`/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT", body: JSON.stringify({ message: message.slice(0, 200), content: btoa(bin), branch, ...(sha ? { sha } : {}) }),
    });
    return { committed: path, branch, url: r.commit?.html_url };
  }

  async pr(repoIn: string, branch: string, title: string, body: string) {
    const repo = await this.repoName(repoIn);
    await this.guard(repo, branch);
    const r = await this.api(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: title.slice(0, 200), body: body.slice(0, 4000), head: branch, base: await this.defaultBranch(repo) }) });
    return { pr: r.number, url: r.html_url };
  }
}

/** Models sometimes wrap code in fences or add prose; keep only the code. */
export function extractCode(s: string): string {
  const m = s.match(/```[\w+-]*\n([\s\S]*?)```/);
  return (m ? m[1] : s).replace(/\s+$/, "") + "\n";
}
