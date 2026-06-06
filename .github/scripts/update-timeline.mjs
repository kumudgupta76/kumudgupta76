// Updates the "Project Timeline / Dev Log" section in README.md
// using the user's recent public GitHub activity (pushes, PRs, new repos).
//
// It rewrites the content between the <!-- TIMELINE:START --> and
// <!-- TIMELINE:END --> markers, keeping the surrounding README intact.

import { readFile, writeFile } from "node:fs/promises";

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN;
const README_PATH = "README.md";
const MAX_ENTRIES = 15;

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

function buildEntries(events) {
  const entries = [];
  const seen = new Set();

  for (const ev of events) {
    const date = new Date(ev.created_at);
    const repo = ev.repo?.name ?? "";
    const repoUrl = `https://github.com/${repo}`;
    let line = null;
    let key = null;

    switch (ev.type) {
      case "CreateEvent": {
        if (ev.payload?.ref_type === "repository") {
          key = `create:${repo}`;
          line = `📦 Created new repo **[${repo}](${repoUrl})**`;
        }
        break;
      }
      case "PushEvent": {
        const count = ev.payload?.commits?.length ?? 0;
        if (count > 0) {
          // One entry per repo per day to avoid noise.
          key = `push:${repo}:${ym(date)}-${date.getUTCDate()}`;
          const plural = count === 1 ? "commit" : "commits";
          line = `🚀 Pushed ${count} ${plural} to **[${repo}](${repoUrl})**`;
        }
        break;
      }
      case "PullRequestEvent": {
        if (ev.payload?.action === "opened") {
          const num = ev.payload?.pull_request?.number;
          key = `pr:${repo}:${num}`;
          line = `🔀 Opened PR [#${num}](${repoUrl}/pull/${num}) in **[${repo}](${repoUrl})**`;
        } else if (ev.payload?.action === "closed" && ev.payload?.pull_request?.merged) {
          const num = ev.payload?.pull_request?.number;
          key = `prmerged:${repo}:${num}`;
          line = `✅ Merged PR [#${num}](${repoUrl}/pull/${num}) in **[${repo}](${repoUrl})**`;
        }
        break;
      }
      case "ReleaseEvent": {
        const tag = ev.payload?.release?.tag_name ?? "";
        key = `release:${repo}:${tag}`;
        line = `🏷️ Released **${tag}** of **[${repo}](${repoUrl})**`;
        break;
      }
      default:
        break;
    }

    if (line && key && !seen.has(key)) {
      seen.add(key);
      const label = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
      entries.push({ date, text: `- **\`${label}\`** — ${line}.` });
    }
  }

  entries.sort((a, b) => b.date - a.date);
  return entries.slice(0, MAX_ENTRIES);
}

async function main() {
  const events = await fetchEvents();
  const entries = buildEntries(events);

  const readme = await readFile(README_PATH, "utf8");
  const startMarker = "<!-- TIMELINE:START -->";
  const endMarker = "<!-- TIMELINE:END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error("Timeline markers not found in README.md. Aborting.");
    process.exit(1);
  }

  const body =
    entries.length > 0
      ? entries.map((e) => e.text).join("\n")
      : "- _No recent public activity yet. Check back soon!_";

  const updatedAt = new Date().toISOString().slice(0, 10);
  const newSection =
    `${startMarker}\n\n${body}\n\n` +
    `<sub>⏱️ Auto-updated on ${updatedAt} from my public GitHub activity.</sub>\n\n` +
    `${endMarker}`;

  const updated =
    readme.slice(0, startIdx) + newSection + readme.slice(endIdx + endMarker.length);

  if (updated !== readme) {
    await writeFile(README_PATH, updated, "utf8");
    console.log(`Timeline updated with ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`);
  } else {
    console.log("No changes to the timeline.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
