# LLM-Native Application Architecture: The Model as Runtime/Harness (2025–Oct 2026)

Research scope note: about 18 search and fetch calls. OpenAI's own engineering pages returned HTTP 403 when fetched directly, so OpenAI details come from search snippets and secondary coverage. Several Anthropic posts were seen only through secondary summaries; this is marked where it applies. Material older than 2025 is flagged.

## 1. What is an "agent harness" and what makes a good one?

### Takeaway
By 2026 Anthropic and OpenAI both use "harness" for the layer around the model: the loop that calls the model, carries out its tool calls, manages context, and holds state. A good harness is minimal, stateless and restartable, and keeps durable state (session log, files, git) outside the context window. It keeps credentials out of reach of generated code, and it is reviewed regularly because the assumptions it encodes about the model's weaknesses go stale as models improve.

### Cited Findings
- Anthropic defines the harness as "the loop that calls Claude and routes Claude's tool calls to the relevant infrastructure". Harness plus model is the "brain"; sandboxes and tools are the "hands" (Apr 8, 2026). — [Anthropic Engineering: Scaling Managed Agents](https://anthropic.com/engineering/managed-agents)
- Managed Agents architecture components:
  - **Session**: an append-only event log stored outside both the harness and the context window, queryable by position.
  - **Harness**: a *stateless* loop that can crash and restart by reloading the session.
  - **Sandbox**: replaceable "cattle, not pets".
  - **Tools**: every "hand" sits behind one interface, `execute(name, input) → string`.
  - Source: [Anthropic Engineering](https://anthropic.com/engineering/managed-agents)
- Lessons from that post:
  - **Assumptions go stale.** Harnesses "encode assumptions about what Claude can't do on its own". Context resets were needed for Sonnet 4.5's "context anxiety", but with Opus 4.5 "the resets had become dead weight."
  - **Decouple.** Putting harness, sandbox and session in one container created a single point of failure.
  - **Keep credentials away from generated code.** Credentials live in a vault or proxy outside the sandbox, and the harness never sees them.
  - **Keep full history durable.** Compaction is irreversible, so the complete history is kept in the session log and the harness chooses what to load into context.
  - **Provision lazily.** This cut p50 time-to-first-token by about 60% and p95 by over 90%.
  - Anthropic calls Managed Agents a "meta-harness": "opinionated about the shape of these interfaces, not about what runs behind them."
  - Source: [Anthropic Engineering](https://anthropic.com/engineering/managed-agents)
- Anthropic's "Effective harnesses for long-running agents" (late 2025; known here only through secondary coverage) addresses agents losing progress across context windows. Its fix is file-based memory, not a framework:
  - a progress log, a machine-readable feature list, a setup script, and git history;
  - an "initializer" agent that runs once, then a coding agent that makes incremental progress in each later session;
  - continuous verification, i.e. tests after major changes.
  - Sources: [mejba.me summary](https://www.mejba.me/blog/anthropic-long-running-agent-harness); [DEV Community](https://dev.to/claudiuspapirus/why-ai-agents-fail-long-projects-and-the-anthropic-fix-3029)
- InfoQ (Apr 2026) reports a later Anthropic three-agent harness that splits planning, generation and evaluation across agents to keep multi-hour sessions coherent. — [InfoQ](https://infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)
- Anthropic's "Building agents with the Claude Agent SDK" describes the loop as **gather context → take action → verify work → repeat**:
  - Agents "need to be able to fetch and update [their] own context". File-system search (grep, tail) is used instead of pre-loading.
  - The SDK's compact feature summarizes old messages as the context limit nears.
  - Subagents run parallel searches and return only the relevant excerpts.
  - Custom tools are "the primary building blocks of execution", with Bash as a general-purpose fallback.
  - Source: [Claude blog: Building agents with the Claude Agent SDK](https://claude.com/resources/articles/building-agents-with-the-claude-agent-sdk)
- Anthropic's "Effective context engineering for AI agents" (reported date Sep 29, 2025; secondary summaries only):
  - Context is a finite "attention budget" that suffers from "context rot".
  - **Just-in-time retrieval**: hold lightweight identifiers (paths, URLs, queries) and load data with tools at runtime. In Claude Code, CLAUDE.md loads up front and glob/grep fetch the rest.
  - Progressive disclosure.
  - For long horizons: compaction, structured note-taking outside the window, and sub-agents.
  - A named failure mode is bloated tool sets with overlapping functions.
  - Sources: [agentic-ai readthedocs summary](https://agentic-ai.readthedocs.io/en/latest/ContextEngineering/anthropic/); [eWeek](https://www.eweek.com/news/anthropic-context-engineering-building-ai-workflows/)
- **Older material, December 2024:** Anthropic's "Building effective agents".
  - It separates *workflows* (predefined code paths) from *agents* ("LLMs dynamically direct their own processes and tool usage").
  - The most successful teams used "simple, composable patterns", not complex frameworks.
  - It advises "finding the simplest solution possible", which "might mean not building agentic systems at all".
  - It notes agentic systems "trade latency and cost for better task performance".
  - A secondary source lists its patterns: prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer.
  - Sources: [Anthropic](https://www.anthropic.com/research/building-effective-agents); [aimultiple summary](https://aimultiple.com/building-ai-agents)
- OpenAI, "Unrolling the Codex agent loop" (Michael Bolin, Jan 23, 2026):
  - The agent loop is the core logic coordinating user, model and tools, and it is "the harness" behind every Codex surface: CLI, Codex Cloud, and the VS Code extension.
  - The source is open on GitHub.
  - Direct fetch returned 403, so these details come from search snippets. — [OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop)
- Secondary write-ups describe the Codex harness as embeddable through `codex exec`, an SDK, and an "app-server" protocol, i.e. the same harness used across many products. — [besthub.dev](https://www.besthub.dev/articles/codex-harness-how-openai-built-an-embeddable-agent-os-in-135-rust-crates-fd42090cccd9); [Ken Huang Substack](https://kenhuangus.substack.com/p/from-software-engineering-to-harness)
- OpenAI "harness engineering" (InfoQ, Feb 2026):
  - In an internal five-month experiment, agents wrote the code, tests, CI and observability for a beta product of about a million lines, with no hand-written source.
  - Engineers' work shifted to designing environments, specifying intent, and giving structured feedback.
  - The figures are self-reported via InfoQ. — [InfoQ](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex)
- The minimal loop is: take context, call the model, run the proposed tool, append the result, repeat. Production adds permissions, retry limits, crash-safe state, and checks that verification actually ran. — [Towards AI](https://pub.towardsai.net/harness-engineering-for-ai-coding-agents-from-prompts-to-production-ready-systems-db8a3fc12e6e)

### Inferences
- Anthropic and OpenAI converge on the same shape:
  - one reusable harness behind many surfaces (CLI, IDE, web, SDK);
  - an event-sourced session log;
  - a narrow, uniform tool interface;
  - sandboxed execution with credentials held outside it;
  - context assembled just in time, not pre-stuffed.
- For an "LLM-native" work app, the harness becomes the application kernel. The UI is a set of views over the session log, the tools, and the artifacts the agent produces.
- "Good harness" criteria that recur across sources:
  - thin, and deleted as models improve;
  - restartable;
  - durable state stored outside the context window;
  - verification built into the loop;
  - few non-overlapping tools.
- Hooks, permissions and memory are less documented in these sources than the loop and context. Memory is mostly files (progress logs, CLAUDE.md, Notion pages), not a separate vector store.

### Gaps
- Could not fetch OpenAI's harness-engineering and Agents SDK primary pages (403), so OpenAI's specifics on compaction, prompt caching and sandbox policy are unverified here.
- No primary Anthropic text was retrieved on hooks or the permission-mode design in the Agent SDK.

## 2. Products where the LLM drives the whole product, and how UI is organized around the agent

### Takeaway
AI-native browsers (Dia, Comet, ChatGPT Atlas) and agent rebuilds of work apps (Notion 3.0) are the clearest 2025–26 examples. Karpathy's "partial autonomy app" framing (June 2025) is the most cited design model: the app manages context, orchestrates several model calls, offers a GUI built for fast human verification, and has an "autonomy slider".

### Cited Findings
- Karpathy, "Software 3.0" talk (YC AI Startup School, June 2025), on partial autonomy apps (Cursor is the main example):
  - They manage context for the model.
  - They orchestrate multiple model calls.
  - They provide a GUI that makes verification easier.
  - They include an autonomy slider, from autocomplete to file-level to repo-wide changes.
  - He warns against over-ambitious full autonomy and favors incremental, auditable steps. Because generation is now faster than human review, the generate-verify loop is the thing to speed up.
  - Sources: [Analytics Vidhya](https://www.analyticsvidhya.com/blog/2025/06/andrej-karpathy-on-the-rise-of-software-3-0/); [Latent Space recap](https://www.latent.space/p/s3); [travis.media](https://travis.media/blog/software-3-0-ai-changing-programming-karpathy)
- Notion 3.0 (Sept 2025):
  - Notion rebuilt its AI as agents that run multi-step work for 20+ minutes across hundreds of pages, with memory stored *in Notion pages and databases*.
  - Users set up personal agents with custom instructions. Team "Custom Agents" were announced as running on schedules or triggers.
  - The release added MCP-based integrations and row-level database permissions.
  - Sources: [Notion blog](https://www.notion.com/es/blog/introducing-notion-3-0); [The Decoder](https://the-decoder.com/notion-3-0-introduces-ai-agents-for-documents-workflows-and-team-automation/); [Thurrott](https://www.thurrott.com/?p=326867)
- A designer's commentary (non-authoritative) notes that Notion agent actions can be reverted, giving a safety net. — [LinkedIn commentary](https://fr.linkedin.com/in/lerouxana)
- Atlassian agreed to buy The Browser Company (Dia) for $610M in cash and positions Dia as its browser for work. — [Yahoo Finance/Reuters](https://finance.yahoo.com/news/atlassian-bets-ai-browsers-610-131316553.html)
- Perplexity Comet:
  - Launched July 2025.
  - Sources disagree on when it went free: Oct 2, 2025 per one source, "since March" per another.
  - It is described, with no hard numbers, as one of the two most-adopted AI browsers alongside ChatGPT Atlas.
  - Gemini in Chrome and Edge Copilot add similar features to incumbent browsers.
  - Sources: [composite.com](https://composite.com/blog/best-new-ai-browsers); [composite.com Comet review](https://composite.com/blog/perplexity-comet-reviews-pricing-alternatives)
- Amazon sued Perplexity in Nov 2025 over Comet's shopping agent, described as the first legal challenge to agentic-browser technology. — [composite.com](https://composite.com/blog/best-new-ai-browsers)
- ChatGPT Atlas's "agent mode" acts inside the user's own browser session. — [OpenAI: Hardening Atlas](https://openai.com/index/hardening-atlas-against-prompt-injection)
- The Codex harness backs CLI, cloud, and IDE surfaces from one agent loop. — [OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop)

### Inferences
- UI patterns organized around the agent rather than around documents:
  - a persistent agent or chat pane next to the work surface;
  - task and session lists, i.e. agent runs as the main object;
  - review and verification views (diffs, revert);
  - agent memory stored as ordinary user-visible artifacts (Notion pages, CLAUDE.md, progress files), not hidden state;
  - scheduled or triggered background agents.
- "Intelligence built in" products still keep the traditional document or browser surface. They add the agent as a co-equal actor on that surface rather than replacing it, which matches Karpathy's partial-autonomy framing.

### Gaps
- No reliable usage numbers for Dia, Comet or Atlas.
- Nothing found on Linear's agent product design. The search returned no Linear-specific material.
- No primary product-engineering blog posts from Dia or Cursor were retrieved.

## 3. Onboarding and model access: BYO key vs subscription sign-in, routing, policy constraints

### Takeaway
By October 2026 the two leading labs have opposite policies:
- **Anthropic** forbids using Claude Free/Pro/Max subscription OAuth tokens in third-party tools, including apps built on its own Agent SDK. It enforced this in stages from January to April 2026.
- **OpenAI** (late Sept 2026) launched "Sign in with ChatGPT", which lets Plus/Pro subscribers spend their included usage in partner tools, with per-app weekly caps.

So a third-party LLM-native app's onboarding is "connect your ChatGPT account" or "paste an API key" on one side, versus "API key only" (or Bedrock/Vertex/gateway access) for Claude.

### Cited Findings
- Anthropic's Feb 2026 clarification: OAuth tokens from Free, Pro and Max "are intended exclusively for Claude Code and Claude.ai", and use in "any other products, tools, or services, including the Agent SDK" is unauthorized. Agent SDK developers should use API keys. — [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/); [GIGAZINE](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block); [AlternativeTo](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)
- Technical blocking of Max OAuth in third-party clients reportedly began Jan 9, 2026. From Apr 4, 2026 (12pm PT), Pro/Max limits could no longer power third-party harnesses such as OpenClaw. Anthropic cited "outsized strain" on its infrastructure. — [Cybersecurity News](https://cybersecuritynews.com/claude-ends-openclaw-subscriptions/); [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/642/anthropic-blocks-openclaw-third-party-tools-claude-subscriptions)
- Unverified: an unofficial report says that around Apr 22, 2026 Anthropic staff said CLI usage was "allowed again". OpenClaw's founder called it "theoretically allowed but practically still blocked." — [kocpc](https://en.kocpc.com.tw/?p=3671)
- Commentary frames a consumer subscription as "not a developer credential". — [yage.ai](https://yage.ai/share/claude-code-subscription-not-a-developer-credential-en-20260321.html)
- OpenAI "Sign in with ChatGPT" for third-party tools (late Sept 2026; articles dated Sep 29 and Oct 2):
  - Plus/Pro users use their existing subscription allowance instead of an API key.
  - Requests draw on the ChatGPT/Codex usage already in the plan, and users can set weekly caps per app.
  - When limits are hit, included usage *stops*; it does not silently switch to the app's own billing.
  - A plain login shares only name, email and avatar, not chats, memories or files.
  - It is built on OAuth 2.0 / OpenID Connect.
  - Reported partners: OpenCode, OpenClaw, Pi, T3, Hyperagent, Hermes Agent, Vorflux, Amp, Dactyl, Kilo Code, Warp, Conductor, Devin, Notion and Vercel; Lovable "coming soon".
  - I could not retrieve OpenAI's own announcement, and The New Stack's body text was truncated.
  - Sources: [IT Brief UK](https://itbrief.co.uk/story/openai-launches-chatgpt-sign-in-for-16-partner-tools); [Trending Topics](https://www.trendingtopics.eu/sign-in-with-chatgpt-tokens-other-apps/); [The New Stack headline](https://thenewstack.io/sign-in-with-chatgpt/)
- Earlier signal: TechCrunch reported in May 2025 that OpenAI was exploring "Sign in with ChatGPT" for other apps. — [TechCrunch](https://techcrunch.com/2025/05/27/openai-may-soon-let-you-sign-in-with-chatgpt-for-other-apps/)
- Codex itself supports signing in with a ChatGPT account or with an API key. — [OpenAI Codex auth docs](https://developers.openai.com/codex/auth)
- Before the official program, community plugins let OpenCode use ChatGPT/Codex subscriptions through OAuth, "for personal development use only". — [GitHub: opencode-openai-codex-auth](https://github.com/jxstanford/opencode-openai-codex-auth)
- Multi-provider fallback and routing (secondary, vendor-adjacent sources):
  - Retry on 429, 503 or timeout against a secondary model.
  - Use circuit breakers and timeouts.
  - Note that a three-model fallback chain can take more than 10 seconds in the worst case.
  - Fallback models behave differently from the primary.
  - OpenRouter is cited as an aggregator with simple fallback configuration.
  - Source: [tkmxai](https://www.tkmxai.it.com/how-to-build-resilient-ai-apps-with-an-llm-api-and-automatic-model-fallback) (marketing-adjacent; treat with caution)

### Inferences
- Subscription sign-in removes the biggest onboarding hurdle for consumers and prosumers: getting an API key, entering a card, and facing pay-per-token cost anxiety. Per-app caps and "stop, don't bill" behavior answer cost-transparency concerns.
- For Claude, a third-party app must do one of the following:
  - use API keys, cloud (Bedrock/Vertex), or enterprise gateways;
  - drive the official Claude Code client as a subprocess (the policy status of this is ambiguous, and enforcement has changed over time);
  - avoid Claude subscriptions altogether.
- Onboarding must therefore be provider-aware, and should support at least: ChatGPT sign-in, API keys for several providers, and possibly local or gateway endpoints.
- Lab policy can change with little notice (Jan → Feb → Apr 2026 for Anthropic). An app should not depend on a single subscription-auth path.

### Gaps
- No user-preference survey data comparing BYO key with subscription sign-in.
- Not researched: Gemini/Google account-based third-party access, and local-model onboarding (Ollama, LM Studio).
- OpenAI's official announcement text was not retrieved.

## 4. When the model is unavailable, slow, or wrong

### Takeaway
Primary sources recommend:
- architectural resilience: a stateless, restartable harness over a durable session log, plus lazy provisioning for latency;
- verification inside the loop: tests and evaluator agents;
- reversible actions.

Provider fallback chains are a common pattern, but they trade latency and behavioral consistency for availability.

### Cited Findings
- The stateless harness recovers from crashes by replaying the append-only session log. Sandboxes are disposable. Lazy container provisioning cut p50 TTFT about 60% and p95 over 90%. — [Anthropic Engineering](https://anthropic.com/engineering/managed-agents)
- Long-running harnesses rely on continuous verification (tests after major changes) and progress files to resume after context resets. — [mejba.me](https://www.mejba.me/blog/anthropic-long-running-agent-harness)
- Anthropic's planning/generation/evaluation split uses a separate evaluator agent to catch bad output. — [InfoQ](https://infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)
- The Agent SDK loop explicitly ends each step with "verify work". — [Claude blog](https://claude.com/resources/articles/building-agents-with-the-claude-agent-sdk)
- Use deterministic *workflows* where the task is well defined, and agents only where flexibility pays. Agentic systems cost more in latency and cost (Dec 2024, older). — [Anthropic](https://www.anthropic.com/research/building-effective-agents)
- Notion's agent actions are revertible (secondary). — [LinkedIn commentary](https://fr.linkedin.com/in/lerouxana)
- Fallback chains, circuit breakers and timeouts (secondary, vendor-adjacent). — [tkmxai](https://www.tkmxai.it.com/how-to-build-resilient-ai-apps-with-an-llm-api-and-automatic-model-fallback)
- Production harnesses need retry limits, crash-safe state, and proof that tests actually ran. — [Towards AI](https://pub.towardsai.net/harness-engineering-for-ai-coding-agents-from-prompts-to-production-ready-systems-db8a3fc12e6e)

### Inferences
- An LLM-native app should keep its core surfaces (files, documents, terminals, the browser) fully usable without the model. Agent state should be persisted so that work resumes when the model returns.
- A deterministic path should exist for routine operations.
- Wrongness is handled through verification UIs (diffs, previews, revert) more than through model choice.

### Gaps
- No primary sources on response caching or determinism strategies (e.g. prompt caching for consistency).
- No source on UX patterns for communicating model outages to users.

## 5. Exposing tools/capabilities (MCP, computer use, browser) and security

### Takeaway
MCP has become the default way to extend agents (Notion 3.0 adopted it, for example). The security consensus is that prompt injection is unsolved:
- OpenAI says it may never be fully solved for browser agents.
- Simon Willison's "lethal trifecta" (private data + untrusted content + external communication) is the standard threat model.
- MCP's mix-and-match design makes the trifecta easy to assemble.

The main mitigations are OS-level sandboxing, keeping credentials outside the sandbox, egress limits, and permission tiers.

### Cited Findings
- Willison (June 16, 2025):
  - The lethal trifecta is access to private data, exposure to untrusted content, and the ability to communicate externally.
  - Vendor claims of blocking "95% of attacks" are "very much a failing grade" by web-security standards.
  - End users mixing tools can only stay safe by avoiding the combination.
  - MCP "encourages users to mix and match tools from different sources", and each tool may supply one leg of the trifecta.
  - Source: [Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- Documented exploits listed in coverage include Microsoft 365 Copilot, GitHub's MCP server, and ChatGPT (2023–Feb 2025). — [aiweekly](https://aiweekly.co/alerts/willison-names-lethal-trifecta-behind-ai-agent-data-leaks)
- OpenAI, "Hardening ChatGPT Atlas against prompt injection" (Dec 22, 2025):
  - Its automated red teaming found a new class of injection, which it addressed with an adversarially trained model and stronger safeguards.
  - It calls prompt injection "a long-term AI security challenge".
  - Example attack: a malicious email tells the agent, while it summarizes the inbox, to forward the user's tax documents.
  - Sources: [OpenAI](https://openai.com/index/hardening-atlas-against-prompt-injection); [CyberScoop: "may never be 'solved'"](https://cyberscoop.com/?p=87276)
- Anthropic Claude Code sandboxing (Oct 2025):
  - OS-level filesystem and network isolation "safely reduces permission prompts by 84%" in internal usage (vendor-reported).
  - It replaces per-action approval with predefined boundaries.
  - Supported on macOS and Linux/WSL2.
  - Experts note it does not eliminate prompt injection. Enterprises still need container isolation, egress controls, credential scoping, and audit logging.
  - Sources: [Anthropic Engineering](https://anthropic.com/engineering/claude-code-sandboxing); [TrueFoundry](https://www.truefoundry.com/blog/claude-code-sandboxing)
- Managed Agents keeps tokens in a vault or behind a proxy so generated code never sees credentials. — [Anthropic Engineering](https://anthropic.com/engineering/managed-agents)
- Notion 3.0 added MCP integrations and row-level permissions. — [The Decoder](https://the-decoder.com/notion-3-0-introduces-ai-agents-for-documents-workflows-and-team-automation/)
- The Amazon v. Perplexity lawsuit over Comet's shopping agent adds a legal and terms-of-service dimension to browser control. — [composite.com](https://composite.com/blog/best-new-ai-browsers)

### Inferences
- An LLM-native workspace with a browser, the user's files, and outbound network access has all three legs of the trifecta by default. The trifecta has to be cut in the architecture:
  - per-session egress allowlists;
  - credential proxies;
  - separating agents that read untrusted content from agents that hold secrets;
  - human confirmation for exfiltration-capable actions.
- Sandboxing is the UX lever for autonomy: well-defined boundaries remove prompt fatigue, which would otherwise push users toward "allow all".

### Gaps
- Not covered: MCP spec-level security changes in 2025–26 (auth, tool annotations) and computer-use-specific safety documentation.

## 6. Arguments for and against "intelligence everywhere"

### Takeaway
**For:** harnesses let one general agent replace many bespoke features. Context engineering and sub-agents make long tasks feasible, and reported productivity gains are large (vendor-reported).

**Against:** latency and cost (acknowledged by Anthropic itself), unpredictability, unsolved security, and a 2025–26 consumer backlash against AI features "nobody asked for". The recurring middle ground is Karpathy's partial autonomy with a user-controlled autonomy slider, plus Anthropic's "simplest solution possible".

### Cited Findings
- **For:**
  - OpenAI's internal harness-engineering experiment: about 1M lines with no hand-written code over five months (self-reported). — [InfoQ](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex)
  - Notion agents run 20+ minute multi-step tasks across hundreds of pages. — [Thurrott](https://www.thurrott.com/?p=326867)
- **Against, from the builders themselves:**
  - Agentic systems "trade latency and cost for better task performance"; sometimes the right answer is "not building agentic systems at all" (Dec 2024). — [Anthropic](https://www.anthropic.com/research/building-effective-agents)
  - Karpathy warns against over-ambitious full autonomy and favors auditable steps with an autonomy slider. — [Analytics Vidhya](https://www.analyticsvidhya.com/blog/2025/06/andrej-karpathy-on-the-rise-of-software-3-0/)
  - Harness scaffolding becomes "dead weight" as models improve, so over-engineering around the model has a maintenance cost. — [Anthropic Engineering](https://anthropic.com/engineering/managed-agents)
- **Security:** prompt injection may never be fully solved for browser agents. — [CyberScoop](https://cyberscoop.com/?p=87276); [Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- **Consumer backlash:**
  - Meltwater: "AI slop" mentions rose ninefold in 2025, with negative sentiment peaking at 54% in October. — [Euronews](https://euronews.com/next/2025/12/28/2025-was-the-year-ai-slop-went-mainstream-is-the-internet-ready-to-grow-up-now)
  - Commentary on AI features nobody asked for (e.g. Recall), and CES 2026 "Worst in Show" AI gadgets. — [TechRadar](https://www.techradar.com/computing/artificial-intelligence/from-novelty-to-nuisance-the-ai-revolution-no-one-wanted-is-sweeping-all-before-it); [Yuma Sun/AP](https://www.yumasun.com/news/national_news/ap-trending-summarybrief-at-5-17-p-m-est/article_b77efdd4-90c4-5fcc-95bf-71292f2f5058.html)
  - Willison frames the backlash as a crisis of trust. — [Simon Willison ai-backlash tag](https://simonwillison.net/tags/ai-backlash/)
  - A counterpoint from one analyst: quiet, useful AI features such as Amazon review summaries are well received. — [TechRadar](https://www.techradar.com/computing/artificial-intelligence/from-novelty-to-nuisance-the-ai-revolution-no-one-wanted-is-sweeping-all-before-it)

### Inferences
- Backlash targets *imposed* AI in consumer products. Work tools where the user deliberately connects a model and directs an agent are a different case, but the trust lesson still applies:
  - make the agent's actions visible and revertible;
  - give users an autonomy dial;
  - keep a fast non-AI path.
- Cost visibility (per-app caps, as in Sign in with ChatGPT) and latency (lazy provisioning, just-in-time context) are the concrete levers that make "intelligence everywhere" tolerable.

### Gaps
- No quantitative studies found on latency tolerance or cost complaints specific to LLM-native work apps.
- No HN or Latent Space discussion threads were retrieved directly.
