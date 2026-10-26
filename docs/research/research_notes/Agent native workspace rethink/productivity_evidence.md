# Quantitative Evidence on Productivity and Output Quality of AI Agent-Assisted Work (2025–2026)

Scope note: These notes cover research published through October 2026. Studies run on 2024 tools are marked **[OLDER DATA]**. Many telemetry figures come from vendors that sell measurement or review tools; those are marked **[VENDOR]**. Where secondary coverage gave numbers that differ from each other, both are listed.

## 1. Controlled studies (RCTs and field experiments) and the gap between perceived and measured productivity

### Takeaway
The best-controlled evidence disagrees. Enterprise RCTs on 2024 completion/chat tools found speedups of roughly 20–26%. METR's 2025 RCT with experienced open-source maintainers found a 19% *slowdown*, even though participants believed AI had sped them up by about 20%. METR's 2025–26 follow-up could not produce a reliable estimate, because developers increasingly refused to work without AI. That refusal is itself a signal of perceived value, though not a measurement of it.

### Cited Findings
- **METR early-2025 RCT** (data collected Feb–Jun 2025): 16 experienced open-source developers, each working on mature repos they maintain, with tasks randomized to AI-allowed or AI-disallowed. Tasks took 19% longer with AI (95% CI +2% to +39%). Developers had forecast a speedup of about 24% beforehand and still believed afterward that AI had sped them up by about 20%. That is roughly a 40-point gap between perception and measurement. — [METR original study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); re-estimated CI per [METR Feb 2026 update](https://metr.org/blog/2026-02-24-uplift-update/); coverage in [LeadDev](https://leaddev.com/velocity/ai-doesnt-make-devs-as-productive-as-they-think-study-finds)
- **METR follow-up** (started Aug 2025, published Feb 24 2026): 57 developers (10 returning, 47 new), 143 repos, 800+ tasks, median 10 years of experience, pay cut from $150/hr to $50/hr. Estimated speedup for returning developers was +18% (CI −38% to +9% in METR's sign convention, i.e. the interval crosses zero). For new recruits it was +4% (CI −15% to +9%). METR calls this "very weak evidence" of an increase in speedup. — [METR](https://metr.org/blog/2026-02-24-uplift-update/)
- Problems METR reports with the follow-up design:
  - 30–50% of developers withheld tasks they did not want to do without AI.
  - Developers who are optimistic about AI and tasks with high uplift were less likely to enter the study, so METR treats the estimate as a likely lower bound.
  - Some developers abandoned AI-disallowed tasks; one completed none of them.
  - Time tracking was unreliable for developers running several agents at once.
  - Task substitution and quality differences between conditions undermine time-on-task comparisons.
  - METR is moving to shorter, intensive experiments, randomization at the developer level, fixed-task experiments and observational data. It notes that about 4% of GitHub commits are authored by Claude Code. — [METR](https://metr.org/blog/2026-02-24-uplift-update/)
- **METR survey** (Feb–Apr 2026): 349 technical workers, 87 of them software engineers. The median self-reported change in the value of work due to AI was 1.4–2x. METR flags reasons to be skeptical of the magnitude. — [METR](https://metr.org/blog/2026-02-24-uplift-update/); survey details per [secondary coverage](https://www.i-programmer.info/news/99-professional/18910-perceived-value-of-ai-tools.html)
- **Google enterprise RCT** (Paradis et al., ICSE 2025) **[OLDER DATA: summer 2024 internal tools]**: 96 Google engineers on a complex enterprise task, with and without three AI features (code completion, smart paste, NL-to-code). The estimated time reduction was about 21% (raw means 96 min with AI vs 114 min without), with a wide confidence interval. Developers who spend more hours a day coding gained more. — [arXiv 2410.12944](https://arxiv.org/abs/2410.12944v3)
- **Microsoft / Accenture / Fortune-100 field experiments** (Cui, Demirer, Jaffe, Musolff, Peng, Salz; SSRN working paper dated Aug 2025) **[OLDER DATA: 2022–2024 Copilot completions, not agents]**:
  - Three company-run randomized rollouts covering 4,867 developers. The pooled result was +26.08% completed tasks (SE 10.3%).
  - Less experienced developers adopted more and gained more.
  - The Microsoft arm ran 7 months and the Accenture arm 4 months.
  - I found no journal publication. — [SSRN](https://papers.ssrn.com/abstract=4945566); [MIT Sloan](https://mitsloan.mit.edu/ideas-made-to-matter/how-generative-ai-affects-highly-skilled-workers)

### Inferences
- The perception gap is the most robust qualitative result. Self-reports overstate measured speedups in the one study that measured both. Survey "productivity" numbers below should therefore be read as perceived productivity.
- Where controlled studies find gains, the conditions are enterprise or unfamiliar codebases, junior developers, or well-scoped tasks. The losses appear with experts on large, mature codebases they already know well.
- The agent era (late 2025 onward) breaks the classic RCT design. Concurrent agents make time-on-task poorly defined, and control-arm compliance collapses. Rigorous measured evidence for *agentic* (as opposed to completion) tools remains thin.

### Gaps
- I found no published, well-powered RCT of autonomous coding agents (Claude Code, Codex, Copilot agent) on real-world tasks with measured outcomes, as of October 2026.
- I did not find any Accenture-only or Microsoft-only 2025–26 agent study with disclosed metrics beyond the working paper above.

## 2. Large surveys: adoption, trust, perceived productivity

### Takeaway
Adoption is near-universal: 85–90% of developers use AI regularly. Agent use roughly doubled from 2025 to 2026, and Claude Code is now the top agent tool in the Stack Overflow 2026 survey. Trust remains conditional or low: most developers verify output and complain of "almost right" code. Large majorities perceive productivity gains, but these are self-reports from self-selected samples.

### Cited Findings
- **DORA 2025 "State of AI-assisted Software Development"** (released Sep 23 2025):
  - Sample: nearly 5,000 technology professionals plus over 100 hours of qualitative data.
  - Use: 90% use AI, up 14% year over year. Respondents spend a median of about 2 hours a day with AI.
  - Perceived effects: over 80% say AI improved their productivity, and 59% say it improved code quality.
  - Trust: about 30% (roughly a third) trust AI-generated code little or not at all. — [Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report?e=48754805); [Google blog](https://blog.google/technology/developers/dora-report-2025/); [DevOps.com](https://devops.com/dora-2025-faster-but-are-we-any-better/)
- DORA 2025 delivery findings:
  - For the first time, AI adoption correlates *positively* with software delivery throughput, a reversal from 2024.
  - AI adoption *still* correlates with higher delivery instability: more change failures, more rework, longer time to resolve.
  - DORA's thesis is that "AI is an amplifier" of existing organizational strengths and weaknesses. It introduces a seven-capability DORA AI Capabilities Model.
  - Sampling is self-selected, which methodologists flag as a limit on generalization. — [InfoQ](https://www.infoq.com/news/2025/09/dora-state-of-ai-in-dev-2025); [Splunk review](https://www.splunk.com/en_us/blog/learn/state-of-devops); [RDEL](https://rdel.substack.com/p/rdel-112-whats-ais-impact-on-software)
- **Stack Overflow Developer Survey 2025** (Jul 29 2025, 49,000+ responses from 177 countries):
  - Adoption: 84% use or plan to use AI, up from 76%.
  - Trust: 46% distrust AI accuracy, up from 31%. Only about 3% "highly trust" it.
  - Favorability fell to about 60% from about 72%.
  - 66% cite "AI solutions that are almost right, but not quite" as a problem.
  - Agents: 31% use agents, 17% plan to and 38% do not plan to. Among agent users, 69% report increased productivity. — [Stack Overflow press release](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/); [InfoWorld](https://infoworld.com/article/4031673/ai-use-among-software-developers-grows-but-trust-remains-an-issue-stack-overflow-survey.html)
- **Stack Overflow pulse survey, April 2026**: agent use reached about 59%, nearly double the 2025 figure of 31%. Claude Code usage rose from 41% to 55% in this pulse. — [IT Brief](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats) (secondary)
- **Stack Overflow Developer Survey 2026** (published Oct 6 2026, 30,000+ respondents over seven weeks):
  - Daily use: 73% of those who use AI coding assistants or agents use them daily. About 31% use AI tools 4+ hours a day (chart labels are ambiguous).
  - Tools: 66% of AI users use coding agents and 63% use chatbots. Top agent tools are Claude Code at 66% and GitHub Copilot at 59%.
  - Sentiment: 62% view AI at least somewhat positively, rising to 71% among daily users. 93% say source attribution is required for trust.
  - Priorities: developers rank quality (75%) above cost (38%) when choosing models.
  - The main article reports no quantitative productivity figure. — [Stack Overflow blog](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
- Stack Overflow 2026, trust and verification (secondary):
  - Of 14,304 respondents to the trust question, 48% trust AI when they can easily verify its output. Only 6.6% trust it for important decisions.
  - 76.5% run AI-generated code locally before using it; only 9.6% use it as-is.
  - Only 24% say their employer has approved tools or an AI policy. — [IT Brief](https://itbrief.co.uk/story/stack-overflow-survey-shows-developers-trust-ai-with-caveats) (secondary; verify against the primary source)
- **JetBrains State of Developer Ecosystem 2025** (24,534 respondents from 194 countries, Apr–Jun 2025):
  - 85% regularly use AI, and 62% rely on at least one AI coding assistant or agent daily.
  - Nearly 90% of AI users save at least 1 hour a week, and about 1 in 5 save 8+ hours a week.
  - 74% cite increased productivity and 73% faster repetitive tasks.
  - Concerns include inconsistent code quality, lack of context and skill atrophy. — [JetBrains Research](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/); [InfoWorld via scour](https://scour.ing/p/https://www.infoworld.com/article/4077352/85-of-developers-use-ai-regularly-jetbrains-survey.html); [heise](https://heise.de/-10771317)
- **GitHub Octoverse 2025** (Oct 28 2025):
  - A record 518.7M PRs were merged (+29% YoY), about 43.2M a month, up from about 35M in 2024.
  - GitHub ties the rise in timing to the Copilot coding agent preview (March 2025) and Copilot code review (April 2025). This is correlation, not causation.
  - 80% of new GitHub developers use Copilot in their first week. — [GitHub blog](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)

### Inferences
- Trust and usage are diverging: use rises while trust stays flat or falls. Developers treat AI output as something to verify, which pushes cost downstream into review (see section 3).
- 2026 is the first survey year in which agentic tools, rather than autocomplete, are the dominant mode of AI use among respondents.

### Gaps
- I did not locate a DORA 2026 report or a JetBrains 2026 ecosystem report with agent-specific productivity numbers as of this research.
- I found no agent-only time-savings breakdown in JetBrains 2025.

## 3. Code-quality telemetry: churn, duplication, bugs, incidents, PR size, review time

### Takeaway
Telemetry consistently shows more output: more PRs and larger PRs. It also shows rising quality costs: more duplication, less refactoring, more bugs per PR, review times that grow much faster than output, and flat organization-level DORA metrics. Most of this data comes from vendors and shows correlation rather than causation.

### Cited Findings
- **GitClear 2025 AI Copilot Code Quality report** **[VENDOR; data 2020–2024]**:
  - Data: 211M changed lines, about two-thirds from private-company customers (opt-in) and one-third from open source.
  - Duplication: during 2024, code blocks of 5+ lines duplicating adjacent code became 8x more frequent.
  - Refactoring: moved/refactored lines fell from about 25% of changes in 2021 to under 10% in 2024. 2024 was the first year in which copy/paste exceeded moved code.
  - Churn rose from 3.3% (2021) to 5.7% (2024). A secondary source cites 7.1% for 2025, which does not match GitClear's data window and should be treated with caution. — [LeadDev](https://leaddev.com/technical-direction/how-ai-generated-code-accelerates-technical-debt); [i-programmer](https://www.i-programmer.info/news/105-artificial-intelligence/17871-gitclear-reveals-ais-negative-impact-on-code-quality.html); conflicting churn figure from [Larridin](https://larridin.com/developer-productivity-hub/code-churn-ai-era-doubled)
- **Faros AI "AI Productivity Paradox"** (Jul 2025) **[VENDOR]**:
  - Data: telemetry from 10,000+ developers across 1,255 teams.
  - Developers with high AI adoption completed more tasks and merged more PRs.
  - Costs: review time rose 91%, PR size rose 154%, and bugs per developer rose about 9%.
  - There was no measurable improvement in organization-level DORA metrics. Faros attributes this to bottlenecks in review, testing and deploy. — [Rob Bowley summary](https://blog.robbowley.net/2025/08/21/new-research-shows-ai-assisted-coding-isnt-moving-delivery/); [Faros](https://faros.ai/research)
- **Faros "AI Acceleration Whiplash" / AI Engineering Report 2026** **[VENDOR]**:
  - Data: two years of telemetry from 22,000 developers across 4,000 teams.
  - Reported: PR size +51%, bugs per PR +28%, median review time 5x.
  - Another Faros page instead reports bugs per developer +54%, so Faros's own figures are inconsistent. — [Faros research](https://faros.ai/research/ai-acceleration-whiplash); [ADTmag](https://adtmag.com/articles/2026/04/22/more-code-more-bugs.aspx)
- **CodeRabbit "State of AI vs Human Code Generation"** (Dec 17 2025) **[VENDOR]**:
  - Sample: 470 open-source GitHub PRs (320 labelled AI-co-authored, 150 human-only).
  - Issues: AI PRs averaged about 10.83 issues vs 6.45 for human PRs, about 1.7x more. Critical issues were 1.4x more common and major issues 1.7x.
  - By category: logic/correctness 1.75x, maintainability 1.64x, security 1.57x, performance 1.42x. Other coverage reports readability above 3x and some performance issues about 8x, with differing definitions.
  - Limitations: small sample, labelling depends on self-disclosure, and the issues were detected by CodeRabbit's own AI reviewer. — [CodeRabbit](https://coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report); [The Register](https://www.theregister.com/2025/12/17/ai_code_bugs/); [DevOps.com](https://devops.com/?p=180899)
- **Cortex** (cited alongside CodeRabbit) **[VENDOR]**: PRs per author +20% YoY, while incidents per PR rose 23.5%. — [The Register](https://www.theregister.com/2025/12/17/ai_code_bugs/)
- **DORA 2025**: AI adoption correlates with higher instability (change failure, rework). — [InfoQ](https://www.infoq.com/news/2025/09/dora-state-of-ai-in-dev-2025)
- **Uplevel** **[OLDER DATA, 2024]**: I could not verify it in this session. The widely cited figure is about 41% more bugs with Copilot and no throughput gain, from roughly 800 developers. Listed as a gap.

### Inferences
- The bottleneck has moved from writing code to reviewing and verifying it. Larger PRs and review times growing many times over mean individual speedups are absorbed before they reach delivery metrics.
- Duplication and declining refactoring point to accumulating maintainability debt. This is a lagging cost that short-run productivity studies will not capture.

### Gaps
- There is no independent, non-vendor, peer-reviewed telemetry study of agent-era (2026) incident rates.
- I could not verify the Uplevel 2024 figures in this session.
- GitClear has published no 2026 update (agent-era data) that I could confirm.

## 4. Where gains concentrate and where losses appear

### Takeaway
Gains concentrate in juniors and less-experienced developers, unfamiliar or enterprise codebases, scoped and repetitive tasks (boilerplate, debugging, new tools), and work that "would not have been done otherwise." Losses or null effects show up with experts on large, mature codebases they know deeply, and at the organization level where review, testing and stability become constraints.

### Cited Findings
- In the Cui et al. field experiments, less experienced developers showed higher adoption and larger gains. — [SSRN](https://papers.ssrn.com/abstract=4945566)
- METR found a slowdown specifically among experienced maintainers (median 10 years, roughly 5 years on their repos) working on large, mature repositories. — [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
- In Google's RCT, developers who code more hours per day saw larger gains. — [arXiv](https://arxiv.org/abs/2410.12944v3)
- **Anthropic internal study** (published Dec 2 2025; survey of 132 engineers and researchers in Aug 2025, 53 interviews, Claude Code usage data):
  - Self-reported: Claude is used in about 59% of work, with a 50% productivity gain, more than double the prior year.
  - 27% of Claude-assisted work "would not have been done otherwise."
  - Engineers could fully delegate only 0–20% of tasks. Debugging is the most common use (55%).
  - Concerns include skill erosion and mentorship.
  - The percentages above come from secondary summaries. — [Anthropic](https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic); [SHRM](https://www.shrm.org/in/topics-tools/flagships/ai-hi/quick-hits-december-15); [Interview Query](https://www.interviewquery.com/p/anthropic-ai-skill-erosion-report)
- Stack Overflow 2026: the most common AI tasks are generating code in familiar areas (67%), debugging (61%), and production ops and troubleshooting (20%). — [Stack Overflow](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)
- DORA 2025: gains depend on platform quality, workflow clarity and the strength of the existing organization. Weak teams see their problems amplified. — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report?e=48754805)

### Inferences
- A key value lever is *task substitution*: new or unattempted work and parallel agent runs. Time-on-task RCTs undercount this, while surveys and value-of-work measures overcount it.
- Agent workspaces aim to supply verification, review throughput and context for large codebases. That is where the evidence shows losses.

### Gaps
- I found no quantified breakdown of greenfield vs legacy work or of results by codebase size, beyond the contrast between METR and the enterprise RCTs.

## 5. Knowledge work beyond code

### Takeaway
Field experiments show sizeable quality gains for knowledge workers: the P&G "cybernetic teammate" study found an individual with AI matched a two-person team. Anthropic's usage-based estimates suggest large per-task time savings (about 80%), but these are model-estimated and exclude verification time. Augmentation is still slightly more common than automation in consumer use, while enterprise API use is mostly automation.

### Cited Findings
- **P&G "Cybernetic Teammate"** (Dell'Acqua, Mollick et al.; NBER w33641, 2025; later in Organization Science) **[models: GPT-4/4o, run in 2024]**:
  - Design: pre-registered field experiment with 776 P&G professionals (the published version says 791), on real product-innovation tasks, individually or in pairs, with or without AI.
  - Quality: individuals with AI gained +0.37 SD, matching teams without AI (+0.24 SD). Teams with AI gained +0.39 SD.
  - AI reduced functional silos (R&D vs commercial) and improved positive emotions. — [NBER](https://www.nber.org/papers/w33641); [INFORMS](https://pubsonline.informs.org/doi/10.1287/orsc.2025.20702); [One Useful Thing](https://www.oneusefulthing.org/p/the-cybernetic-teammate)
- **Anthropic "Estimating AI productivity gains from Claude conversations"** (Nov 2025):
  - Method: 100,000 Claude.ai conversations. Tasks estimated at about 90 minutes without AI had their time cut by about 80% (model-estimated).
  - Extrapolated effect: +1.8%/year in US labor productivity growth over a decade, which Anthropic says is not a forecast.
  - The estimate excludes time spent outside the conversation verifying output.
  - A third party reports that a reliability adjustment roughly halves the gain to about +1.0pp, unverified against the primary source. — [Anthropic](https://www.anthropic.com/research/estimating-productivity-gains); [CIO](https://www.cio.com/article/4097750/anthropic-highlights-productivity-gains-from-use-of-claude.html); [Gend](https://www.gend.co/blog/anthropic-ai-productivity-field-evidence)
- **Anthropic Economic Index** (Jan 2026 report on Nov 2025 data):
  - Claude.ai interactions were about 52% augmentation vs 45% automation, after automation briefly led in Aug 2025.
  - First-party enterprise API use is about 75% automation.
  - The top 10 tasks account for about 24% of conversations (32% on the API), and software tasks dominate.
  - The Feb 2025 baseline was 57% augmentation vs 43% automation. — [arXiv 2511.15080 (Sep/Nov 2025 report)](https://arxiv.org/pdf/2511.15080); figures via [Let's Data Science](https://www.letsdatascience.com/news/anthropic-finds-ai-augments-rather-than-replaces-e57396e7) (secondary)
- The original BCG/Harvard "jagged frontier" study (2023) found gains inside the frontier and losses outside it. **[OLDER DATA]** The P&G study above is its main 2025 follow-up from the same group.

### Inferences
- Knowledge-work evidence points to quality gains and to individuals replacing small teams. That supports workspace designs in which one human orchestrates several agents. Verification time remains the unmeasured cost.

### Gaps
- I did not retrieve figures from the Microsoft Work Trend Index 2025/2026 in this session.
- I could not verify an April 2026 Anthropic Economic Index update; only a German blog reports it.

## 6. Cost and economics

### Takeaway
Per-developer AI spend has moved from $10–40 seats to usage-based token bills. Typical agent users run about $150–600 a month, and heavy agentic users run $500–2,000+. Gartner warns costs could exceed developer salaries by 2028. Reliable data on cost per completed task is essentially absent.

### Cited Findings
- **Gartner** (Peer Insights data; press release dated Jun 24 2026):
  - 23% of tech leaders spend $200–500 per developer per month on tokens, and 6% spend more than $2,000.
  - Gartner projects AI coding costs could exceed average developer salaries by 2028. — [Let's Data Science](https://letsdatascience.com/news/gartner-warns-ai-coding-costs-could-exceed-developer-salarie-08897a40) (secondary)
- Claude Code: about $13 per developer per active day, roughly $150–250 a month, is the widely repeated Anthropic figure. I could not retrieve the primary document. — [Exceeds AI](https://blog.exceeds.ai/compare-ai-coding-token-prices) (secondary, vendor)
- All-in seats plus tokens run about $200–600 per engineer per month. The 90th-percentile heavy user is about $691 a month in one trends report. — [DevOps Digest, AI Engineering Trends report](https://devopsdigest.com/10-key-takeaways-on-ai-and-tokenmaxxing-from-the-ai-engineering-trends-report); [Beancount blog](https://beancount.io/blog/2026/07/27/ai-coding-tool-spend-tracking-guide)
- Reported enterprise pullbacks, each from a single chain of secondary reporting:
  - Microsoft reportedly moved engineers off Claude Code after bills reached $500–2,000 per engineer per month.
  - Uber reportedly exhausted its 2026 AI coding budget early. — [WebProNews](https://www.webpronews.com/when-ai-coders-outspend-their-human-overlords/) (unverified)
- Stack Overflow 2026: 38% of organizations set usage limits, 28% reviewed spending data, 27% route different work to different models, 25% limit who can use AI, and 21% report spending more on AI. — [Stack Overflow](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/)

### Inferences
- Combine roughly $200–600 a month of spend with measured org-level gains that are often null (Faros) or small and uncertain (METR, DORA). ROI is unproven at the organization level, and cost controls such as model routing and usage limits are becoming standard. Budget visibility and choosing cheaper models per task are emerging requirements for agent workspaces.

### Gaps
- I found no credible public data on cost per completed task or cost per merged PR for agentic workflows.
- The figures for Anthropic's $13/day, Microsoft and Uber come from secondary sources only.
