// Updates the "Project Timeline / Dev Log" section in README.md
// using the user's recent public GitHub activity (pushes, PRs, new repos).
//
// It rewrites the content between the <!-- TIMELINE:START --> and
// <!-- TIMELINE:END --> markers, keeping the surrounding README intact.

import { readFile, writeFile } from "node:fs/promises";

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN;
const README_PATH = "README.md";
const MAX_ITEMS = 40;        // max raw activity items to keep
const MAX_TIMELINE_MONTHS = 6; // months shown in the Mermaid diagram
const MAX_REPO_GROUPS = 8;     // repo blocks in the detailed list
const MAX_COMMITS_PER_REPO = 6; // commit messages shown per repo block

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

async function fetchEvents() {
  const events = [];
  // Public events are paginated; grab up to 3 pages (300 events).
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/users/${USERNAME}/events/public?per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) {
      console.error(`GitHub API error: ${res.status} ${res.statusText}`);
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    events.push(...batch);
  }
  return events;
}

// Only the first line (summary) of a commit message, trimmed and escaped.
function commitSummary(message) {
  const firstLine = (message ?? "").split("\n")[0].trim();
  return firstLine.replace(/\|/g, "\\|");
}

// Fetch the actual commit messages for a push using the compare API
// (before...head). The public events API does not include messages.
async function fetchCommitMessages(ev) {
  const repo = ev.repo?.name;
  const before = ev.payload?.before;
  const head = ev.payload?.head;
  if (!repo || !before || !head || /^0+$/.test(before)) return [];

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/compare/${before}...${head}`,
      { headers }
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.commits)) return [];
    return data.commits.map((c) => ({
      message: commitSummary(c.commit?.message),
      url: c.html_url,
      sha: (c.sha ?? "").slice(0, 7),
      date: new Date(c.commit?.author?.date ?? ev.created_at),
    }));
  } catch {
    return [];
  }
}

// Turn raw events into structured activity items (newest first).
async function buildItems(events) {
  const items = [];
  const seen = new Set();

  for (const ev of events) {
    const date = new Date(ev.created_at);
    const repo = ev.repo?.name ?? "";
    const repoShort = repo.split("/")[1] ?? repo;
    const repoUrl = `https://github.com/${repo}`;
    let item = null;

    switch (ev.type) {
      case "CreateEvent": {
        if (ev.payload?.ref_type === "repository") {
          const key = `create:${repo}`;
          if (seen.has(key)) break;
          seen.add(key);
          item = { date, repo, repoShort, repoUrl, kind: "create", commits: [] };
        }
        break;
      }
      case "PushEvent": {
        const key = `push:${repo}:${ev.payload?.head ?? date.toISOString()}`;
        if (seen.has(key)) break;
        seen.add(key);
        const commits = await fetchCommitMessages(ev);
        item = { date, repo, repoShort, repoUrl, kind: "push", commits };
        break;
      }
      case "PullRequestEvent": {
        const num = ev.payload?.pull_request?.number;
        if (ev.payload?.action === "opened") {
          const key = `pr:${repo}:${num}`;
          if (seen.has(key)) break;
          seen.add(key);
          item = { date, repo, repoShort, repoUrl, kind: "pr", num, commits: [] };
        } else if (ev.payload?.action === "closed" && ev.payload?.pull_request?.merged) {
          const key = `prmerged:${repo}:${num}`;
          if (seen.has(key)) break;
          seen.add(key);
          item = { date, repo, repoShort, repoUrl, kind: "merge", num, commits: [] };
        }
        break;
      }
      case "ReleaseEvent": {
        const tag = ev.payload?.release?.tag_name ?? "";
        const key = `release:${repo}:${tag}`;
        if (seen.has(key)) break;
        seen.add(key);
        item = { date, repo, repoShort, repoUrl, kind: "release", tag, commits: [] };
        break;
      }
      default:
        break;
    }

    if (item) items.push(item);
  }

  items.sort((a, b) => b.date - a.date);
  return items.slice(0, MAX_ITEMS);
}

const KIND_EMOJI = {
  push: "🚀",
  create: "📦",
  pr: "🔀",
  merge: "✅",
  release: "🏷️",
};

// Build a Mermaid `timeline` grouped by month, styled like the
// "Building-in-Public" diagram. Each month lists per-repo summaries.
function buildMermaid(items) {
  if (items.length === 0) return "";

  const byMonth = new Map();
  for (const it of items) {
    const k = ym(it.date);
    if (!byMonth.has(k)) byMonth.set(k, { date: it.date, repos: new Map() });
    const bucket = byMonth.get(k);
    if (!bucket.repos.has(it.repoShort)) {
      bucket.repos.set(it.repoShort, { commits: 0, kinds: new Set() });
    }
    const r = bucket.repos.get(it.repoShort);
    r.commits += it.commits.length;
    r.kinds.add(it.kind);
  }

  const months = [...byMonth.values()]
    .sort((a, b) => b.date - a.date)
    .slice(0, MAX_TIMELINE_MONTHS);

  const lines = ["```mermaid", "timeline", "    title 📊 My Coding Activity"];
  for (const month of months) {
    const summaries = [...month.repos.entries()].map(([repo, info]) => {
      const emoji = info.kinds.has("release")
        ? "🏷️"
        : info.kinds.has("merge")
        ? "✅"
        : info.kinds.has("create")
        ? "📦"
        : "🚀";
      const commitText = info.commits > 0 ? ` ${info.commits} commits` : "";
      return mermaidSafe(`${emoji} ${repo}${commitText}`);
    });
    lines.push(`    ${monthLabel(month.date)} : ${summaries.join(" : ")}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// Build a detailed list grouped by repo (newest activity first),
// listing the real commit messages under each repo.
function buildGroupedList(items) {
  if (items.length === 0) {
    return "- _No recent public activity yet. Check back soon!_";
  }

  // Group by repo, preserving newest-first order of first appearance.
  const repos = new Map();
  for (const it of items) {
    if (!repos.has(it.repo)) {
      repos.set(it.repo, {
        repo: it.repo,
        repoShort: it.repoShort,
        repoUrl: it.repoUrl,
        latest: it.date,
        commits: [],
        kinds: new Set(),
        prs: [],
        releases: [],
        created: false,
      });
    }
    const g = repos.get(it.repo);
    if (it.date > g.latest) g.latest = it.date;
    g.kinds.add(it.kind);
    if (it.kind === "push") g.commits.push(...it.commits);
    if (it.kind === "create") g.created = true;
    if (it.kind === "pr") g.prs.push({ num: it.num, merged: false });
    if (it.kind === "merge") g.prs.push({ num: it.num, merged: true });
    if (it.kind === "release") g.releases.push(it.tag);
  }

  const groups = [...repos.values()]
    .sort((a, b) => b.latest - a.latest)
    .slice(0, MAX_REPO_GROUPS);

  const blocks = [];
  for (const g of groups) {
    // De-dupe commits by sha, newest first.
    const uniqueCommits = [];
    const shaSeen = new Set();
    for (const c of g.commits.sort((a, b) => b.date - a.date)) {
      if (c.sha && shaSeen.has(c.sha)) continue;
      shaSeen.add(c.sha);
      uniqueCommits.push(c);
    }

    const badges = [];
    if (g.created) badges.push("📦 new");
    if (uniqueCommits.length > 0) {
      badges.push(`🚀 ${uniqueCommits.length} commit${uniqueCommits.length === 1 ? "" : "s"}`);
    }
    for (const tag of g.releases) badges.push(`🏷️ ${tag}`);

    const header =
      `- **[${g.repoShort}](${g.repoUrl})** — _last active ${dayLabel(g.latest)}_` +
      (badges.length ? `  ·  ${badges.join("  ·  ")}` : "");

    const lines = [header];

    for (const pr of g.prs) {
      const verb = pr.merged ? "✅ Merged" : "🔀 Opened";
      lines.push(`  - ${verb} PR [#${pr.num}](${g.repoUrl}/pull/${pr.num})`);
    }

    const shown = uniqueCommits.slice(0, MAX_COMMITS_PER_REPO);
    for (const c of shown) {
      lines.push(`  - [\`${c.sha}\`](${c.url}) ${c.message}`);
    }
    if (uniqueCommits.length > shown.length) {
      lines.push(`  - …and ${uniqueCommits.length - shown.length} more commits`);
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n");
}

async function main() {
  const events = await fetchEvents();
  const items = await buildItems(events);

  const readme = await readFile(README_PATH, "utf8");
  const startMarker = "<!-- TIMELINE:START -->";
  const endMarker = "<!-- TIMELINE:END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error("Timeline markers not found in README.md. Aborting.");
    process.exit(1);
  }

  const mermaid = buildMermaid(items);
  const list = buildGroupedList(items);
  const totalCommits = items.reduce((sum, it) => sum + it.commits.length, 0);
  const updatedAt = new Date().toISOString().slice(0, 10);

  const parts = [startMarker, ""];
  if (mermaid) parts.push(mermaid, "");
  if (totalCommits > 0) {
    parts.push(
      `> 🔥 **${totalCommits} commits** across **${new Set(items.map((i) => i.repo)).size} repos** recently.`,
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
    `<sub>⏱️ Auto-updated on ${updatedAt} from my public GitHub activity.</sub>`,
    "",
    endMarker
  );
  const newSection = parts.join("\n");

  const updated =
    readme.slice(0, startIdx) + newSection + readme.slice(endIdx + endMarker.length);

  if (updated !== readme) {
    await writeFile(README_PATH, updated, "utf8");
    console.log(`Timeline updated: ${items.length} items, ${totalCommits} commits.`);
  } else {
    console.log("No changes to the timeline.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
