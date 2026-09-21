// Thin wrapper around the GitHub Contents API.
// Docs: https://docs.github.com/en/rest/repos/contents

const API_ROOT = "https://api.github.com";

export class GitHubStore {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner.trim();
    this.repo = repo.trim();
    this.branch = (branch || "").trim(); // empty = let GitHub use the repo's actual default branch
    this.token = (token || "").trim();
  }

  _headers(extra = {}) {
    const h = { Accept: "application/vnd.github+json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  _path(p) {
    return `${API_ROOT}/repos/${this.owner}/${this.repo}/contents/${p}`;
  }

  /**
   * Fetch a file's raw content + sha. Returns { content, sha } or null if it
   * doesn't exist yet (404).
   */
  async getFile(path) {
    const refPart = this.branch ? `ref=${encodeURIComponent(this.branch)}&` : "";
    const res = await fetch(`${this._path(path)}?${refPart}t=${Date.now()}`, {
      headers: this._headers(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await this._err(res, `Couldn't load ${path}`);
    const json = await res.json();
    return { content: json.content, sha: json.sha, encoding: json.encoding, downloadUrl: json.download_url };
  }

  /**
   * Create or update a file. `contentB64` must be raw base64 (no data: prefix).
   */
  async putFile(path, contentB64, message, sha) {
    if (!this.token) throw new Error("A GitHub token is required to save changes.");
    const body = { message, content: contentB64 };
    if (this.branch) body.branch = this.branch;
    if (sha) body.sha = sha;
    const res = await fetch(this._path(path), {
      method: "PUT",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this._err(res, `Couldn't save ${path}`);
    return res.json();
  }

  async deleteFile(path, message, sha) {
    if (!this.token) throw new Error("A GitHub token is required to delete files.");
    const body = { message, sha };
    if (this.branch) body.branch = this.branch;
    const res = await fetch(this._path(path), {
      method: "DELETE",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 404) throw await this._err(res, `Couldn't delete ${path}`);
  }

  async _err(res, fallback) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.message || "";
    } catch (_) {}
    if (res.status === 401) return new Error("GitHub rejected the token (401). Check it's correct and not expired.");
    if (res.status === 403) return new Error("GitHub says access is forbidden (403). The token may be missing 'Contents: read/write' permission for this repo, or you've hit a rate limit.");
    if (res.status === 409) return new Error("Someone else saved changes at the same time (409). Reloading and retrying should fix it.");
    return new Error(`${fallback}: ${detail || res.status}`);
  }
}
