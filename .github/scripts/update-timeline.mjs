// Updates the "Project Timeline / Dev Log" section in README.md using the
// user's commit history, fetched per-repo via the GitHub commits API.
//
// Unlike the events API (which only exposes ~90 days / 300 events), this
// walks each repo's commits authored by the user, so it can show history
// going back as far as LOOKBACK_MONTHS.
//
// It rewrites the content between the <!-- TIMELINE:START --> and
// <!-- TIMELINE:END --> markers, keeping the surrounding README intact.

import { readFile, writeFile } from "node:fs/promises";

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN;
const README_PATH = "README.md";

// --- Tunables -------------------------------------------------------------
const LOOKBACK_MONTHS = 12;     // how far back to include commits
const MAX_TIMELINE_MONTHS = 12; // months shown in the Mermaid diagram
const MAX_REPO_GROUPS = 10;     // repo blocks in the detailed list
const MAX_COMMITS_PER_REPO = 6; // commit messages shown per repo block
const MAX_REPOS_SCANNED = 40;   // most-recently-pushed repos to scan
const EXCLUDE_FORKS = true;     // skip forked repos
// Repo names (without owner) to always skip:
const EXCLUDE_REPOS = new Set([]);
// -------------------------------------------------------------------------

if (!USERNAME) {
  console.error("GH_USERNAME env var is required.");
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${USERNAME}-timeline-bot`,
};
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function ym(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(date) {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function dayLabel(date) {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// Strip mermaid-breaking characters from a short text fragment.
function mermaidSafe(text) {
  return (text ?? "").replace(/[:#;<>"]/g, "").replace(/\s+/g, " ").trim();
}

// Only the first line (summary) of a commit message, trimmed and escaped.
function commitSummary(message) {
  const firstLine = (message ?? "").split("\n")[0].trim();
  return firstLine.replace(/\|/g, "\\|");
}

// List the user's repos, most-recently-pushed first.
async function fetchRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/users/${USERNAME}/repos?per_page=100&page=${page}&sort=pushed&type=owner`,
      { headers }
    );
    if (!res.ok) {
      console.error(`GitHub API error (repos): ${res.status} ${res.statusText}`);
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  return repos
    .filter((r) => !r.private)
    .filter((r) => !(EXCLUDE_FORKS && r.fork))
    .filter((r) => !EXCLUDE_REPOS.has(r.name))
    .slice(0, MAX_REPOS_SCANNED);
}

// Fetch commits authored by the user in a repo, since a cutoff date.
async function fetchCommitsForRepo(repo, sinceISO) {
  const commits = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      `https://api.github.com/repos/${repo.full_name}/commits` +
      `?author=${encodeURIComponent(USERNAME)}&since=${sinceISO}` +
      `&per_page=100&page=${page}`;
    let res;
    try {
      res = await fetch(url, { headers });
    } catch {
      break;
    }
    if (res.status === 409) break; // empty repository
    if (!res.ok) {
      // 404/403 etc. — skip this repo quietly.
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const c of batch) {
      commits.push({
        message: commitSummary(c.commit?.message),
        url: c.html_url,
        sha: (c.sha ?? "").slice(0, 7),
        date: new Date(c.commit?.author?.date ?? c.commit?.committer?.date),
      });
    }
    if (batch.length < 100) break;
  }
  return commits;
}

// Build per-repo groups with commit history within the lookback window.
async function buildRepoGroups() {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - LOOKBACK_MONTHS);
  const sinceISO = since.toISOString();

  const repos = await fetchRepos();
  const groups = [];

  for (const repo of repos) {
    const commits = await fetchCommitsForRepo(repo, sinceISO);
    if (commits.length === 0) continue;

    // De-dupe by sha, newest first.
    const seen = new Set();
    const unique = [];
    for (const c of commits.sort((a, b) => b.date - a.date)) {
      if (c.sha && seen.has(c.sha)) continue;
      seen.add(c.sha);
      unique.push(c);
    }

    groups.push({
      repo: repo.full_name,
      repoShort: repo.name,
      repoUrl: repo.html_url,
      latest: unique[0].date,
      commits: unique,
    });
  }

  groups.sort((a, b) => b.latest - a.latest);
  return groups;
}

// Build a Mermaid `timeline` grouped by month, styled like the
// "Building-in-Public" diagram. Each month lists per-repo commit counts.
function buildMermaid(groups) {
  if (groups.length === 0) return "";

  // month-key -> repoShort -> commit count
  const byMonth = new Map();
  for (const g of groups) {
    for (const c of g.commits) {
      const k = ym(c.date);
      if (!byMonth.has(k)) byMonth.set(k, { date: c.date, repos: new Map() });
      const bucket = byMonth.get(k);
      bucket.repos.set(g.repoShort, (bucket.repos.get(g.repoShort) ?? 0) + 1);
    }
  }

  const months = [...byMonth.values()]
    .sort((a, b) => b.date - a.date)
    .slice(0, MAX_TIMELINE_MONTHS);

  const lines = ["```mermaid", "timeline", "    title 📊 My Coding Activity"];
  for (const month of months) {
    const summaries = [...month.repos.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([repo, count]) => {
        const plural = count === 1 ? "commit" : "commits";
        return mermaidSafe(`🚀 ${repo} ${count} ${plural}`);
      });
    lines.push(`    ${monthLabel(month.date)} : ${summaries.join(" : ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// Build a detailed list grouped by repo (newest activity first),
// listing the real commit messages under each repo.
function buildGroupedList(groups) {
  if (groups.length === 0) {
    return "- _No recent public activity yet. Check back soon!_";
  }

  const shownGroups = groups.slice(0, MAX_REPO_GROUPS);
  const blocks = [];

  for (const g of shownGroups) {
    const count = g.commits.length;
    const badge = `🚀 ${count} commit${count === 1 ? "" : "s"}`;
    const header =
      `- **[${g.repoShort}](${g.repoUrl})** — _last active ${dayLabel(g.latest)}_  ·  ${badge}`;

    const lines = [header];
    const shown = g.commits.slice(0, MAX_COMMITS_PER_REPO);
    for (const c of shown) {
      lines.push(`  - [\`${c.sha}\`](${c.url}) ${c.message}`);
    }
    if (count > shown.length) {
      lines.push(`  - …and ${count - shown.length} more commits`);
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n");
}

async function main() {
  const groups = await buildRepoGroups();

  const readme = await readFile(README_PATH, "utf8");
  const startMarker = "<!-- TIMELINE:START -->";
  const endMarker = "<!-- TIMELINE:END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error("Timeline markers not found in README.md. Aborting.");
    process.exit(1);
  }

  const mermaid = buildMermaid(groups);
  const list = buildGroupedList(groups);
  const totalCommits = groups.reduce((sum, g) => sum + g.commits.length, 0);
  const updatedAt = new Date().toISOString().slice(0, 10);

  const parts = [startMarker, ""];
  if (mermaid) parts.push(mermaid, "");
  if (totalCommits > 0) {
    parts.push(
      `> 🔥 **${totalCommits} commits** across **${groups.length} repos** in the last ${LOOKBACK_MONTHS} months.`,
      ""
    );
  }
  parts.push(
    "<details open>",
    "<summary>📜 Activity by project</summary>",
    "",
    list,
    "",
    "</details>",
    "",
    `<sub>⏱️ Auto-updated on ${updatedAt} from my GitHub commit history.</sub>`,
    "",
    endMarker
  );
  const newSection = parts.join("\n");

  const updated =
    readme.slice(0, startIdx) + newSection + readme.slice(endIdx + endMarker.length);

  if (updated !== readme) {
    await writeFile(README_PATH, updated, "utf8");
    console.log(`Timeline updated: ${groups.length} repos, ${totalCommits} commits.`);
  } else {
    console.log("No changes to the timeline.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
