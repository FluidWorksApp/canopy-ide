# Post-IDE / Agent-Native Workspace Paradigms (2025 – Oct 2026)

Research note scope: interaction paradigms beyond the editor-centric IDE, what stuck, what was abandoned/criticized, what editors are still for, how pricing/model access shapes tools, and predictions/contrarian takes. Source quality caveat up front: a large share of 2026 comparison content is vendor-authored (Augment, Morph, Superconductor, AgentsRoom, etc.) or SEO blogs; these are flagged where used. Primary sources (vendor launch posts, Simon Willison, METR, Pragmatic Engineer, TechCrunch, HN) are preferred where found.

## 1. What paradigms have emerged?

### Takeaway
By mid-2026 the center of gravity moved from "AI in an editor sidebar" to (a) terminal-first agents, (b) async cloud agents that return PRs, (c) parallel-worktree orchestrators, and (d) "mission control" agent-manager surfaces — with incumbents (Cursor 3, Google Antigravity, GitHub Agent HQ) restructuring their products around the agent list rather than the file editor. Spec-first (Kiro), chat-surface (Slack) and voice-dictation patterns exist but are secondary.

### Cited Findings
**Terminal-first agents**
- Pragmatic Engineer AI tooling survey (published ~March 7, 2026, ~906 respondents per most secondary reports): Claude Code was "most loved" at 46%, Cursor 19%, GitHub Copilot 9%; 95% of respondents use AI tools weekly; 75% of 1–10 person startups use Claude Code, while GitHub Copilot dominates at 10,000+ employee enterprises (56%). (Secondary reports of the survey; primary paywalled; some low-quality sites cite a conflicting "15,000 developer" figure) — [Vibe Coding Academy summary](https://vibe-coding.academy/blog/claude-code-number-one-pragmatic-engineer-survey-2026/); [aiproductivity.ai](https://aiproductivity.ai/news/pragmatic-engineer-survey-ai-tooling-2026/); [Vinod Sharma on X](https://x.com/VinodSharma10x/status/2036010258192015550)
- A JetBrains 2026 survey reportedly ranks Claude Code first for professional *usage* (39%), ahead of Copilot (21%), Codex (16%), Cursor (12%) (secondary report, not verified against JetBrains primary) — [aiproductivity.ai](https://aiproductivity.ai/news/pragmatic-engineer-survey-ai-tooling-2026/)
- Simon Willison (Oct 5, 2025) describes his daily setup as multiple terminal sessions of Claude Code (Sonnet 4.5) and Codex CLI (GPT-5-Codex) in different directories, plus Codex Cloud for async tasks (sometimes launched from his phone), and dabbling with Copilot coding agent and Jules — [Simon Willison, "Embracing the parallel coding agent lifestyle"](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)

**Async/cloud agents producing PRs**
- GitHub Copilot coding agent is assigned GitHub issues and opens draft PRs; Cursor can launch cloud agents from Slack that "run for hours on complex tasks"; Codex runs async tasks in cloud containers — [Slack blog: Rise of SWE agents in Slack](https://slack.com/intl/fr-fr/blog/developers/coding-agents-in-slack)
- OpenAI claims >5 million weekly Codex users (vendor claim, via secondary blog) — [techsy.io](https://techsy.io/en/blog/background-coding-agents-compared)
- Devin reports a 67% PR merge rate in 2026, up from 34% in 2025 (vendor-reported, via secondary) — [techsy.io](https://techsy.io/en/blog/background-coding-agents-compared)

**Parallel worktree orchestrators**
- Conductor (Melty Labs, closed-source Mac app), Claude Squad (tmux-based terminal tool, wraps any CLI agent; AGPL-3.0), Crystal (desktop app, MIT) all run multiple agents each in its own git worktree. Crystal is reported as deprecated / succeeded by "Nimbalyst" (conflicting reports, unconfirmed). Newer entrants cited include Superset, cmux, Vibe Kanban, Orca — [rustman wiki](https://rustman.org/wiki/conductor-parallel-agents/); [madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/); [ai-deck.app](https://ai-deck.app/blog/conductor-vs-superset-vs-cmux/); [Paralect](https://www.paralect.com/stack/top-agentic-ides)
- HN thread on Willison's post lists Conductor, Crystal, Sculptor, Rover as tools commenters use — [HN 45489884](https://news.ycombinator.com/item?id=45489884)
- Steve Yegge launched "Gas Town" (Jan 2026), an orchestrator running dozens of coding agents simultaneously, with "Beads" as agent memory/task tracker — [Wikipedia: Steve Yegge](https://en.wikipedia.org/wiki/Steve_Yegge); [Yegge, Welcome to Gas Town](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04)

**Agent managers / "mission control"**
- GitHub Agent HQ / mission control: cross-surface command center to assign, steer and track agents (including third-party agents) across GitHub, VS Code, mobile, CLI; supports steering Copilot agents mid-run — [GitHub blog: Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/); [GitHub blog: mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)
- Google Antigravity shipped an "Agent Manager" as the core of a VS Code-based agentic IDE; Antigravity 2.0 (Google I/O, May 2026) reportedly split it into a standalone desktop app for parallel local agents (single secondary source) — [AInsider Substack](https://ainsiderai.substack.com/p/google-antigravity-agent-manager); [Paralect](https://www.paralect.com/stack/top-agentic-ides)
- Cursor 3 (~April 2, 2026, codename "Glass") made an "Agents Window" the front door; Composer side-pane removed; the classic IDE (file tree, editor, terminal) still exists alongside — [InfoQ](https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/) (could not fetch; via search snippet); [DEV Community](https://dev.to/gabrielanhaia/cursor-3-glass-replaced-composer-with-an-agents-window-1pcg); [AlternativeTo](https://alternativeto.net/news/2026/4/cursor-3-launches-unified-multi-repo-workspace-for-building-software-with-ai-agents)
- Self-hosted open-source "Mission Control" control planes exist for dispatching tasks, reviewing runs, tracking spend across Claude Code, Codex, OpenClaw — [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control)
- Vendor roundup characterizes 2025–2026 as vendors shipping terminal-first, desktop-first and cloud-first mission-control surfaces, with IDE integrations added later (vendor-authored) — [Augment Code](https://www.augmentcode.com/tools/best-ai-coding-agent-desktop-apps)

**Spec-first IDEs**
- AWS Kiro generates requirements/design/tasks before code; reviewers estimate spec generation and review add 10–20 minutes per project — [axonbuild review](https://axonbuild.com/blog/kiro-ide-review); [Morph comparison](https://www.morphllm.com/comparisons/kiro-vs-cursor)

**Agents embedded in team tools**
- Slack: Claude-in-Slack research preview (Dec 2025); "Slack Code" (reported Aug 2026) brings coding agents (Claude, Devin, Codex, GitHub, Vercel) into team channels with planning, previews and approvals in-channel (secondary report) — [Crypto Briefing](https://cryptobriefing.com/slack-vibe-coding-ai-agents/); [Slack blog](https://slack.com/intl/fr-fr/blog/developers/coding-agents-in-slack)

**Voice-driven**
- Practitioner pattern is voice *dictation of prompts* into terminal agents (Wispr Flow, Superwhisper, Claude Code's /voice), not voice-writing code; a newer category reads agent replies back aloud, useful when running many agents — [Zack Proser setup guide](https://zackproser.com/blog/wisprflow-claude-code-setup-guide); [DEV Community voice tools](https://dev.to/devtoolpicks/best-voice-coding-tools-for-indie-hackers-in-2026-5gjj); [Willow Voice blog (vendor)](https://willowvoice.com/blog/voice-ai-dictation-claude-code)
- Guides concede the keyboard remains the right tool for syntactically precise code — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/556/ai-voice-dictation-wispr-flow-superwhisper-compared)

### Inferences
- The convergent UI primitive across Cursor 3, Antigravity, Agent HQ, Conductor is a **list of agent tasks/sessions with status + a diff/review pane**, not a file tree. The editor is demoted to a drill-down view.
- Terminal-first won developer affection (most-loved), but enterprises still buy IDE-integrated Copilot; the market is bifurcated by org size.
- Voice is an input-method layer on top of agent prompting rather than its own paradigm.

### Gaps
- Could not find primary data on canvas/design-to-code tools (Figma Make, v0, Lovable, etc.) in this scope; not researched in depth.
- No primary confirmation of Linear/Notion-embedded coding agent adoption numbers.
- Could not fetch Cursor's own Cursor 3 launch post or InfoQ article body (HTTP 405).

## 2. What was abandoned or criticized, and why?

### Takeaway
The dominant failure modes are: (1) review/verification bottleneck and cognitive cost of supervising many agents, (2) cost blowups and opaque, shifting pricing/limits, (3) low success on ambiguous real-world tasks for fully autonomous agents, (4) friction of rigid workflows (spec-first) for exploratory work, and (5) environment/setup overhead and security concerns in orchestrators. Few products were outright "abandoned"; more common are pivots, deprecations (Crystal), and vendor turmoil (Windsurf).

### Cited Findings
**Review bottleneck / cognitive load (parallel agents)**
- Willison: "AI-generated code needs to be reviewed"; he can only properly review and land one significant change at a time, so parallelism works only for low-overhead tasks (research, code explanation, small maintenance, pre-specified work) — [Simon Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- HN commenters: "review is hands down the biggest bottleneck" (Areibman); "I can trust nothing and have to verify every assumption... a massive overhead" (munk-a); "it becomes harder to catch fundamental problems you would have noticed immediately inline" — commenter extr says they mostly gave up the pattern; grim_io is "not convinced there is any hope for a productive, long-term, burnout-free parallel agent workflow"; WhyOhWhyQ "transition[s] into low effort mode" while agents run — [HN 45489884](https://news.ycombinator.com/item?id=45489884)
- Counterpoint on HN: "it's very cheap to throw out the failures" (jmtulloss) — [HN 45489884](https://news.ycombinator.com/item?id=45489884)

**Low success / autonomy (cloud agents)**
- Devin early skepticism: original SWE-bench 13.86% unassisted; widely cited Answer.AI trial logged 14 failures and 3 successes across 20 tasks (2025; via secondary) — [techsy.io](https://techsy.io/en/blog/background-coding-agents-compared)
- Devin success reportedly 30–50% on well-defined tasks, 15–30% on novel/ambiguous tasks (secondary, unsourced primary) — [techsy.io](https://techsy.io/en/blog/background-coding-agents-compared)
- One hands-on test found Jules "extremely slow," no work log during planning, and a breaking bug prevented completing a ticket (single vendor test, a competitor) — [Superconductor](https://www.superconductor.com/blog/competitor-comparison)
- Dominant r/codex complaint: mid-stream usage-limit cuts; Codex forgets context between sessions (secondary) — [techsy.io](https://techsy.io/en/blog/background-coding-agents-compared)

**Productivity evidence**
- METR RCT (July 2025, 16 experienced OSS devs, 246 issues): 19% slowdown with AI allowed, while devs believed they were ~20% faster — [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- METR 2026 follow-up: "That finding is now outdated. Speedups now seem likely, but changes in developer behavior make our new results unreliable" — [METR on X](https://x.com/METR_Evals/status/2026355544668385373); coverage conflicts on interpretation — [particula.tech](https://particula.tech/blog/ai-coding-tools-developer-productivity-paradox)

**Cost blowups and pricing backlash**
- Cursor (June 16, 2025) switched Pro from 500 fast requests to $20 of usage billed at API rates and added $200 Ultra; users hit unexpected charges; CEO Michael Truell: "We recognize that we didn't handle this pricing rollout well and we're sorry"; refunds offered for June 16–July 4 charges — [TechCrunch](https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/); [Simon Willison](https://simonwillison.net/2025/Jul/5/cursor-clarifying-our-pricing); some users reported refund delays — [wearefounders.uk](https://www.wearefounders.uk/cursors-pricing-disaster-how-a-routine-update-turned-into-a-developer-exodus/)
- Anthropic introduced weekly limits for Pro/Max (effective Aug 28, 2025), citing extreme usage and account sharing; said <5% of subscribers affected — [HN thread](https://news.ycombinator.com/item?id=44713757); [Yahoo/TechCrunch](https://tech.yahoo.com/ai/articles/anthropic-were-glad-claude-code-164658123.html)
- GitHub issue "Weekly Usage Limits Making Claude Subscriptions Unusable": Max x20 users say Opus depleted at same rate as Max x5; "bait and switch" complaints; lack of real-time usage meter — [anthropics/claude-code #9424](https://github.com/anthropics/claude-code/issues/9424)
- Cursor 3 reaction divided: cost overhead and move away from IDE-first identity; token spend climbed for parallel agents because frontier models needed Max Mode on legacy plans; users complained of being dropped into Agents Window at startup without a toggle (until a later 3.x release, per how-to blog) — [InfoQ (snippet)](https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/); [Medium/tentenco](https://medium.com/@tentenco/cursor-3-ships-an-agent-first-interface-heres-what-it-actually-changes-1f2bf8f383e2); [dredyson.com](https://dredyson.com/how-to-set-editor-as-default-window-in-cursor-ide-a-complete-beginners-step-by-step-fix-guide-2026-update/)
- Conductor: cost multiplies with each parallel agent; Mac-only — [rustman wiki](https://rustman.org/wiki/conductor-parallel-agents/)
- Gas Town criticized as "inefficiently burning through thousands of dollars a month in API costs"; overwhelming number of ad hoc concepts; Yegge reportedly said most devs should avoid using it — [Maggie Appleton](https://maggieappleton.com/gastown); [Pragmatic Engineer interview](https://newsletter.pragmaticengineer.com/p/from-ides-to-ai-agents-with-steve)

**Workflow rigidity (spec-first)**
- Kiro skeptics: spec-driven may be "too rigid for the exploratory, iterative way most software actually gets built"; friction on small tasks; users treat the spec phase "as a loading screen" and approve without reading; credit pricing metered with no unlimited plan, overage at higher rate; defaults lean toward AWS services — [axonbuild](https://axonbuild.com/blog/kiro-ide-review); [vibecoding.app](https://vibecoding.app/blog/kiro-review); [Augment Kiro vs Devin](https://www.augmentcode.com/tools/kiro-vs-devin)

**Orchestrator setup / security**
- Conductor re-cloned repos so each worktree required reinstalling deps and reconfiguring .env; HN concern over demanding full read-write access to all GitHub repos (reportedly partly addressed later) — [rustman wiki](https://rustman.org/wiki/conductor-parallel-agents/); [sharkly.ai](https://sharkly.ai/blog/claude-squad-conductor-tmux-compared/)
- Worktrees isolate files but not ports, services, or the machine; "worktrees are not a security boundary" — [rustman wiki](https://rustman.org/wiki/conductor-parallel-agents/)

**Vendor turmoil**
- Windsurf: OpenAI ~$3B deal collapsed; Google's $2.4B reverse-acquihire of CEO/researchers (non-exclusive license); Cognition acquired remainder July 14, 2025. Customers switched to Cursor etc. after Anthropic restricted Windsurf's direct Claude access in June 2025 — [TechCrunch](https://www.techcrunch.com/2025/07/14/cognition-maker-of-the-ai-coding-agent-devin-acquires-windsurf/); [PureAI](https://pureai.com/articles/2025/07/16/windsurf-wars.aspx)

### Inferences
- "Too much autonomy" is less often the complaint than "too much unverified output": the binding constraint is human review throughput, so orchestration UIs that only add more parallel agents hit a ceiling.
- Model access is a product risk: a tool that depends on one lab's models can lose its users overnight (Windsurf/Claude).
- Pricing opacity (credits, weekly caps, Max Mode) is itself a UX failure — users want a live spend/limit meter in the workspace.

### Gaps
- No reliable data on churn or abandonment rates for specific orchestrators (Crystal deprecation reason unconfirmed).
- Independent, non-vendor success-rate benchmarks for cloud agents on real codebases are sparse; most numbers are vendor or competitor-produced.

## 3. What is the editor/file tree still needed for, and what became irrelevant?

### Takeaway
Power users still use the editor for review/diff inspection, precise manual edits, reading code to build understanding, and staying "in the loop" on hard problems; what's fading is the editor as the place where work *starts* and where typing happens, plus inline autocomplete as the core value proposition.

### Cited Findings
- Cursor 3 keeps the IDE (file tree, editor pane, terminal) but "it is just no longer where the work starts" — [airisingtrends](https://airisingtrends.com/cursor-3-glass-agents-window/); [DEV Community](https://dev.to/gabrielanhaia/cursor-3-glass-replaced-composer-with-an-agents-window-1pcg)
- HN: angelmm uses VSCode (without Copilot) or Helix for active coding, Claude interactively, a background agent for other tasks — "more productive and less exhausted"; extr turns off edit permissions and manually approves each change; favoboa: "Not a new IDE; we need to shift the whole paradigm" toward better diff review — [HN 45489884](https://news.ycombinator.com/item?id=45489884)
- Willison retains design decisions, detailed specs and review of all significant changes himself — [Simon Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- Conductor praised specifically for its diff/PR/Linear/GitHub review flow — [rustman wiki](https://rustman.org/wiki/conductor-parallel-agents/)
- Kiro reviewer: inline autocomplete weaker than Cursor's (signals autocomplete still matters to some buyers) — [vibecoding.app](https://vibecoding.app/blog/kiro-review)
- Visual Studio BYOK local models power Chat/Agent but not inline completions — [pooyagolchian.com](https://pooyagolchian.com/blog/visual-studio-2026-local-ai-ollama-copilot/)
- Voice guides: keyboard remains right for syntactically precise code — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/556/ai-voice-dictation-wispr-flow-superwhisper-compared)

### Inferences
- The editor is becoming a **review and comprehension instrument** (diffs, jump-to-definition, reading) rather than an authoring instrument. Language-server features (go-to-def, references, diagnostics) remain valuable—arguably more so for agents than for humans.
- Terminal multiplexing (tmux, color-coded iTerm tabs per HN) is a stopgap signalling unmet demand for a session manager.

### Gaps
- No survey data quantifying how much time power users spend in editor vs agent views.

## 4. How are model access and pricing shaping tools?

### Takeaway
Flat-rate subscriptions (Claude Max, ChatGPT Pro/Codex) subsidized heavy agent use and drove terminal-agent adoption, but caps and metering tightened through 2025–26 (Anthropic weekly limits, Cursor usage pools, Copilot token metering June 2026). This pushes multi-model routing, BYOK and local/open-weight models (Qwen, GLM) as cost hedges; orchestrators that wrap whatever CLI the user already pays for benefit.

### Cited Findings
- Cursor moved from request-based to usage-at-API-rates (June 2025), Auto mode unlimited — [TechCrunch](https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/)
- Anthropic weekly limits on $20 Pro, $100 and $200 Max plans (Aug 2025) — [Yahoo/TechCrunch](https://tech.yahoo.com/ai/articles/anthropic-were-glad-claude-code-164658123.html); a June 2026 user gist claims the "weekly" limit actually resets every 72 hours (single-user observation) — [gist](https://gist.github.com/monperrus/3ac4b303a84946bbeaf2b1123ee99491)
- GitHub reportedly moved paid Copilot tiers to usage-based, token-metered pricing on June 1, 2026 (Business $19, Enterprise $39 per user/month) (secondary blog, unverified against GitHub) — [pooyagolchian.com](https://pooyagolchian.com/blog/visual-studio-2026-local-ai-ollama-copilot/)
- Kiro: credit-metered tiers, no unlimited plan; full spec-driven feature ~15–25 credits; tier prices conflict across sources — [vibecoding.app](https://vibecoding.app/blog/kiro-review); [theaiagentindex](https://theaiagentindex.com/agents/kiro)
- Claude Squad wraps any CLI agent (Claude Code, Codex, Aider, etc.), making it model/subscription-agnostic — [rustman wiki](https://rustman.org/wiki/conductor-parallel-agents/)
- HN: users split work by model — Claude for real-time implementation, Codex for long research — [HN 45489884](https://news.ycombinator.com/item?id=45489884)
- Local models: Qwen3-coder / Qwen3.6 most-cited local default; ~24–32GB VRAM recommended; GLM-5 (744B/40B active) usually via hosted ":cloud" variant; Ollama ":cloud" suffix lets one tool route local vs hosted; OpenRouter for cheaper open models (blog sources) — [braindetox.kr](https://braindetox.kr/en/posts/local_llm_agentic_coding_2026.html); [KDnuggets](https://www.kdnuggets.com/pairing-claude-code-with-local-models); [AgentsRoom](https://agentsroom.dev/blog/agentsroom-now-supports-ollama-local-models)
- Anthropic cutting Windsurf's direct Claude access (June 2025) led customers to switch tools — [TechCrunch](https://www.techcrunch.com/2025/07/14/cognition-maker-of-the-ai-coding-agent-devin-acquires-windsurf/)

### Inferences
- Tools that let users bring the subscription they already have (by wrapping first-party CLIs) avoid the margin squeeze that hit Cursor/Windsurf, but inherit those CLIs' rate limits—so usage visibility across providers is a real need.
- Expect "router" features (cheap model for exploration, frontier model for hard steps) to become standard as metering spreads.

### Gaps
- No independent total-cost comparison of subscription vs API vs local for agentic workloads found.
- Current (Oct 2026) official prices/limits for Claude Max, ChatGPT Pro, Copilot not verified from primary pages.

## 5. Predictions for the 2027 workspace and contrarian takes

### Takeaway
Bulls (Yegge, vendors) predict the IDE is replaced by orchestration of many agents, with humans as managers/designers; skeptics argue the bottleneck is human review and design, parallel workflows cause burnout and lowered quality bars, and measured productivity gains remain contested.

### Cited Findings
- Yegge & Gene Kim talk "2026: The Year The IDE Died" (Dec 2025); Yegge's eight-level scale culminates in orchestration (agents running agents); estimates ~70% of engineers still at levels 1–2 (third-party summary) — [yegge.ai bibliography](https://yegge.ai/bibliography); [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/from-ides-to-ai-agents-with-steve); [podcast summary](https://bulletpointpodcast.com/thepragmaticengineer/from-ides-to-ai-agents-with-steve-yegge/)
- Cursor 3 framed by commentators as "a bet that you'll manage agents, not write code" — [cozypet narrative](https://cozypet.github.io/cursor3-narrative/)
- Maggie Appleton: when agents write code, **design and planning become the bottleneck**; Gas Town "churns through implementation plans so quickly" users must do extensive design to feed it; patterns worth keeping: fixed specialized agent roles under hierarchical supervision, persistent tasks stored outside the agent with disposable sessions, continuous work queues, specialist subagents — [Maggie Appleton](https://maggieappleton.com/gastown)
- Contrarian (HN): voidhorse — AI users are "so cognitively distanced from what you are doing that you subconsciously lower the bar"; ragnese — parallelism exists only because tools are too slow for flow state; scuff3d — "modest productivity improvement aren't worth the absolutely insane resources" — [HN 45489884](https://news.ycombinator.com/item?id=45489884)
- Contrarian (evidence): METR 2025 slowdown; 2026 follow-up says speedups "seem likely" but results unreliable — [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); [METR on X](https://x.com/METR_Evals/status/2026355544668385373)
- Enterprise reality check: Copilot (IDE-integrated) still dominates 10,000+ employee companies in the Pragmatic Engineer survey — [Vibe Coding Academy summary](https://vibe-coding.academy/blog/claude-code-number-one-pragmatic-engineer-survey-2026/)

### Inferences
- Plausible 2027 workspace shape implied by sources: a persistent task/queue layer (Beads-, Linear-, Slack-like) feeding role-specialized agents; a mission-control view of sessions with spend/limit meters; review-centric diff surfaces; editor as drill-down; agents reachable from chat/mobile. Unmet needs: faster trustworthy review/verification, environment isolation beyond worktrees (ports, services, security), cross-provider usage visibility, and tooling for the design/spec step that is now the bottleneck.
- Strongest contrarian thesis: throughput of agents is no longer the constraint; human attention, review and design are—so "more parallel agents" UIs have diminishing returns without better verification.

### Gaps
- Did not find Stratechery/Every/Latent Space primary pieces with explicit 2027 workspace predictions within the call budget; their views are not represented here.
- No source found for a specific "IDE dead by 2027" prediction beyond Yegge's 2026 framing.
