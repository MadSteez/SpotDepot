import { GitHubStore } from "./github.js?v=68";
import { SITE_CONFIG } from "./site-config.js?v=68";
import { utf8ToB64, b64ToUtf8, compressImage, blobToRawBase64, blobToDataUrl } from "./utils.js?v=68";

const TOKEN_KEY = "spotdepot_token";
const LOCAL_DATA_KEY = "spotdepot_local_data";
const SPOTS_PATH = "data/spots.json";

let cachedSpots = [];

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, (token || "").trim());
}

/**
 * A GitHub Pages URL already encodes the owner and repo:
 *  - project page: https://<owner>.github.io/<repo>/...
 *  - user/org page: https://<owner>.github.io/  (repo is literally "<owner>.github.io")
 * Used only as a fallback when site-config.js hasn't been filled in.
 */
export function detectRepoFromLocation() {
  try {
    const host = window.location.hostname;
    const m = host.match(/^([^.]+)\.github\.io$/i);
    if (!m) return null;
    const owner = m[1];
    const segments = window.location.pathname.split("/").filter(Boolean);
    const repo = segments.length > 0 ? segments[0] : `${owner}.github.io`;
    return { owner, repo };
  } catch (_) {
    return null;
  }
}

export function getConfig() {
  const token = getToken();
  if (SITE_CONFIG.owner && SITE_CONFIG.repo) {
    return { mode: "github", owner: SITE_CONFIG.owner, repo: SITE_CONFIG.repo, branch: SITE_CONFIG.branch || "", token };
  }
  const detected = detectRepoFromLocation();
  if (detected) {
    return { mode: "github", owner: detected.owner, repo: detected.repo, branch: "", token };
  }
  return { mode: "local" };
}

export function isGithubConfigured(cfg = getConfig()) {
  return cfg.mode === "github" && !!cfg.owner && !!cfg.repo;
}

export function canWrite(cfg = getConfig()) {
  if (cfg.mode === "local") return true;
  return isGithubConfigured(cfg) && !!cfg.token;
}

function ghFromConfig(cfg) {
  return new GitHubStore(cfg);
}

// Given "https://raw.githubusercontent.com/{owner}/{repo}/{branch}/images/x.jpg",
// returns "images/x.jpg" — without needing to know the branch name up front,
// since whatever the first path segment is after owner/repo, that's it.
function pathFromRawUrl(url, owner, repo) {
  const prefix = `https://raw.githubusercontent.com/${owner}/${repo}/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const slashIdx = rest.indexOf("/");
  return slashIdx === -1 ? null : rest.slice(slashIdx + 1);
}

async function deleteRepoFile(gh, url, owner, repo, message) {
  const path = pathFromRawUrl(url, owner, repo);
  if (!path) return;
  try {
    const f = await gh.getFile(path);
    if (f) await gh.deleteFile(path, message, f.sha);
  } catch (err) {
    // Best effort only — a missing/already-gone file shouldn't block anything
    // the user is actually doing, but leave a trace for anyone debugging.
    console.error(`Couldn't delete ${path}:`, err);
  }
}

/**
 * Photos added before this fix got a raw.githubusercontent.com URL with an
 * empty branch segment (a literal "//"), which 404s. This finds any of
 * those, asks GitHub for that file's real URL, and fixes it in place — and
 * if this device can write, saves the fix back so nobody else has to.
 */
async function repairBrokenImageUrls(spots, cfg) {
  const brokenPrefix = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}//`;
  const brokenPaths = new Set();
  spots.forEach((s) => (s.images || []).forEach((u) => {
    if (u.startsWith(brokenPrefix)) brokenPaths.add(u.slice(brokenPrefix.length));
  }));
  if (brokenPaths.size === 0) return { spots, changed: false };

  const gh = ghFromConfig(cfg);
  const fixMap = new Map(); // broken url -> fixed url
  for (const path of brokenPaths) {
    try {
      const file = await gh.getFile(path);
      if (file && file.downloadUrl) fixMap.set(brokenPrefix + path, file.downloadUrl);
    } catch (_) {
      /* leave this one broken if we can't resolve it */
    }
  }
  if (fixMap.size === 0) return { spots, changed: false };

  const fixed = spots.map((s) => ({
    ...s,
    images: (s.images || []).map((u) => fixMap.get(u) || u),
  }));
  return { spots: fixed, changed: true };
}

/** Load the current spot list from wherever it lives. */
export async function loadSpots() {
  const cfg = getConfig();
  if (cfg.mode === "github") {
    if (!isGithubConfigured(cfg)) {
      cachedSpots = [];
      return { spots: [], needsSetup: true };
    }
    const gh = ghFromConfig(cfg);
    const file = await gh.getFile(SPOTS_PATH);
    const parsed = file ? JSON.parse(b64ToUtf8(file.content)) : [];
    const { spots: repaired, changed } = await repairBrokenImageUrls(parsed, cfg);
    cachedSpots = repaired;
    if (changed && cfg.token) {
      persist(repaired, "Fix broken image URLs (missing branch)").catch(() => {});
    }
    return { spots: cachedSpots, needsSetup: false };
  }
  const raw = localStorage.getItem(LOCAL_DATA_KEY);
  cachedSpots = raw ? JSON.parse(raw) : [];
  return { spots: cachedSpots, needsSetup: false };
}

async function persist(spotsArray, message) {
  const cfg = getConfig();
  if (cfg.mode === "github") {
    const gh = ghFromConfig(cfg);
    const latest = await gh.getFile(SPOTS_PATH); // refetch right before writing to minimize clobbering concurrent edits
    const sha = latest ? latest.sha : undefined;
    const contentB64 = utf8ToB64(JSON.stringify(spotsArray, null, 2));
    await gh.putFile(SPOTS_PATH, contentB64, message, sha);
  } else {
    localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(spotsArray));
  }
  cachedSpots = spotsArray;
}

async function uploadImages(files, spotId, onProgress) {
  const cfg = getConfig();
  const urls = [];
  for (let i = 0; i < files.length; i++) {
    if (onProgress) onProgress(i + 1, files.length);
    const blob = await compressImage(files[i]);
    if (cfg.mode === "github") {
      const gh = ghFromConfig(cfg);
      const b64 = await blobToRawBase64(blob);
      const filename = `images/${spotId}-${Date.now()}-${i}.jpg`;
      const result = await gh.putFile(filename, b64, `Add photo for spot ${spotId}`);
      urls.push(result.content.download_url);
    } else {
      urls.push(await blobToDataUrl(blob));
    }
  }
  return urls;
}

/**
 * Create or update a spot.
 * @param {object} spotData - full spot object (id, name, description, lat, lng, tags, images[])
 * @param {File[]} newFiles - newly chosen image files to upload
 * @param {string[]} keepImageUrls - existing image URLs the user kept (others are treated as removed)
 */
export async function saveSpot(spotData, newFiles = [], keepImageUrls = null, onProgress) {
  const cfgCheck = getConfig();
  if (cfgCheck.mode === "github" && !isGithubConfigured(cfgCheck)) {
    throw new Error("Set the repo owner and name in Setup & sync first.");
  }
  const { spots } = await loadSpots();
  const existing = spots.find((s) => s.id === spotData.id);
  const kept = keepImageUrls ?? (existing ? existing.images : []);
  const uploaded = newFiles.length ? await uploadImages(newFiles, spotData.id, onProgress) : [];
  const finalSpot = {
    ...spotData,
    images: [...kept, ...uploaded],
    updatedAt: new Date().toISOString(),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
  const idx = spots.findIndex((s) => s.id === spotData.id);
  const next = idx >= 0 ? spots.map((s, i) => (i === idx ? finalSpot : s)) : [...spots, finalSpot];
  await persist(next, `${idx >= 0 ? "Update" : "Add"} spot: ${finalSpot.name}`);

  const cfg = getConfig();
  if (cfg.mode === "github" && existing) {
    const removed = (existing.images || []).filter((u) => !kept.includes(u));
    if (removed.length) {
      const gh = ghFromConfig(cfg);
      // GitHub's Contents API requires these run one at a time — every write
      // creates a new commit on the branch, so parallel requests (even to
      // different files) race to update the same ref and all but one fail.
      for (const url of removed) {
        await deleteRepoFile(gh, url, cfg.owner, cfg.repo, `Delete photo for spot ${finalSpot.name}`);
      }
    }
  }

  return finalSpot;
}

export async function deleteSpot(id) {
  const cfgCheck = getConfig();
  if (cfgCheck.mode === "github" && !isGithubConfigured(cfgCheck)) {
    throw new Error("Set the repo owner and name in Setup & sync first.");
  }
  const { spots } = await loadSpots();
  const spot = spots.find((s) => s.id === id);
  const remaining = spots.filter((s) => s.id !== id);
  await persist(remaining, `Delete spot: ${spot ? spot.name : id}`);

  const cfg = getConfig();
  if (cfg.mode === "github" && spot && spot.images && spot.images.length) {
    const gh = ghFromConfig(cfg);
    // Same reason as saveSpot's cleanup above — must be serial, not parallel.
    for (const url of spot.images) {
      await deleteRepoFile(gh, url, cfg.owner, cfg.repo, `Delete photo for spot ${spot.name}`);
    }
  }
  return remaining;
}
