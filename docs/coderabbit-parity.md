# CodeRabbit PR review parity

Research updated 2026-08-05 against CodeRabbit's official documentation. This
matrix treats parity as workflow coverage, not identical product architecture:
CodeRabbit is a hosted bot that posts automatically; Canopy is local-first and
keeps public review, resolution, pushes, and merging under a human click.

## Capability matrix

| Capability | CodeRabbit | Canopy after this pass |
|---|---|---|
| Change summary and review walkthrough | Automatic summary, file walkthrough, effort and related-work context | Agent review map with risk-ranked files, claims, linked-requirement verdicts, and verification evidence |
| Inline findings | Categorised, severity-ranked bot comments | Agent findings staged privately on diff lines; human can edit/drop and submit one native review |
| Incremental review | Reviews commits added since its previous pass | A subsequent Review automatically compares the user's last reviewed SHA with current head and suppresses unchanged findings |
| Repository guidance | Path instructions plus recognised agent guideline files | Review reads recognised guideline files and applies IDE-configured path rules and exclusions per repository |
| Automatic review | Configurable review on open and incremental pushes | Opt-in automatic private review runs once per head SHA, optionally on drafts; findings remain staged until human confirmation |
| Linked issue validation | Addressed / not addressed / unclear | Same three-way assessment in the private review map |
| CI and analyzers | CI-log analysis plus managed linter/security catalog | Reads GitHub checks and runs relevant analyzers already configured by the repository; no opaque third-party scanner installation |
| Suggested fixes | GitHub suggestions and agent Autofix | Applies GitHub suggestion fences in an isolated PR worktree, verifies, commits, pushes, and replies |
| Review remediation | Autofix current branch or stacked PR | Fix CI, resolve conflicts, address comments, test, push, and create follow-up issues in isolated worktrees |
| Stacked fix delivery | Fix CI can open a child PR targeting the current PR branch or commit directly | Fix CI defaults to a draft child PR targeting the current PR branch, with an explicit direct-commit alternative |
| Stack context | Follow-up fixes remain independently reviewable | Review and fix agents receive immediate parent/child context and stay scoped to the current layer; the rail refreshes stack relationships without erasing stale known state on failure |
| Contextual chat | PR bot commands and thread chat | Visible steerable agent terminal, companion PR actions, and routing back to the PR's originating session |
| Persistent preferences | Organisation/repository Learnings | Explicit repository learnings are user-owned and editable in the Review policy dialog before agents apply them |
| Custom checks | Natural-language pre-merge checks with warning/error policy | Repository policy defines warning/error checks; the review map reports PASS/WARNING/ERROR/INCONCLUSIVE with evidence |
| Review state | Bot status, checks, overrides, Change Stack | Native conversation, threads, per-file viewed state, checks, next move, agent rounds, approvals, auto-merge, and merge actions |
| Durable pending review | Hosted bot state | Private review body/comments and rejected-agent decisions persist across tab closure; nothing is posted implicitly |
| Visual/runtime validation | Primarily repository and CI context | Runs the branch locally, drives the changed UI, checks console output, and captures screenshots |
| Cross-repository context | Linked repository analysis | Policy can name related local repositories for caller/schema compatibility analysis; relationship discovery remains manual |
| Diagrams | Conditional Mermaid diagrams | Review maps conditionally generate Mermaid sequence diagrams, rendered by the shared Markdown component |
| Git providers | GitHub, GitLab, Azure DevOps, Bitbucket | GitHub through the user's `gh` authentication |

## Deliberate differences

- Canopy does not automatically publish bot comments. Agent output remains a
  private draft until the signed-in human confirms the native GitHub review.
- Canopy uses repository-owned analyzers and the local toolchain instead of
  claiming a centrally managed scanner catalog. This makes results reproducible
  from the checkout and avoids silently changing a project's analysis policy.
- Canopy's comment-addressing loop stops for human closure rather than allowing
  an agent to approve or merge its own remediation.

## Remaining material gaps

1. Organisation-level policy inheritance and administrator approval for shared
   learnings; repository policy and opt-in automatic private review are built.
2. Automatic cross-repository relationship discovery; explicit related local
   repositories already participate in contract review.
3. A managed security/dependency scanner catalog with normalised findings.
4. A semantic change-stack view; conditional review diagrams are built.
5. GitLab, Azure DevOps, and Bitbucket provider adapters.

## Stacked PR terminology

CodeRabbit's **Change Stack** is a semantic reading order for files and ranges
inside one pull request. It is not a graph of dependent pull requests. Its
recent **Create stacked PR** option is narrower: Fix CI or another coding task
opens a child PR whose base is the current PR branch, so the generated fix can
be reviewed before entering the parent. Canopy implements that delivery model
and exposes its already-detected immediate parent/child relationships; it does
not claim automatic transitive restacking or chain-wide landing.

## Primary CodeRabbit sources

- <https://docs.coderabbit.ai/overview/pull-request-review>
- <https://docs.coderabbit.ai/pr-reviews/walkthroughs>
- <https://docs.coderabbit.ai/pr-reviews/summaries>
- <https://docs.coderabbit.ai/issues/pr-validation>
- <https://docs.coderabbit.ai/knowledge-base/code-guidelines>
- <https://docs.coderabbit.ai/knowledge-base/learnings>
- <https://docs.coderabbit.ai/pr-reviews/pre-merge-checks>
- <https://docs.coderabbit.ai/pr-reviews/cicd-pipeline-analysis>
- <https://docs.coderabbit.ai/finishing-touches/autofix>
- <https://docs.coderabbit.ai/pr-reviews/change-stack>
