// The join between "what the user asked for" and "what Canopy will run".
//
// parseVibeIntent reads the request; planInstall / planLink / planDeploy decide
// whether it is safe and what it would take. This module is the one place that
// puts those together and turns the answer into something Ash can say — which
// keeps VibeBuilderSession free of planning logic and keeps the whole policy
// testable without a process, a store, or a clock.
//
// Two shapes come out, and the difference between them is the point:
//
//   - `run` is a single argv that Canopy can execute once the user agrees.
//     Installing a package and publishing a site are both of this kind.
//   - `guide` is a sequence Canopy explicitly will NOT execute. Linking a
//     service is the case: its steps include collecting an API key, and a
//     secret has to come from the person who holds it. Canopy names the
//     variables and where they go; it never asks a CLI to produce the value
//     and never sees it.
//
// A refusal is a first-class outcome rather than an error, because the planners
// refuse for good reasons — an untracked env file, a deploy with no evidence
// behind it — and the user is owed the reason in plain language.

import {
  PUBLISH_CONFIRMATION,
  detectDeployProvider,
  planDeploy,
  type DeployContext,
  type DeployTarget,
} from "./vibeDeploy";
import {
  alreadyInstalled,
  detectRunner,
  planInstall,
  type PackageRequest,
} from "./vibePackages";
import { clientVarName, planLink, type LinkContext } from "./vibeServices";
import type { VibeIntent } from "./vibeIntent";

export type AbstractionProposal =
  | {
      kind: "run";
      title: string;
      detail: string;
      argv: string[];
      cwd: string;
      /** Shown on the confirm button, and for production the exact phrase the
       *  deploy planner requires. */
      confirmLabel: string;
      caveat: string | null;
    }
  | { kind: "guide"; title: string; detail: string }
  | { kind: "refuse"; title: string; detail: string };

export interface AbstractionContext {
  cwd: string;
  /** Directory listing of `cwd`, used to find lockfiles and provider markers. */
  entries: readonly string[];
  packageManagerField?: string | null;
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
  link: LinkContext;
  /** Verification is deliberately NOT here. It is not a property of the
   *  project on disk — it is what the session observed this turn, and only the
   *  session knows it. Keeping it out means no reader can supply a plausible
   *  value and have it quietly ignored, or worse, quietly believed. */
  deploy: Omit<DeployContext, "confirmed" | "verification">;
}

/** What Canopy proposes to do about an intent, or why it won't.
 *
 *  `verification` is a separate argument for the same reason it is absent from
 *  the context: it must come from whoever actually watched the checks run. */
export function proposeAbstraction(
  intent: VibeIntent,
  ctx: AbstractionContext,
  verification: DeployContext["verification"],
): AbstractionProposal {
  if (intent.kind === "install") return proposeInstall(intent.packages, ctx);
  if (intent.kind === "link") return proposeLink(intent.provider, ctx);
  return proposeDeploy(intent.target, ctx, verification);
}

function proposeInstall(
  packages: readonly PackageRequest[],
  ctx: AbstractionContext,
): AbstractionProposal {
  // Asking for something already there is not a refusal — it is a question
  // already answered, and re-running the installer would churn the lockfile
  // for nothing.
  const wanted = packages.filter(
    (p) => p.version != null || !alreadyInstalled(p, ctx.dependencies, ctx.devDependencies),
  );
  if (wanted.length === 0) {
    return {
      kind: "guide",
      title: packages.length === 1 ? `${packages[0].name} is already installed.` : "Those are already installed.",
      detail: "Nothing to do — they're already in this project's dependencies.",
    };
  }

  const runner = detectRunner(ctx.entries, ctx.packageManagerField);
  const plan = planInstall(wanted, runner, ctx.cwd);
  if (!plan.ok) {
    return {
      kind: "refuse",
      title: "I won't install that.",
      detail: plan.why,
    };
  }
  return {
    kind: "run",
    title: plan.summary,
    detail: `I'll run ${runner} in ${ctx.cwd}.`,
    argv: plan.argv,
    cwd: plan.cwd,
    confirmLabel: "Install",
    caveat: null,
  };
}

function proposeLink(providerId: string, ctx: AbstractionContext): AbstractionProposal {
  const plan = planLink(providerId, ctx.link);
  if (!plan.ok) {
    return {
      kind: "refuse",
      title: "I can't link that safely.",
      detail: plan.why,
    };
  }
  // Deliberately never a `run`. One of these steps is "give me your API key",
  // and the moment Canopy executes that on the user's behalf it is handling a
  // secret it has no business holding.
  const lines = plan.steps.map((step) => {
    switch (step.kind) {
      case "use-linked-account":
        return `Use the linked account over ${step.reach.toUpperCase()} — ${step.why}`;
      case "link-account":
        return `Link your ${step.accountLabel} account — ${step.why}`;
      case "install-cli":
      case "authenticate":
        return `${step.command} — ${step.why}`;
      case "collect-secret":
        return `${step.secret.name}${step.secret.publishable ? "" : " (keep this one server-side)"} — ${step.why}`;
      case "write-env":
        return `${step.file}: ${step.names.join(", ")} — ${step.why}`;
    }
  });
  const client = plan.provider.secrets
    .filter((s) => s.publishable)
    .map((s) => clientVarName(plan.provider, s));
  return {
    kind: "guide",
    title: plan.summary,
    detail: [
      ...lines,
      client.length > 0
        ? `Only ${client.join(" and ")} may be read by the browser; everything else stays server-side.`
        : "None of these belong in browser code.",
    ].join("\n"),
  };
}

function proposeDeploy(
  target: DeployTarget,
  ctx: AbstractionContext,
  verification: DeployContext["verification"],
): AbstractionProposal {
  const provider = detectDeployProvider(ctx.entries);
  // `confirmed: true` here does NOT mean the user confirmed. This function's
  // only job is to work out what a deploy WOULD run so the user can be shown it
  // and asked; asking is impossible without the answer in hand.
  //
  // It is safe because every other gate planDeploy applies — a provider it can
  // find, verification that resolved, a clean tree, a CLI on PATH — is judged
  // independently of `confirmed`, so all of them still refuse here. The only
  // check this skips is the confirmation itself, and skipping it is the point:
  // the user has not been asked yet.
  //
  // Which means this function CANNOT be the thing that enforces confirmation.
  // That gate lives at the point of execution, where the user's actual words
  // are available to compare against PUBLISH_CONFIRMATION. An earlier draft
  // pre-checked with `confirmed: false` and looked like a second line of
  // defence; it wasn't one, and a test proved it changed no outcome.
  // `verification` last, and after the spread: ctx.deploy may still carry a
  // stale one at runtime even though the type forbids it, and the observed
  // verdict must win over anything a caller happened to leave in the object.
  const plan = planDeploy(
    provider,
    target,
    { ...ctx.deploy, verification, confirmed: true },
    ctx.cwd,
  );
  if (!plan.ok) {
    return {
      kind: "refuse",
      title: target === "production" ? "I won't publish this yet." : "I can't put up a preview yet.",
      detail: plan.needs ? `${plan.why} ${plan.needs}` : plan.why,
    };
  }
  return {
    kind: "run",
    title: plan.summary,
    detail:
      target === "production"
        ? `This goes live for real users. Confirm with exactly: ${PUBLISH_CONFIRMATION}`
        : `A preview URL only — nothing reaching your live site.`,
    argv: plan.argv,
    cwd: plan.cwd,
    confirmLabel: target === "production" ? PUBLISH_CONFIRMATION : "Put up a preview",
    caveat: plan.caveat,
  };
}
