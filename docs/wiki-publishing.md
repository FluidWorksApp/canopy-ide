# Publishing the GitHub Wiki

GitHub stores a Wiki in a separate Git repository named
`FluidWorksApp/canopy-ide.wiki.git`. The canonical architecture documentation
remains under `docs/` in the main repository so it can be reviewed with the code
that it describes.

`scripts/build-wiki.mjs` converts the canonical documentation into the Wiki's
flat page layout. It generates page-safe names, rewrites internal links, and
adds `Home.md`, `_Sidebar.md`, and `_Footer.md`.

## 1. Enable and initialize the Wiki

The Wiki remote does not exist yet. A repository administrator must:

1. Open `https://github.com/FluidWorksApp/canopy-ide/settings`.
2. Under **Features**, enable **Wikis**.
3. Open the repository's **Wiki** tab.
4. Create and save the first page.

Creating the first page initializes the separate Wiki Git repository. Until
then, cloning `canopy-ide.wiki.git` returns “Repository not found.”

## 2. Build the Wiki bundle

From the main repository:

```sh
npm run wiki:build
```

The command creates `.wiki-dist/`, which is ignored by Git. It contains:

```text
Home.md
_Sidebar.md
_Footer.md
Architecture.md
Architecture-LLM-Context.md
Core-Rust-System.md
Contributor-Integration-Guide.md
Contribution-Playbooks.md
Contributing-a-Theme.md
...one page for every contribution playbook
```

Do not edit `.wiki-dist/`. Edit the canonical file under `docs/`, rebuild, and
publish again.

## 3. Preview the generated pages

Inspect `.wiki-dist/Home.md` and `_Sidebar.md`, then confirm the bundle contains
the expected pages:

```sh
git status --short
npm run wiki:build
```

The build fails on unclosed code fences, missing page titles, repository-escaping
links, or generated navigation pointing to an unknown page.

## 4. Publish manually

Clone the Wiki repository outside the main checkout, synchronize the generated
bundle, inspect it, then push:

```sh
WIKI_DIR="$(mktemp -d)/canopy-ide.wiki"
git clone "https://github.com/FluidWorksApp/canopy-ide.wiki.git" "$WIKI_DIR"
rsync -a --delete --exclude ".git/" ".wiki-dist/" "$WIKI_DIR/"
git -C "$WIKI_DIR" add -A
git -C "$WIKI_DIR" diff --cached
git -C "$WIKI_DIR" commit -m "Sync architecture documentation"
git -C "$WIKI_DIR" push origin HEAD
```

The `--delete` flag removes Wiki pages that were generated previously but have
since been removed from the canonical page map. It does not touch the Wiki's
`.git` directory.

## 5. Update the Wiki later

When architecture or contribution documentation changes:

1. Merge the documentation pull request into `main`.
2. Pull the latest `main` locally.
3. Run `npm run wiki:build`.
4. Clone or update the Wiki repository.
5. Synchronize `.wiki-dist/` into it.
6. Review the Wiki diff.
7. Commit and push the Wiki repository.

The main repository is authoritative. Direct Wiki edits will be overwritten by
the next synchronization and should be copied back into `docs/` through a pull
request first.

## 6. Adding another Wiki page

1. Add the canonical Markdown file under `docs/`.
2. Add its source and flat target filename to `pages` in
   `scripts/build-wiki.mjs`.
3. Link it from the generated Home or sidebar when it is a primary page.
4. Run `npm run wiki:build`.
5. Open the generated page and verify rewritten links and Mermaid diagrams.
6. Include the canonical source and build-map change in one pull request.

## 7. Optional automation

The same build can later run in a GitHub Actions workflow after documentation
changes merge to `main`. The workflow would need `contents: write` permission
and credentials permitted to push to the Wiki repository. Manual publication is
recommended initially because it makes the first generated Wiki diff visible
before automation owns it.
