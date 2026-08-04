#!/usr/bin/env node

// Build the GitHub Wiki's flat page repository from the canonical docs in this
// repository. GitHub Wikis do not preserve docs/contributions/ directories, so
// local links are rewritten to Wiki page names while source links point back to
// main. The output is disposable; contributors edit docs/, never .wiki-dist/.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, ".wiki-dist");
const REPO = "https://github.com/FluidWorksApp/canopy-ide";

const pages = [
  ["docs/architecture.md", "Architecture.md"],
  ["docs/architecture-llm.md", "Architecture-LLM-Context.md"],
  ["docs/contributor-integrations.md", "Contributor-Integration-Guide.md"],
  ["docs/core-rust-system.md", "Core-Rust-System.md"],
  ["docs/testing-and-coverage.md", "Testing-and-Coverage.md"],
  ["docs/wiki-publishing.md", "Publishing-the-GitHub-Wiki.md"],
  ["docs/contributions/README.md", "Contribution-Playbooks.md"],
  ["docs/contributions/theme.md", "Contributing-a-Theme.md"],
  ["docs/contributions/component.md", "Contributing-a-Component.md"],
  ["docs/contributions/desktop-feature.md", "Contributing-a-Desktop-Feature.md"],
  ["docs/contributions/project-surface.md", "Contributing-a-Project-Surface.md"],
  ["docs/contributions/native-capability.md", "Contributing-a-Native-Capability.md"],
  ["docs/contributions/agent-tool.md", "Contributing-an-Agent-Tool.md"],
  ["docs/contributions/search-source.md", "Contributing-a-Search-Source.md"],
  ["docs/contributions/tracker.md", "Contributing-a-Tracker.md"],
  ["docs/contributions/agent-cli.md", "Contributing-an-Agent-CLI.md"],
  ["docs/contributions/micro-task.md", "Contributing-a-Micro-task.md"],
  ["docs/contributions/durable-store.md", "Contributing-a-Durable-Store.md"],
  ["docs/contributions/remote-feature.md", "Contributing-a-Remote-Feature.md"],
  ["docs/contributions/file-viewer.md", "Contributing-a-File-Viewer.md"],
  ["docs/contributions/shortcut.md", "Contributing-a-Shortcut.md"],
  ["docs/contributions/relay-message.md", "Contributing-a-Relay-Message.md"],
];

const targetBySource = new Map(
  pages.map(([source, target]) => [resolve(ROOT, source), target.replace(/\.md$/, "")]),
);
const wikiTargets = new Set(pages.map(([, target]) => target.replace(/\.md$/, "")));

function sourceUrl(source) {
  return `${REPO}/blob/main/${source}`;
}

function rewriteLinks(markdown, source) {
  const sourceDir = dirname(resolve(ROOT, source));
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, href) => {
    if (/^(?:https?:|mailto:|#)/.test(href)) return whole;
    const [pathPart, anchor] = href.split("#", 2);
    const absolute = resolve(sourceDir, pathPart);
    const wikiTarget = targetBySource.get(absolute);
    if (wikiTarget) return `[${label}](${wikiTarget}${anchor ? `#${anchor}` : ""})`;

    const repoPath = relative(ROOT, absolute).replaceAll("\\", "/");
    if (repoPath.startsWith("../")) {
      throw new Error(`${source}: link escapes the repository: ${href}`);
    }
    return `[${label}](${REPO}/blob/main/${repoPath}${anchor ? `#${anchor}` : ""})`;
  });
}

function validatePage(markdown, source) {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  if (fences % 2 !== 0) throw new Error(`${source}: unclosed code fence`);
  if (!markdown.startsWith("# ")) throw new Error(`${source}: page needs one H1 title`);
}

const home = `# Canopy Architecture Wiki

Canopy is a local-first Tauri desktop IDE built around coding agents. This Wiki
maps the system and shows contributors how to extend existing infrastructure
without creating parallel stores, sockets, event buses, or components.

## Start here

- [Architecture](Architecture) - system boundaries, structure, and runtime flows
- [Core Rust System](Core-Rust-System) - native services, ownership, security, and lifecycle
- [Contributor Integration Guide](Contributor-Integration-Guide) - bus and registry selection
- [Contribution Playbooks](Contribution-Playbooks) - one implementation recipe per contribution type
- [Architecture: LLM Context](Architecture-LLM-Context) - compact context for coding agents
- [Testing and Coverage](Testing-and-Coverage) - test layers, CI, and measured coverage scope
- [Publishing the GitHub Wiki](Publishing-the-GitHub-Wiki) - build and synchronization workflow

## Contribution playbooks

${pages
  .filter(([source]) => source.startsWith("docs/contributions/") && !source.endsWith("README.md"))
  .map(([source, target]) => {
    const title = target.replace(/\.md$/, "").replaceAll("-", " ");
    return `- [${title}](${target.replace(/\.md$/, "")})`;
  })
  .join("\n")}

> These pages are generated from the repository's canonical Markdown. Edit the
> linked source files through a pull request, then rebuild and publish the Wiki.
`;

const sidebar = `**Canopy Architecture**

- [Home](Home)
- [Architecture](Architecture)
- [Core Rust System](Core-Rust-System)
- [LLM Context](Architecture-LLM-Context)
- [Integration Guide](Contributor-Integration-Guide)
- [Contribution Playbooks](Contribution-Playbooks)
- [Testing and Coverage](Testing-and-Coverage)
- [Publish the Wiki](Publishing-the-GitHub-Wiki)

**Playbooks**

${pages
  .filter(([source]) => source.startsWith("docs/contributions/") && !source.endsWith("README.md"))
  .map(([, target]) => {
    const page = target.replace(/\.md$/, "");
    const label = page.replace(/^Contributing-(?:a|an)-/, "").replaceAll("-", " ");
    return `- [${label}](${page})`;
  })
  .join("\n")}
`;

const footer = `Generated from [FluidWorksApp/canopy-ide](${REPO}). Canonical documentation changes belong in the main repository.`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const [source, target] of pages) {
  const original = await readFile(resolve(ROOT, source), "utf8");
  validatePage(original, source);
  const notice = `> Generated from [\`${source}\`](${sourceUrl(source)}). Edit the canonical source through a pull request.\n\n`;
  await writeFile(resolve(OUT, target), rewriteLinks(original, source).replace(/^(# [^\n]+\n)/, `$1\n${notice}`));
}

await writeFile(resolve(OUT, "Home.md"), home);
await writeFile(resolve(OUT, "_Sidebar.md"), sidebar);
await writeFile(resolve(OUT, "_Footer.md"), footer);

for (const file of [home, sidebar]) {
  for (const match of file.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (target !== "Home" && !wikiTargets.has(target)) {
      throw new Error(`generated navigation links to unknown Wiki page: ${target}`);
    }
  }
}

console.log(`Built ${pages.length + 3} Wiki files in ${relative(ROOT, OUT)}/`);
