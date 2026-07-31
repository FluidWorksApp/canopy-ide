// Labels a freshly opened issue or PR with its author's supporter tier.
//
// The tier is read from a store this project owns (.github/supporters/), never
// from GitHub. That is deliberate: GitHub Sponsors exposes current tier but has
// no transaction API, so it can never answer "who has given how much", while
// Stripe holds the complete retroactive ledger. Keeping the store as the source
// of truth also keeps the default GITHUB_TOKEN sufficient — reading sponsorships
// from the API would require a classic PAT sitting in a repo secret, because
// GITHUB_TOKEN is refused and GitHub Apps have no sponsorship permission at all.
//
// Everything above main() is pure and covered by supporter-labels.test.mjs; the
// network lives in main().
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;

export const normalizeLogin = (login) =>
  String(login ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

export const managedLabels = (config) => (config?.tiers ?? []).map((t) => t.label);

export const findSupporter = (store, login) => {
  const wanted = normalizeLogin(login);
  if (!wanted) return null;
  return (store?.supporters ?? []).find((s) => normalizeLogin(s.login) === wanted) ?? null;
};

const parseDate = (value) => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

// A supporter's entitlement outlives their last payment, and by how much is a
// policy choice rather than a fact — one-time givers keep their tier for a year,
// a cancelled subscription for a month. Both live in tiers.json so retuning the
// policy never means editing this file or the workflow.
export const isActive = (entry, config, now = Date.now()) => {
  if (!entry) return false;
  const policy = config?.policy ?? {};
  if (entry.recurring === false) {
    const paidAt = parseDate(entry.lastPaymentAt ?? entry.since);
    if (paidAt === null) return false;
    const grace = policy.oneTimeGraceDays ?? 365;
    return now - paidAt <= grace * DAY_MS;
  }
  const lapsedAt = parseDate(entry.lapsedAt);
  if (lapsedAt === null) return true;
  const grace = policy.lapsedGraceDays ?? 30;
  return now - lapsedAt <= grace * DAY_MS;
};

export const activeTier = (entry, config, now = Date.now()) => {
  if (!isActive(entry, config, now)) return null;
  return (config?.tiers ?? []).find((t) => t.id === entry.tier) ?? null;
};

// Weight ignores visibility on purpose: a private supporter still counts toward
// prioritisation, they just never get a public label saying so.
export const weightFor = (entry, config, now = Date.now()) =>
  activeTier(entry, config, now)?.weight ?? 0;

// Labelling a private supporter's issue would disclose a sponsorship they chose
// to keep private, so visibility gates the label and nothing else.
export const plan = ({ entry, config, currentLabels = [], now = Date.now() }) => {
  const managed = managedLabels(config);
  const present = currentLabels.map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const tier = activeTier(entry, config, now);
  const wanted = tier && entry.visibility === "public" ? tier.label : null;

  return {
    add: wanted && !present.includes(wanted) ? [wanted] : [],
    remove: present.filter((l) => managed.includes(l) && l !== wanted),
    tier: tier?.id ?? null,
    weight: tier?.weight ?? 0,
    withheld: Boolean(tier) && entry.visibility !== "public",
  };
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const storeDir = join(repoRoot, ".github", "supporters");

export const readLocalConfig = async () =>
  JSON.parse(await readFile(join(storeDir, "tiers.json"), "utf8"));

// The committed store works today and is hand-editable. Once the Stripe webhook
// receiver is deployed (canopy-website, api/stripe-webhook.ts) it serves the
// same shape over HTTPS and SUPPORTERS_URL takes over — a failed fetch falls
// back rather than dropping the label, since a stale tier beats none.
export const loadStore = async ({ url, token, fetchImpl = fetch, log = () => {} } = {}) => {
  if (url) {
    try {
      const res = await fetchImpl(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      log(`supporter store fetch failed (${err.message}); falling back to the committed file`);
    }
  }
  return JSON.parse(await readFile(join(storeDir, "supporters.json"), "utf8"));
};

const api = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res;
};

const ensureLabel = async (repo, tierLabel, config, token) => {
  const tier = config.tiers.find((t) => t.label === tierLabel);
  const existing = await api(`/repos/${repo}/labels/${encodeURIComponent(tierLabel)}`, { token });
  if (existing.status !== 404) return;
  // Plain ASCII names, not emoji: unicode in label names is known to fail.
  await api(`/repos/${repo}/labels`, {
    method: "POST",
    token,
    body: { name: tier.label, color: tier.color, description: tier.description },
  });
};

const main = async () => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventPath) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are all required");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const subject = event.issue ?? event.pull_request;
  if (!subject) {
    console.log("no issue or pull_request on the event; nothing to label");
    return;
  }

  const config = await readLocalConfig();
  const store = await loadStore({
    url: process.env.SUPPORTERS_URL,
    token: process.env.SUPPORTERS_TOKEN,
    log: (m) => console.log(m),
  });

  const entry = findSupporter(store, subject.user?.login);
  const result = plan({ entry, config, currentLabels: subject.labels ?? [] });

  if (result.withheld) {
    console.log(`#${subject.number}: author is a private supporter — no label applied`);
  }
  if (!result.add.length && !result.remove.length) {
    console.log(`#${subject.number}: no supporter label change`);
    return;
  }

  for (const label of result.remove) {
    await api(`/repos/${repo}/issues/${subject.number}/labels/${encodeURIComponent(label)}`, {
      method: "DELETE",
      token,
    });
  }
  for (const label of result.add) {
    await ensureLabel(repo, label, config, token);
  }
  if (result.add.length) {
    await api(`/repos/${repo}/issues/${subject.number}/labels`, {
      method: "POST",
      token,
      body: { labels: result.add },
    });
  }
  console.log(
    `#${subject.number}: +[${result.add.join(", ")}] -[${result.remove.join(", ")}] (weight ${result.weight})`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
