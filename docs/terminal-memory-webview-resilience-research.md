# Terminal Memory Governance and WebView Resilience

Status: research handoff — adversarial verification pass COMPLETED 2026-08-08

Date: 2026-08-08

Review markup: blockquotes beginning `⚠️ **Adversarial-review remark (2026-08-08)**`
were added by an independent reviewing agent after the original analysis. They
correct or qualify the surrounding text and take precedence over it. The
reviewer's full verdicts are in "Adversarial review verdicts" below the claim
ledger.

Scope: Canopy PTY lifetime, renderer recovery, terminal process-tree memory,
cross-platform enforcement, and incident observability

Change status: implementation in progress. The periodic browser-snapshot
containment and the renderer-safe PTY ownership/reattachment milestone are
implemented in the current worktree; unchecked entries remain open.

### Production incident captured at 13:44 +0700 (2026-08-08)

The later production incident is no longer an inference. Read-only unified-log
inspection captured the installed pre-fix binary replacing its main renderer at
13:44:25 while the native Canopy host PID `49786` remained alive:

- WebContent PID `89570` reported a 10,948 MiB physical footprint and could not
  shrink below WebKit's 4,096 MiB inactive-process kill threshold.
- WebKit logged `didExceedInactiveMemoryLimit`,
  `processDidTerminateOrFailedToLaunch: reason=ExceededMemoryLimit`, and an
  out-of-memory death. Its counters reported a 7,701 MiB JavaScript heap
  capacity, 4,798 MiB live JavaScript heap, 52,327,938 JavaScript objects, and
  10,758 MiB of dirty `bmalloc` memory.
- WebKit terminated PID `89570`, immediately reloaded page id 8, and launched
  replacement WebContent PID `43665`. The replacement was still alive after the
  capture; the Canopy host had not restarted. At 14:01, 17 minutes after launch,
  `vmmap` measured the replacement at 340.7 MiB physical footprint (410.4 MiB
  peak), about 1.84 million malloc allocations, and 519.9 MiB allocated across
  malloc zones. This sharp reset further isolates the retained state to the old
  renderer rather than the native host.

This proves the proximate cause for this incident: WebKit's public-process
memory protection terminated the oversized main renderer. It also confirms the
damage path in the pre-fix build: WebKit reloads the SPA after an OOM, and that
build's boot-time `pty_kill_all` then destroys terminal progress. It does not by
itself attribute all retained JavaScript objects to one feature; the bounded IO,
hidden-terminal detachment, snapshot disposal, browser ownership, and renderer
continuity changes address separate confirmed retention and blast-radius paths.

### Follow-up event at 14:24 +0700: child WebContent launch, not an IDE restart

A second read-only check was performed after the user reported another apparent
restart in the installed pre-fix build. The OS timeline does **not** show a
second native-app or main-renderer restart in the preceding 35 minutes:

- native Canopy PID `49786` still had its 2026-08-07 14:40 start time;
- main IDE WebContent PID `43665` still had its 13:44:26 replacement start time,
  continued serving page id 8, and had no main-frame provisional/commit load in
  the checked window;
- no matching `ExceededMemoryLimit`, WebProcess termination, or replacement of
  PID `43665` was logged.

At 14:24:28, however, the production host created **another** WebContent PID
`82170` for page id `272513`. WebKit logged a new page/process construction,
made the view visible, completed its main-frame load, then made it invisible at
14:24:31. The process remained alive at the 14:39 sample. No predecessor death
was correlated with this launch. This is evidence of a newly created embedded
browser/preview child that was quickly hidden—not evidence of the IDE renderer
restarting. Its survival while hidden is consistent with the child-WebView
lifecycle/retention class addressed by renderer-generation reconciliation and
orphan cleanup, but the OS logs alone cannot prove whether that specific view
still had a valid frontend owner. If the observed symptom included terminal or
SPA state loss, release-owned lifecycle telemetry is still required to explain
that application-level reset because it did not cross an OS process or main-
frame navigation boundary.

### Critical-pressure episode at 15:53 +0700: live main renderer, separate child reload

A third read-only production check followed another user-visible apparent
restart. This event was severe, but it was **not** another native-host or main
WebContent process replacement:

- native Canopy PID `49786` retained its 2026-08-07 14:40:16 start time;
- main IDE WebContent PID `43665` retained its 13:44:26 start time and was still
  the active main renderer after the episode;
- the preceding 50-minute WebKit timeline contained no main-renderer
  `WebPageProxy::reload`, main-frame provisional/commit load, termination, or
  replacement event.

The OS did record genuine critical pressure. At 15:53:52, WebContent `43665`
received a system VM-pressure-critical notification. WebKit reported one page,
29 `Document` objects, a 759 MiB live JavaScript heap inside 1,084 MiB capacity,
about 9.32 million JavaScript objects, 1,885 MiB of dirty `bmalloc` memory, and a
2,047 MiB physical footprint. The same PID's periodic footprint reading reached
5,547 MiB at 15:58:42, later oscillated above 5 GiB, and then fell sharply
without a process change. This is direct evidence of large, partly reclaimable
renderer-owned state and repeated allocation/reclamation pressure; it is not
evidence that the native Rust host or a terminal process tree owned those bytes.

At 15:55:41 the host separately created child WebContent PID `85686` for page
proxy `275826`, called `WebPageProxy::reload` about 620 ms later, and completed
that child's main-frame load. That child was about 79--89 MiB during the sampled
window and remained an XPC process afterward. The reload belongs to this child,
not to main PID `43665`. As with the older closed AWS child, a surviving idle
WebKit XPC process is not by itself proof that a frontend tab still owns a page;
the leak criterion is retained page/footprint or an untracked native child.
Renderer-generation ownership, pending-open cancellation, orphan reconciliation,
and hidden-frame release address the controllable lifecycle paths, while the
runbook requires footprint and ownership evidence before classifying an idle
helper as leaked.

The reported UI/progress reset therefore remains an **application-level symptom
without an observed WebKit restart boundary**. A React remount, state reset, or
feature-owned recovery cannot be reconstructed from the installed build because
its Canopy file log stopped updating before this interval and it lacks the new
release resilience telemetry. This episode strengthens the renderer-retention
root cause and the rationale for pressure shedding, bounded editor/terminal/IO
retention, and persistent generation/recovery telemetry; those implementations
still require the tests and soaks below. It does not falsify the 13:44 OOM finding
or justify claiming a second renderer death.

### Implementation update — renderer continuity (2026-08-08)

The current worktree now replaces destructive renderer boot cleanup with a
Rust-issued renderer generation. Registering a replacement page detaches the
predecessor's terminal channels, keeps every PTY child alive, and returns live
desktop/remote/detached session metadata for reconciliation. Desktop viewers
have their own attachment generation and outstanding-byte window; stale acks or
late component cleanup cannot affect a replacement viewer. With no viewer, the
reader continues draining into the 256 KiB Rust ring, whose replay now marks
evicted output explicitly.

Every desktop viewer—including a remotely owned terminal—is routed through the
same replaceable attachment, eliminating the prior unscoped broadcast-forwarder
thread. Normal remote-viewer close detaches; restored desktop-owned tab close
still terminates; native application exit still kills all PTYs. The old IPC-wide
kill is now an explicitly named development-only orphan reap and is refused in
release builds.

Renderer registration also closes native preview child WebViews left behind by
a predecessor page. This addresses the observed `docs.aws.amazon.com` WebContent
process surviving after its tab was gone. A normal `browser_close` now removes
its registry entry only after the native close succeeds, so recovery can retry a
failed close instead of losing the only handle to the leaked view. Failed closes
enter one Rust-owned label queue drained by a singleton retry worker with
100 ms--30 s capped backoff; this does not depend on a future renderer reload.
Constant-size counters expose pending labels, worker state, attempts, successes,
and failures without retaining URLs or page content.

The adversarial lifecycle pass found two deeper variants and they are now
covered as well: close-during-`add_child` invalidates a native creation token, and
failed cleanup of a not-yet-published child is retained in an orphan registry.
All browser mutators carry the Rust renderer generation, preventing delayed
commands from a predecessor page from opening, navigating, hiding, or closing a
replacement page's child. Mock-runtime tests prove ownership/retry behavior;
only a disposable macOS runtime soak can determine how quickly WebKit releases
the separate process after `close()` versus retaining an idle process pool.

Finally, the heartbeat listener is installed immediately after native renderer
registration, before Monaco and React, and acknowledgements carry the renderer
generation. Focused native tests cover process survival, stale acknowledgements,
double registration, Remote/detached survival, bounded/truncated replay, and
orphan browser teardown. The focused milestone suites pass; the full frontend
run currently has one pre-existing `attemptIdentityGuard` source-order assertion
failure that reproduces without this milestone. Runtime tests that kill real
platform WebContent processes remain open below.

### Implementation update — hidden xterm compaction (2026-08-08)

After 60 seconds hidden, a terminal now queues an xterm parser barrier, serializes
its configured scrollback plus cursor, attributes, terminal modes, and alternate
screen through the official serialize addon, then resets and clears the live cell
graph. Each VT snapshot has a 4 MiB UTF-8 cap and all snapshots share a 64 MiB
renderer admission budget. A state above either cap is not cleared: it keeps the
live xterm rather than exchanging fidelity for a memory bound. On show, the VT
snapshot finishes parsing before the native PTY is allowed to reattach at its
unchanged absolute output cursor, so Rust replays only the unseen suffix.

Content-free aggregate counters expose retained rows/cells, visible and hidden
instances, compacted payload bytes, attempts, failures, cap rejections, restores,
and high-water marks without copying terminal content. Real xterm tests cover
normal scrollback, Unicode, attributes, bracketed-paste mode, and the alternate
screen; deterministic race tests cover show-before-parser-drain, hide during
restore, dispose during restore, synchronous restore failure, cap/budget
rejection, serialization failure, and restore-before-native-replay.

## Executive finding

Canopy's terminal byte buffers are bounded, but the CLI process trees themselves
are not memory-limited. More urgently, terminal lifetime is coupled to the main
WebView lifetime in two places. A renderer reload or channel failure can therefore
turn a recoverable UI incident into termination of live shells and agent CLIs.

> ⚠️ **Adversarial-review remark (2026-08-08):** "in two places" is overstated.
> Independent inspection of the Tauri 2.11.5 source shows Path B (channel-failure
> termination) is very likely dead code — `Channel::send` is implemented via
> `webview.eval`, which does not fail on reload, renderer crash, or navigation
> while the native webview object exists. Path A (boot-time `pty_kill_all`) is
> the only statically live destructive mechanism. See the remark under
> "Path B: output-channel failure" for the full evidence and an important
> corollary about post-reload ack starvation.

The required invariant is:

```text
WebView lifecycle != PTY lifecycle

renderer disappears
  -> detach its terminal viewers
  -> keep Rust-owned PTYs and child process trees alive
  -> bound output in the Rust core
  -> let the replacement renderer enumerate and reattach
```

Per-terminal memory governance is feasible on all three desktop platforms, but
the enforcement mechanism differs:

- Windows: Job Objects provide a dynamically adjustable, job-wide committed
  memory limit for a terminal's descendant process tree.
- Linux: cgroup v2 provides dynamically adjustable `memory.high` and
  `memory.max` controls for the descendant process tree.
- macOS: there is no equivalent public aggregate process-tree memory controller.
  Canopy must combine its existing process-tree footprint monitor with process
  group pause/resume and graceful termination. Per-process address-space limits
  are not an adequate substitute for aggregate physical-footprint governance.

The exact trigger of the earlier user-reported incident in the original
two-hour review window was not proven. The later 13:44 incident above is proven
to be WebKit termination for `ExceededMemoryLimit`, not a heartbeat false
positive or navigation. The destructive consequence of either main-renderer
reload is directly confirmed by the pre-fix code.

## How to review this document

An independent reviewer should begin with the claim ledger. For each claim, try
the listed falsification route before accepting the conclusion. Proposed limits
and state-machine timings are design recommendations, not measured facts.

Confidence terminology:

- **Confirmed**: follows directly from current code or authoritative platform
  documentation.
- **Strong inference**: supported by multiple observations, but the incident was
  not captured with enough telemetry to prove causality.
- **Hypothesis**: plausible and worth testing, but not established.
- **Proposal**: a recommended design choice that requires measurement and review.

## Claim ledger

| ID | Claim | Confidence | Primary evidence | How to falsify |
|---|---|---|---|---|
| C1 | Every main WebView boot invokes `pty_kill_all`. | Confirmed | [`src/main.tsx`](../src/main.tsx#L81) | Show a guard or alternate boot entry that prevents the invoke after a renderer reload. |
| C2 | `pty_kill_all` terminates every Rust-owned PTY session. | Confirmed | [`src-tauri/src/pty.rs`](../src-tauri/src/pty.rs#L1276), `PtyManager::kill_all` | Demonstrate that live sessions are excluded or merely detached. |
| C3 | Failure of a desktop PTY output channel terminates that PTY process group. | Confirmed | [`src-tauri/src/pty.rs`](../src-tauri/src/pty.rs#L1095) | Show that `session.terminate()` is unreachable when a renderer disappears. |
| C4 | Terminal output buffering is bounded and backpressured. | Confirmed | [`src-tauri/src/pty.rs`](../src-tauri/src/pty.rs#L29), [`src/components/Term.tsx`](../src/components/Term.tsx#L499) | Produce an output path that bypasses all byte caps and retains unbounded output in Canopy. |
| C5 | CLI process-tree memory is monitored but not enforced. | Confirmed | [`src-tauri/src/agents.rs`](../src-tauri/src/agents.rs#L403), [`src/components/AgentsPanel.tsx`](../src/components/AgentsPanel.tsx#L505) | Identify an OS limit, pause, or allocation gate driven by the measured session footprint. |
| C6 | Hidden terminal tabs remain mounted with xterm scrollback and live output delivery. | Confirmed | [`src/components/ProjectView/index.tsx`](../src/components/ProjectView/index.tsx#L10613), [`src/components/Term.tsx`](../src/components/Term.tsx#L164) | Demonstrate that inactive terminals detach or stop receiving bytes. CSS `display: none` does not falsify the claim. |
| C7 | A busy or slow-booting renderer can be mistaken for a dead renderer by the heartbeat. | Strong inference | [`src-tauri/src/watchdog.rs`](../src-tauri/src/watchdog.rs#L28), [`src/main.tsx`](../src/main.tsx#L89), historical log timings | Prove the acknowledgement listener is active before all potentially slow initialization and that a busy JS loop cannot cross the reload threshold. |
| C8 | The recent renderer-recovery changes can trigger C1. | Confirmed | [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs#L388) reloads a terminated WebView; C1 runs on the resulting boot | Show that WebKit/Tauri reload does not execute the main page bootstrap. |
| C9 | Preview `reload()` reliably returns renderer heap memory to the OS. | Unproven assumption in current design | [`src-tauri/src/browser.rs`](../src-tauri/src/browser.rs#L137) | Measure WebContent physical footprint before and after repeated reloads; compare with close/recreate. |
| C10 | The exact last-two-hour incident was caused by memory pressure. | Not proven | No production incident timeline or termination reason was retained | Find a correlated OS termination record, pressure transition, or per-process footprint history for the incident. |
| C11 | Windows and Linux can enforce dynamically adjustable aggregate tree limits. | Confirmed at OS API level | Microsoft Job Object and Linux cgroup v2 documentation | Show that Canopy cannot place the actual PTY root and descendants into the container without an escape/race. Implementation feasibility still needs testing. |
| C12 | macOS cannot provide the same public aggregate hard limit. | Confirmed for the public APIs reviewed | Apple `setrlimit` documentation and macOS SDK resource definitions | Identify a supported, public, distributable macOS API that imposes and dynamically changes a physical-memory limit over an arbitrary process group. |

## Adversarial review verdicts (2026-08-08)

> ⚠️ **Adversarial-review remark (2026-08-08):** An independent agent attempted
> to falsify C1–C12 against current code, the Tauri 2.11.5 crate source, git
> history, and the cited platform documentation. Line numbers below are from the
> code as of this review and supersede the ledger's citations where they drifted.

| ID | Review verdict | Evidence |
|---|---|---|
| C1 | Confirmed | `src/main.tsx:84` unconditional top-level invoke; sole entry `index.html:59`; no guard exists. Caveat: `.catch(() => {})` means the kill is *attempted*, not guaranteed, on every boot. |
| C2 | Confirmed — blast radius UNDERSTATED | `src-tauri/src/pty.rs:334-349` `kill_all` covers every session in the map, **including headless PTYs spawned from Canopy Remote and detached micro-task PTYs that no renderer page ever owned**. |
| C3 | **Partially true — reachability refuted** | The conditional exists (`pty.rs:1095-1100`) but Tauri `Channel::send` = `webview.eval` (tauri-2.11.5 `src/ipc/channel.rs:245-283`, `src/webview/mod.rs:1917-1923`), which errors only when the native webview is being destroyed — not on reload/crash/navigation. `session.terminate()` is realistically reachable only at webview destruction, where `kill_all` runs anyway. |
| C4 | Confirmed | `pty.rs:29-67` (caps), `pty.rs:149-154` (reaped retention), reader backpressure `pty.rs:1010-1021`; ack after xterm consumes, `src/components/Term.tsx:499-508`. |
| C5 | Confirmed | `agents.rs:23,41-56,434-470`; the 4 GiB runaway threshold (`settings.ts:570-571`) drives badges only (`AgentsPanel.tsx:507-510`); the only kill is user-initiated. `autoHibernate` is count-based and idle-only, not footprint enforcement. |
| C6 | Confirmed | `ProjectView/index.tsx:10614-10643` renders every terminal tab (hidden = `display: none`); `Term.tsx` writes to xterm regardless of visibility; `App.tsx:3113-3116` keeps every open project's ProjectView mounted. Broad search found **no** existing visibility gating, output pausing, or xterm disposal. |
| C7 | Confirmed as capability (UNDER-labeled); historical log figures unverified | Fully static-verifiable: ack listener lives in a React effect (`App.tsx:2243-2250`), React mounts only after `monacoReady` (`main.tsx:94-104`), `app.emit` success ≠ JS execution (`watchdog.rs:252`), 45 s grace < plausible Monaco boot. Only its role in the specific incident is inference. |
| C8 | Confirmed | `lib.rs:392-399` reloads any terminated webview; `watchdog.rs:280` reloads main; a main reload re-executes `main.tsx` (single-entry SPA) → C1. The two reload paths share no state. |
| C9 | Confirmed as an unproven assumption | `browser.rs:137-166` comments assert heap teardown; no measurement exists anywhere in the repo. |
| C10 | Confirmed — cause unprovable retroactively | No DiagnosticReports entries; `tauri_plugin_log` only under `debug_assertions` (`lib.rs:481-487`); release builds retain no trail. No experiment can resolve this — only the proposed telemetry prevents recurrence of the ambiguity. |
| C11 | Confirmed at OS API level | MS docs: `JobMemoryLimit` is job-wide committed memory, runtime-adjustable via `SetInformationJobObject`; cgroup v2 docs: `memory.high`/`memory.max` aggregate over descendants, runtime-writable. Implementation feasibility (suspended spawn, conhost placement, distro delegation) untested. Note: Windows jobs have a documented escape via WMI `Win32_Process.Create`, and portable-pty's killer terminates the direct child, not necessarily the tree. |
| C12 | Confirmed as scoped | macOS's real footprint-limit machinery (`memorystatus_control` jetsam limits, `task_set_phys_footprint_limit`) is private SPI; the claim's "public APIs reviewed" hedge is honest. |

**Net effect on the executive finding:** the core thesis survives — a main
renderer reload destroys all terminal sessions — but through Path A only, and
the destruction extends to renderer-independent (headless/micro-task) sessions.

## Current architecture

### Terminal output path

```text
CLI process tree
  -> kernel PTY
  -> one Rust reader thread per PTY
  -> Session.pending
  -> 10 ms Rust flusher
     -> bounded 256 KiB remote scrollback
     -> bounded remote broadcast
     -> Tauri Channel owned by the renderer that spawned the PTY
        -> xterm write buffer
        -> renderer acknowledgement
        -> Rust outstanding-byte window decreases
```

Important existing safeguards:

- Default desktop output high-water mark: 2 MiB.
- PTY read buffer: 64 KiB.
- PTY input queue: 1 MiB.
- Remote scrollback: 256 KiB per live session.
- Exited output retention: eight sessions, 256 KiB each, for 60 seconds.
- Frontend acknowledgement occurs only after xterm consumes a chunk.
- PTY shutdown targets the Unix process group and provides a 2.5 second grace
  period before forced termination.

These safeguards bound Canopy's native PTY transport buffers. They do not cap:

- memory allocated by the CLI and its descendants;
- xterm's retained screen and scrollback structures for every mounted terminal;
- aggregate IPC work delivered to the main renderer by many hidden terminals.

### Process-tree monitoring

Canopy already has most of the measurement foundation needed for a governor:

- A single monitor refreshes the process table every two seconds.
- Each PTY is associated with its root process.
- Descendants are aggregated into `SessionStats`.
- CPU and memory are reported per process and per terminal tree.
- macOS uses `proc_pid_rusage(... RUSAGE_INFO_V4 ...)` and
  `ri_phys_footprint`, falling back to RSS.
- The monitor already knows quiet time, input time, total output bytes,
  foreground process, and identified agent CLI.

Current enforcement stops at UI classification. The default runaway memory
threshold is 4 GiB in [`src/settings.ts`](../src/settings.ts#L570), and crossing
it adds warning presentation in the Agents surfaces. It does not modify the
process tree.

## Confirmed terminal-loss mechanism

### Path A: renderer recovery boot

```text
WebContent terminates or watchdog reloads main view
  -> main page executes again
  -> main.tsx invokes pty_kill_all
  -> PtyManager sends shutdown to every session
  -> Unix process groups receive SIGTERM, then SIGKILL if necessary
  -> Windows children are killed through the portable-pty killer path
```

The original comment describes live sessions as orphans belonging to a previous
page. That assumption was reasonable when PTYs were renderer-owned. It conflicts
with renderer recovery: the Rust core survives specifically so durable work can
survive replacement of the WebContent process.

> ⚠️ **Adversarial-review remark (2026-08-08):** git history confirms the
> `pty_kill_all` boot call predates renderer recovery entirely (it dates from
> the initial commit; the watchdog arrived in 608aeaa and the native
> termination callback in 30700ec). The "orphans of a previous page" comment is
> doubly wrong today: `kill_all` also destroys headless PTYs spawned from
> Canopy Remote and detached micro-task PTYs — sessions no renderer page ever
> owned.

### Path B: output-channel failure

The direct desktop-spawn path captures an immutable `Channel` in the flusher.
If `Channel::send` fails, it calls `session.terminate()`. A renderer crash,
navigation, or reload can therefore kill sessions even before the replacement
page reaches `pty_kill_all`.

The separate attach path behaves differently: it breaks the attachment-forwarder
thread when its channel closes and leaves the PTY alive. That is the correct
lifetime model and should become the only desktop model.

> ⚠️ **Adversarial-review remark (2026-08-08):** Path B's premise is very likely
> false. In Tauri 2.11.5, `Channel::send` is implemented via `webview.eval`
> for every payload size (`tauri-2.11.5/src/ipc/channel.rs:245-283`; the
> queue+fetch branch also triggers via eval), and `Webview::eval` errors only
> when dispatch to the native webview/event loop fails — i.e. when the native
> view is being destroyed. A reload leaves the native view alive; the eval
> lands in a page whose JS callback no longer exists and the JS error is
> swallowed. A macOS WebContent-process termination also leaves the native
> `WKWebView` alive. So "can kill sessions even before the replacement page
> reaches `pty_kill_all`" is unproven and likely unreachable; runtime
> experiment 1 below settles it.
>
> **Corollary the original analysis missed (load-bearing for P0):** after a
> reload, channel sends keep *succeeding* into a page with no listener. Acks
> never arrive, `outstanding` climbs to the 2 MiB high-water mark, and the
> reader thread stalls with the child blocked on `write(2)`. If `pty_kill_all`
> is removed from boot **without** a reattach mechanism, orphaned sessions do
> not stream on happily — they silently wedge. This makes P0 steps 1–5 a
> single atomic unit, not an ordered list.

## Renderer restart analysis

### Heartbeat limitations

The watchdog currently:

- emits a ping every three seconds;
- treats an acknowledgement older than nine seconds as stale;
- reloads after three consecutive stale readings;
- allows a 45-second grace period after a reload;
- reloads at most three times in ten minutes.

This detects a dead renderer, but a heartbeat processed on the same JavaScript
event loop cannot distinguish death from starvation. High terminal IPC, xterm
parsing, Monaco initialization, synchronous rendering, or another long task can
delay the same listener used as proof of life.

The heartbeat subscription is installed in a React effect. React mounting waits
for the Monaco service barrier in `main.tsx`. Historical logs contained a boot
where Monaco took about 55 seconds, longer than the 45-second recovery grace.
They also contained three reloads spaced about 51 seconds apart, consistent with
grace expiry followed by stale-heartbeat enforcement. This historical pattern is
supporting evidence, not proof of the recent incident.

> ⚠️ **Adversarial-review remark (2026-08-08):** C7 is if anything
> under-labeled. The false-positive *capability* is fully static-verifiable —
> the ack listener lives in a React effect (`App.tsx:2243-2250`), React mounts
> only after `monacoReady` (`main.tsx:94-104`), `app.emit` success does not
> prove JS execution (`watchdog.rs:252`), and the 45-second grace is shorter
> than a plausible Monaco boot. Only the claim that this caused the specific
> incident remains inference.

### Native renderer termination callback

On Apple platforms, `on_web_content_process_terminate` immediately reloads every
terminated WebView. This is authoritative evidence that WebKit terminated a
renderer, but it is not coordinated with the heartbeat reload state. The two
paths should share one reload generation, grace deadline, incident record, and
rate limiter.

### Preview pressure relief

At warning memory pressure, hidden preview WebViews are reloaded. At critical
pressure, visible previews are reloaded too. The code comments assume this tears
down their JavaScript heaps.

That assumption needs measurement. Navigation destroys the page's document and
JavaScript global state, but the reusable WebContent process may retain allocator
pages, caches, decoded resources, and process-level heap capacity. Reload also
creates a period in which teardown and new page allocation overlap. A stronger
pressure-relief operation is:

1. capture URL and recoverable navigation metadata;
2. close/destroy hidden native preview WebViews;
3. retain only lightweight tab metadata;
4. lazily recreate the native WebView when the user activates the tab.

The implementation should benchmark reload against close/recreate before choosing.

> ⚠️ **Adversarial-review remark (2026-08-08):** close/recreate contradicts the
> invariant documented at `browser.rs:140-143` — the frontend must never point
> at a closed child view — and loses in-page state (forms, SPA state) more
> thoroughly than reload does. It requires reworking the frontend handle
> contract first, and the section-7 measurement below must gate it: reject
> close/recreate if reload consistently returns equivalent memory without a
> higher transient peak.

## Incident evidence and limitations

Review time was approximately 2026-08-08 10:22 +0700. The requested incident
window was the preceding two hours.

Findings:

- No new Canopy entry appeared in `~/Library/Logs/DiagnosticReports`.
- The existing Canopy file logs had not been updated during the requested window.
- A narrowly filtered macOS unified-log query did not return a Canopy-recorded
  watchdog reload, memory-watchdog transition, or renderer-termination message.
- The current release setup installs `tauri-plugin-log` only when
  `debug_assertions` is true. Consequently, `log::error!` calls in the renderer
  callback and watchdog are not a dependable production incident record.
- The macOS WebKit trace showed one Canopy WebContent page's custom-scheme
  resource identifier advancing by roughly 950,000 between approximately 08:25
  and 09:48. This demonstrates very high custom-scheme delivery activity. It
  does not identify which feature generated every delivery and must not be
  treated as proof that PTY output caused the incident.

The recent incident should therefore be classified as **cause unknown, destructive
recovery consequence confirmed**.

### Live process profile after the original review

At approximately 10:55–10:57 +0700 on 2026-08-08, the still-running production
process was profiled read-only. This does not retroactively prove the trigger of
the earlier renderer restart, but it does identify the active runaway allocation
class and materially narrows the current root-cause investigation.

- Native Canopy PID `49786`: about 1.6 GiB physical footprint, 2.6 GiB peak.
- Main `tauri://localhost` WebContent PID `89570`: 12.9 GiB physical footprint,
  13.8 GiB peak during the stack sample.
- `footprint` attributed about 10 GiB to `WebKit malloc`; about 8.7 GiB of that
  allocation was compressed/swapped. Graphics-owned footprint was about 110 MiB,
  JIT code about 30 MiB, and mapped files were negligible.
- The separate `docs.aws.amazon.com` WebContent process was only about 84 MiB,
  so the remote page itself was not the 12.9 GiB process.
- Only two native PTYs were present. Both PTY reader threads were blocked in
  `read(2)` and both flusher threads were sleeping during the sample. Hidden
  terminal delivery remains a confirmed pressure amplifier, but active PTY
  output did not explain the live growth at the sample instant.
- The main renderer was executing timer-driven JavaScript event dispatch,
  string/JSON work, layout, and `RunJavaScriptInFrameInScriptWorld` deliveries.
- The native and WebContent processes continued exchanging hundreds to low
  thousands of Mach messages per second while the UI was left idle.

The strongest newly identified leak candidate is the native-browser freeze-frame
path in the profiled build:

1. The profiled revision of `src/browserFrame.ts` permitted a full snapshot
   every five seconds while a native browser view was shown.
2. The profiled revision of `src/browserHost.ts` received each snapshot as
   base64, created a new unique `data:` URL, and pre-decoded it through a new
   `Image` object.
3. [`src-tauri/src/snapshot.rs`](../src-tauri/src/snapshot.rs#L164) captures and
   JPEG-encodes the native WebView at up to 900 pixels wide.
4. PID `89570` had been alive for roughly 4.25 hours: approximately 3,060
   five-second capture opportunities. Retaining only 3–4 MiB of WebKit allocation
   per unique decoded frame lands in the observed 10–13 GiB range.

This correlation is a **strong inference**, not yet allocation-stack proof.
Falsify it by disabling periodic capture while leaving the same browser page and
terminal workload running, then compare the renderer-footprint slope. Also test
Blob URLs with explicit revocation and verify that repeated frame replacement
reaches a stable plateau.

A second read-only sample at 13:42 +0700, still without restarting the live app,
strengthens the layer attribution:

- Main WebContent PID `89570` had an 11.0 GiB physical footprint and 17.6 GiB
  peak. `vmmap` reported a 20.0 GiB WebKit malloc zone, 6.5 GiB resident,
  9.9 GiB allocated, 5.5 GiB swapped, and about 28.4 million allocations.
- The old `docs.aws.amazon.com` helper PID `28282` still existed but had fallen
  from roughly 84 MiB to 9 MiB RSS. That is consistent with WebKit retaining an
  idle reusable content process after the child view closes; process presence
  alone is therefore not proof of a still-owned page. A failure to release its
  former footprint would be the leak signal.
- This was the installed pre-fix binary, so the sample validates the problem
  layer but cannot validate the new close/create/recovery ownership fixes.

At 13:44:22 the same production renderer demonstrated the failure rather than
merely approaching it. WebKit measured 10,948 MiB physical footprint, failed to
shrink it below the 4,096 MiB inactive limit, and terminated it with
`ExceededMemoryLimit` at 13:44:25. The replacement PID `43665` launched within
the same second. Its JavaScript/object and `bmalloc` counters are recorded in
the incident section above. This is the acceptance-test baseline for a fixed
build: sustained use must plateau well below that threshold, and renderer
replacement must preserve every live PTY even if the threshold is crossed.

### Why the IDE chip and Activity Monitor disagree

The status chip screenshot at 11:08 showed `44% cpu · 2.4 GB`, while Activity
Monitor at 11:09 showed about 1.46 GB for the native Canopy process group and
7.04 GB for the main `tauri://localhost` WebContent process. These readings are
not measuring the same ownership boundary:

- Canopy's process monitor starts at the native Canopy pid and walks ordinary
  descendants, which includes terminal/CLI trees, language servers, and other
  processes Canopy spawned.
- macOS launches WKWebView WebContent, Graphics, and Networking helpers as XPC
  services parented to `launchd`, so they are not descendants and were excluded
  from the chip despite being part of the IDE's real pressure.
- Process-name matching is unsafe because it would charge unrelated Safari and
  other applications' WebKit processes to Canopy. WKWebView exposes no public
  API for enumerating all helper pids.

The chip now renders the macOS process-tree reading as a lower bound (`≥`) and
names the omitted WebKit layer in its tooltip and breakdown. Windows and Linux
continue to show an exact descendant total where their WebView helpers remain in
the application process tree. Exact macOS aggregation remains open until it can
be implemented without private SPI or heuristic cross-application attribution.

### Required incident telemetry

Add a small Rust-owned, rotating resource incident log in release builds. It
should avoid prompts, terminal content, paths beyond a safe basename/hash, and
other sensitive payloads. Suggested fields:

```text
timestamp
app launch id
main renderer generation
event: pressure-change | heartbeat-stale | renderer-terminated |
       reload-started | reload-completed | terminal-paused | terminal-stopped
host total and available memory
Rust process footprint
known WebView labels and visibility
per-terminal id, hashed project identity, tree footprint, process count,
CPU, and output bytes/second
reload reason and initiator
```

Keep a bounded in-memory ring plus rotated files, for example two 5 MiB files.
Production warning/error logging should be enabled independently of optional
crash-report upload.

## Platform enforcement matrix

### Windows

Use one Job Object per PTY session. Processes assigned to a Job Object normally
place descendants into the same job. Relevant controls include:

- job-wide committed-memory ceiling;
- notification limit before the hard ceiling;
- completion-port notifications;
- peak job memory accounting;
- termination of the contained tree.

The limit can be updated using `SetInformationJobObject`, so a user grant can
raise it without restarting the CLI.

Primary references:

- [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft: job memory limit flags](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
- [Microsoft: extended job limit information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)

Implementation risk: assigning the root after it has already spawned children
creates a containment race. The safe design is to create it suspended, assign it
to the Job Object, then resume. If `portable-pty` cannot expose this sequence,
use a small Canopy launcher that waits on a parent-controlled gate before exec.

> ⚠️ **Adversarial-review remark (2026-08-08):** two omissions worth carrying
> into the design. First, Windows jobs have a documented escape: a contained
> process can spawn outside the job via WMI `Win32_Process.Create`; treat the
> job limit as governance, not a security boundary. Second, `portable-pty`'s
> killer terminates the direct child, not necessarily the tree — Job-Object
> `TerminateJobObject` should become the Windows kill path, and portable-pty
> exposes no suspended-spawn sequence, so the launcher-gate design is likely
> required (open question 4).

### Linux

Use one delegated cgroup v2 directory per PTY session:

- `memory.high`: reclaim/throttle boundary;
- `memory.max`: hard boundary;
- `memory.current`: aggregate current usage;
- `memory.events`: threshold, max, and OOM events;
- `cgroup.procs`: attach the terminal root so descendants inherit membership.

The values can be changed while the group is live. Raising a user's approved cap
is therefore a direct file update followed by resumption if Canopy paused it.

Primary reference:

- [Linux kernel: cgroup v2 memory controller](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)

Implementation risk: not every distribution delegates a writable user cgroup
subtree to desktop applications. Prefer a user systemd scope/delegated subtree
where available; retain the process-group monitor-and-pause fallback otherwise.

### macOS

`setrlimit` limits apply to the current process and are inherited by descendants.
The SDK exposes `RLIMIT_AS`; `RLIMIT_RSS` is an alias. This controls per-process
address space, not the charged physical footprint of an aggregate PTY tree.

This is a poor primary control for Node-based agent CLIs because V8 and native
libraries may reserve large virtual regions without using equivalent physical
memory. It is also not a dynamically adjustable parent-controlled group limit.

Use:

- existing per-process physical-footprint sampling;
- aggregate descendant-tree accounting;
- a bounded descendant/session pause operation to stop/resume growth;
- graceful `SIGTERM`, existing transcript grace, and `SIGKILL` only when memory
  must actually be reclaimed.

Primary reference:

- [Apple: `getrlimit` and `setrlimit`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html)

Pausing does not free memory. The policy must reserve enough memory for the IDE
to display the decision, and it must be willing to hibernate or terminate an
over-budget session if host pressure remains critical.

> ⚠️ **Adversarial-review remark (2026-08-08) — pause is not harmless:** a
> process-group `SIGSTOP` can freeze an agent CLI mid-API-turn; its network
> connections time out while paused, so the in-flight turn is lost on resume
> even though pause is counted as non-destructive. A paused agent also keeps
> holding its context/file claims (claims release only on pty exit,
> `pty.rs:1150`), which can block other agents indefinitely. The governor
> design must account for both: pause near turn boundaries where detectable,
> and either release or surface held claims while paused.
>
> A second adversarial pass found that one Unix process group is not the PTY
> tree: an interactive shell normally puts its foreground agent in a different
> PGID, and descendants can create more groups. The current termination path now
> signals both the launch-shell and foreground groups, fixing the common case,
> but a governor must enumerate a PID/start-time-verified session/descendant set,
> stop it to a bounded fixed point, and report escapes. Plain
> `killpg(root_pid, SIGSTOP)` is not an acceptable implementation.

## Proposed target architecture

### Rust-owned session

Replace the immutable spawn-time output channel with a replaceable attachment:

```text
Session
  id / stable session generation
  PTY master and child/process container
  bounded input queue
  bounded raw output ring
  process-tree resource budget
  state: running | paused-for-budget | stopping | exited
  attachment: Option<RendererAttachment>
    renderer generation
    bounded byte queue
    outstanding bytes
```

Rules:

1. PTY creation never requires a renderer channel.
2. Channel failure removes only the matching attachment generation.
3. PTY output continues into a bounded Rust ring while detached.
4. A new renderer enumerates live sessions and attaches.
5. Attachment returns a gap-free snapshot plus live stream.
6. Explicit tab close may stop its PTY according to current product semantics.
7. Native application exit may stop all PTYs.
8. Renderer boot, reload, navigation, and crash may never stop a PTY.

### Hidden terminal policy

Only visible terminals and visible split panes need continuous renderer delivery.
For an inactive terminal:

- detach its renderer stream;
- keep the CLI running;
- retain bounded raw output in Rust;
- optionally dispose or serialize the inactive xterm instance after an idle
  interval;
- on activation, attach, replay the bounded snapshot, and resume live delivery.

This reduces three pressure sources together: Tauri IPC, JavaScript parsing, and
xterm scrollback structures.

> ⚠️ **Adversarial-review remark (2026-08-08) — data-loss risk:** "dispose or
> serialize the inactive xterm instance" destroys local scrollback (up to
> `settings.scrollback` = 5,000 lines) that exists nowhere else — the Rust ring
> retains only 256 KiB. Until open question 7 (reattach fidelity) is answered,
> disposal is user-visible data loss. Serialization or a bounded server-side
> parser must land first; bare disposal must not ship.

The hidden-idle implementation satisfies this warning without bare disposal:
only successfully serialized states admitted under both the 4 MiB per-terminal
cap and 64 MiB renderer budget have their cell graph cleared. Oversized,
budget-rejected, or failed serialization leaves the original xterm untouched.
Open question 7 still applies to a whole-renderer loss, because an OOM also loses
the JavaScript-owned VT snapshot and must fall back to the bounded Rust replay.

### Early heartbeat and coordinated reloads

- Register the watchdog listener in `main.tsx` before Monaco initialization.
- Acknowledge renderer generation immediately.
- Keep the React subscription only for UI state, not liveness.
- Route native termination and heartbeat recovery through one Rust coordinator.
- Before any main reload, mark the renderer attachment generation detached.
- Never reload merely because a single event-loop heartbeat is late.
- On staleness, first disable hidden terminal delivery and destroy hidden
  previews; observe whether acknowledgements recover.
- Record every decision in the release incident log.

> ⚠️ **Adversarial-review remark (2026-08-08):** the shed-first probing policy
> deliberately delays genuine dead-renderer recovery. Bounded escalation timing
> must be part of the spec, or a jetsam-killed renderer sits blank longer than
> today. Specify a maximum time from first staleness to forced reload.

## Proposed terminal governor

The governor belongs in the Rust core and should reuse the existing process-tree
monitor. Avoid a second full process scan.

Implementation status (2026-08-08): a first **monitor-only** Rust milestone now
owns per-session allowance, generation, grant, transition, metric, and bounded
incident state. It consumes the existing PTY monitor's process-tree totals and
refreshes only host memory counters. Temporary 512 MiB/1 GiB grants are
single-use, generation-checked, idempotent on exact retry, and cannot promise
headroom already held by earlier grants or the `max(3 GiB, 25%)` host reserve.
That first milestone was policy accounting, not containment: it did not pause,
kill, install a Job Object, write a cgroup, or enforce an allocation boundary,
and therefore reported `monitor_only` on all three desktop platforms.

Platform-containment milestone (2026-08-08): the backend contract now reports
runtime capability rather than inferring it from the target OS. Windows and
macOS remain `monitor_only`. On Linux, Canopy can opt into a race-closed
`memory.high` soft boundary only when `CANOPY_CGROUP_ROOT` names an explicit
writable cgroup-v2 delegation and Canopy itself is already inside that subtree.
For each future PTY it creates an empty child cgroup, writes the initial
allowance, starts the shipped `canopy-hook` in launcher mode, waits until that
same PID has joined and reports ready, verifies `/proc/<pid>/cgroup`, and only
then releases the launcher to `exec` the user's original argv. Explicit grants
raise `memory.high` before the policy grant commits. A failed boundary update
leaves the grant unspent. Once active, governor decisions use the same cgroup's
`memory.current` charge rather than a lower RSS estimate, so the user sees the
warning/grant transition before the enforced boundary. It never writes
`memory.max`: the kernel documents
`memory.high` as reclaim/throttling which does not invoke the cgroup OOM killer,
whereas a hard limit would give an agent allocation failures without a safe
application-level recovery contract.

This Linux path is deliberately opt-in rather than guessing a writable systemd
scope. Automatic user-scope creation/delegation, Linux runner validation, cgroup
event monitoring, cleanup retry for a daemonized descendant, and packaging
instructions remain open. Windows' equivalent gate is architecturally possible:
spawn the shipped helper waiting, open its PID, assign and verify a Job Object,
then release it. It is not implemented yet because `portable-pty` does not
expose its process handle, this environment cannot compile the Windows native
dependency graph without the MSVC SDK, and `JOB_OBJECT_LIMIT_JOB_MEMORY` is a
hard committed-memory failure boundary—not a safe analogue of `memory.high`.
`KILL_ON_JOB_CLOSE` would also be an explicit process-tree lifetime decision,
not something to introduce as an incidental memory-control flag.

Suggested state model:

```text
NORMAL
  -> sustained >= warning threshold
WARNED
  -> sustained >= soft cap
PRESSURE_ACTIONS
  -> at approved cap or host critical
PAUSED
  -> user grants more
NORMAL (raised allowance + resume)
  -> user stops / critical pressure persists
GRACEFUL_STOP
  -> grace expires
FORCED_STOP
```

Suggested initial policy for measurement, not a final product promise:

- Protect an IDE/control-plane reserve of `max(3 GiB, 25% of physical RAM)`.
- Keep aggregate terminal usage at or below roughly 50% of physical RAM.
- Initial per-terminal allowance:
  - 1 GiB on an 8 GiB machine;
  - 1.5 GiB on a 16 GiB machine;
  - 2 GiB on machines with 24 GiB or more.
- Warn at 75% of the allowance after two consecutive samples.
- Begin pressure relief at 90%.
- Pause at the approved allowance before requesting a grant.
- Offer one-session grants of 512 MiB and 1 GiB.
- Persist a higher CLI default only through a separate explicit user action.
- Sample every two seconds normally and switch to approximately 250 ms while a
  session is above 75% or host pressure is elevated.

These numbers require representative profiling of Claude, Codex, Gemini,
OpenCode, Aider, build tools, language servers, and MCP subprocesses. The design
requirement is the state machine and protected reserve, not these exact values.

### Meaning of throttle

Memory cannot be made smaller by reducing CPU. Platform semantics differ:

- Linux `memory.high` provides real memory-pressure throttling and reclaim.
- Windows can notify before a job-wide hard committed-memory limit; allocation
  failure at the hard cap may crash software and should be the last boundary.
- macOS can pause the process group to prevent growth, but only hibernation or
  termination reliably reclaims its existing footprint.

The UI should use precise language: “paused at its memory allowance” rather than
claiming that memory was reclaimed.

### Host-critical fallback

The Rust core must be able to act even if the renderer cannot show a prompt:

1. detach hidden terminal renderers;
2. destroy hidden preview WebViews;
3. pause the largest over-budget terminal tree;
4. wait briefly and resample host availability;
5. if pressure remains critical, resume that tree long enough to deliver
   graceful termination and allow transcript hooks to flush;
6. force termination after the existing grace interval if necessary;
7. persist an incident explaining why it acted.

This policy deliberately protects the IDE control plane. A frozen process still
holds memory, so indefinite pause cannot be the final response to host-critical
pressure.

## Full implementation checklist

The checklist is deliberately broader than the first patch. A checked item is
complete in the current worktree; unchecked items must not be inferred from a
nearby implementation. Items marked **atomic** must ship together.

The bounded incident procedure and numeric release gates are in
[`memory-resilience-runbook.md`](./memory-resilience-runbook.md).

### A. Immediate renderer-pressure containment

- [x] Capture a live OS footprint and short stack sample for the native host and
  main WebContent process.
- [x] Distinguish the main renderer from preview, graphics, networking, and CLI
  processes.
- [x] Confirm the dominant allocation category (`WebKit malloc`) and record peak,
  swapped/compressed, graphics, JIT, and mapped-file contributions.
- [x] Correlate live PTY activity with renderer growth rather than assuming the
  terminal transport is active.
- [x] Remove steady five-second browser freeze-frame captures; capture initially,
  after navigation/agent mutation, and at the hide transition only.
- [x] Replace unique long-lived snapshot `data:` URLs with revocable Blob URLs.
- [x] Revoke the previous frame only after the replacement has decoded and been
  adopted; revoke frames on navigation, tab close, stale completion, and host
  reset.
- [x] Reject stale asynchronous snapshot completions after a view is forgotten
  or its generation changes.
- [x] Bound native snapshot dimensions, encoded byte size, and the number of
  in-flight captures globally and per view.
- [x] Record native capture count, success/failure, encoded bytes, capture latency,
  active captures, payload bytes retained inside capture futures, and high-water
  marks using constant-size counters that retain no labels, URLs, or page content.
- [x] Record frontend image-decode count/last/max/average latency and currently
  retained frame count/Blob bytes with high-water marks. The renderer ledger is
  scalar-only and releases ownership on replacement, navigation, close, stale
  completion, and host reset; native metrics still stop at IPC transfer.
- [ ] Add a long-running replacement test that proves renderer footprint reaches
  a plateau on macOS, Windows, and Linux.
- [ ] Compare reload, close, and close/recreate only after the frontend child-view
  handle contract can represent a destroyed view.

### B. PTY continuity and renderer reattachment — **atomic**

- [x] Define Rust-owned session ids and session generations independent of any
  renderer.
- [x] Replace the spawn-time immutable desktop channel with a replaceable,
  generation-scoped attachment.
- [x] Store renderer generation, outstanding-byte accounting, and attachment
  state in Rust.
- [x] Detach only the matching attachment when delivery is stale or unavailable;
  never terminate the PTY for renderer lifecycle events.
- [x] Continue draining the kernel PTY while detached into a bounded Rust ring;
  drop oldest bytes with an explicit gap marker rather than blocking the child.
- [x] Add `pty_list_live`/equivalent reconciliation with id, owner, geometry,
  cwd identity, title, exit state, and replay range.
- [x] Reattach restored tabs to the original PTY ids instead of spawning
  replacements.
- [x] Make acknowledgement accounting attachment-generation aware so late acks
  cannot release a newer attachment's window.
- [x] Define gap-free snapshot-plus-live handoff and test the boundary race.
- [x] Preserve explicit tab-close semantics, native application-exit cleanup,
  and an explicit development orphan-reap operation.
- [x] Remove boot-time `pty_kill_all` only in the same release as enumeration,
  restore reconciliation, generation-scoped attach, and bounded detached drain.
- [x] Keep app-exit `kill_all`; distinguish app exit from renderer exit in code
  and telemetry. App exit records start and `kill_all` return (including forced
  signal count) in the bounded incident ring and the release resilience log.
- [ ] Test reload, WebContent termination, navigation, double reload, and renderer
  startup failure against harmless marker-producing PTYs.
- [x] Test headless Remote and detached micro-task PTYs in the same matrix.

### C. Hidden terminal and frontend-state pressure

- [x] Stream to the renderer only for visible tabs and visible split panes.
- [x] Detach hidden terminal viewers without pausing their child processes.
- [x] Define a bounded replay policy and surface a visible truncation marker.
- [x] Regression-test delayed xterm parsing across hide/show and verify every
  onscreen multiplex pane streams while keyboard focus remains single-owner.
- [x] Publish constant-size, content-free renderer counters for live/visible/
  hidden xterm instances, configured scrollback, normal/alternate buffer rows,
  estimated buffer cells, parsed-write batches, compaction outcomes/payloads,
  and high-water marks. These are shape diagnostics, not a false claim of exact
  JavaScript heap-byte sizing.
- [x] After a 60-second hidden idle interval, drain xterm parsing, serialize full
  VT state under a 4 MiB per-terminal cap and 64 MiB renderer-wide admission
  budget, clear the cell graph, and restore it before native replay. Oversized,
  budget-rejected, or failed states remain live and are never destructively
  compacted.
- [ ] Measure typical and worst-case xterm bytes per row, long wrapped lines,
  hyperlinks, Unicode cells, and alternate-screen applications.
- [x] Preserve configured 5,000-line rendered scrollback during hidden-idle
  compaction through VT serialization; real xterm round trips cover Unicode,
  attributes, modes, and alternate-screen state. This does not claim that the
  JavaScript snapshot survives a whole-renderer OOM.
- [ ] Dispose inactive xterm renderers only after the chosen fidelity mechanism
  is verified.
- [x] Gate ResizeObserver for hidden terminals and collapse focus, drag/drop,
  theme, and global inserted-text handling into one renderer-wide listener set
  that routes input only to the active terminal and tears down at zero owners.
- [x] Coalesce PTY delivery by both time (10 ms) and byte size (64 KiB); publish
  scalar chunks, bytes, maximum chunk, renderer write-completion latency
  (queue plus parse for callbacks still belonging to the attached epoch),
  native ack latency, and outstanding-byte metrics. The native pending-ack
  ledger is bounded to 256 batches and preserves the oldest latency when it
  aggregates; this is not claimed as isolated xterm parser CPU time.
- [ ] Add a bounded-output multi-terminal soak test with one visible pane and
  many hidden tabs.

### D. General I/O and retained-data bounds

- [ ] Define global and per-project concurrency budgets for filesystem reads,
  metadata calls, network requests, subprocess pipes, and decode/parse work.
- [x] Add one renderer-wide admission controller with eight global/four
  per-project active operations, 64 MiB/32 MiB active-byte ceilings, and a
  bounded 96-item/64 MiB queue. Agent Workspace and LSP-provider file reads,
  task-history/evidence artifacts, deferred project search, tracker/agent-tool
  PR requests, and attachment decoding now share it; unwrapped metadata, Git and general
  network call sites keep the broad
  item above open.
- [ ] Batch directory enumeration and metadata/stat requests; coalesce duplicate
  path work and cap each batch by both item count and estimated bytes.
- [ ] Deduplicate identical in-flight network requests, cap concurrent sockets
  and response bodies per origin/project, and stream large downloads/uploads.
- [ ] Abort superseded file reads, fetches, previews, searches, and decodes so
  their buffers cannot outlive the UI state that requested them.
- [x] Remove aborted requests from the shared admission queue, discard late
  active results without releasing their lease early, stop superseded tracker
  loops before their next repository, and abort active FileReader attachment
  encodes on replacement/unmount. Already-started Tauri invokes remain
  non-interruptible, so the broad cancellation item stays open.
- [x] Bound Agent Workspace journal-file hydration to three concurrent reads,
  8 MiB per file, and 16 MiB aggregate input; stop launching or retaining a
  superseded generation, and evict stale diff-data cache entries with a
  128-entry backstop.
- [x] Hydrate only the newest eight durable task-output artifacts, two reads at
  a time; cap retained output to 512 Ki characters per run and 2 Mi characters
  app-wide, and single-flight lazy loads for older expanded rows.
- [x] Put byte bounds and backpressure on both WebSocket bridge directions.
- [ ] Bound LSP, MCP, companion, and structured-runner frames before parsing or
  allocating the complete payload.
- [x] Bound LSP headers/frames, MCP stdio/HTTP request and response bodies, and
  structured-runner lines before complete-payload allocation; companion framing
  and MCP tool-result pagination remain separate open work.
- [x] Make portal queue limits byte-based as well as count-based. The portal now
  admits at most 8 MiB of queued outbound text, rejects a single message above
  4 MiB and inbound control frames above 1 MiB, and holds each byte reservation
  until the socket writer consumes the message.
- [x] Coalesce filesystem watcher bursts by project/path and bound pending event
  bytes. One quiet-period task now owns each root, deduplicates at most 2,048
  paths/512 KiB, and emits an overflow bit that makes the renderer rescan only
  its already-open files for that root.
- [ ] Close and instrument file descriptors/Windows handles, pipes, sockets,
  watcher registrations, timers, observers, event subscriptions, and child
  process handles at owner teardown; alert on monotonic handle-count growth.
- [ ] Keep permission/security-scoped file handles and access grants scoped to
  active operations; release them on cancellation, tab/project close, and error.
- [ ] Stream or incrementally truncate Git/process output instead of capturing
  the full child output first.
- [x] Stream and continuously drain commit-patch and per-file Git diff output,
  retain only the bounded display window, and compute patch statistics across
  the full stream; branch/network/Linear helpers remain open.
- [ ] Enforce file-size budgets before decoders/parsers that read whole files.
- [x] Reject SpotSearch images and companion attachments above 12 MiB before
  FileReader/base64 work; admission charges the original plus its 4/3 encoded
  representation so the peak fits the 32 MiB per-project ceiling. Both Rust
  commands now reject oversized
  encoded input before allocating the decoded byte buffer and recheck decoded
  size before writing.
- [x] Gate language-service and agent LSP-tool whole-file reads at 8 MiB before
  IPC and reject a post-stat growth result instead of retaining it. The native
  read command now accepts the same caller maximum, opens one stable file
  handle, re-authorizes and compares cross-platform file identity after open,
  and reads at most `max + 1` bytes. This closes path/symlink replacement and
  concurrent-growth allocation races while retaining a 512 MiB compatibility
  backstop for legacy callers. Project open/share/watcher reads now pass their
  viewer-specific limits instead of using that compatibility ceiling.
- [ ] Avoid retaining raw bytes, decoded text, editor models, and unchanged
  baseline strings simultaneously.
- [x] Transfer code-file content ownership to the Monaco model after decoding;
  clear the duplicate IPC `Uint8Array` while keeping native-viewer bytes until
  those decoder lifecycles are independently rehydratable.
- [x] Remove the full-string baseline map where values are never read, or replace
  values with hashes/version ids where comparison is required.
- [ ] Lazily decode media and spreadsheet sheets; release inactive decoded data
  and object URLs.
- [x] Generate and retain spreadsheet HTML for only the active sheet rather than
  materialising every sheet table for the lifetime of the tab.
- [ ] Dispose inactive Monaco models, workers, language-client state, WebGL/canvas
  surfaces, image decoders, and preview resources according to an explicit
  ownership contract.
- [x] Pass document visibility through the retained pane cache, dispose inactive
  Monaco editor instances while preserving bounded view state, and unmount
  inactive file/viewer descendants without discarding the owning tab model or
  unsaved text. Resource ownership follows the same `surfaceTabId` as the host,
  including Build mode's preview-over-Engineer selection. Language clients,
  media decoders, and all model ownership remain under the broader item above.
- [ ] Bound preview request bodies, generated HTML, response copies, and decoded
  assets by bytes.
- [x] Cap buffered preview request bodies and injectable HTML at 16 MiB before
  accumulation; non-HTML responses remain streaming. Frontend decoded assets
  and generated DOM still need a separate owner budget.
- [x] Keep failed native preview closes nameable and retry them from one bounded
  Rust worker even while the main renderer remains continuous; publish only
  scalar pending/attempt/success/failure counters. A fail-then-success regression
  proves the registry handle is retained until native close succeeds.
- [ ] Audit every queue/ring/cache for owner, unit, limit, overflow behavior,
  expiry, and observability.

### E. Renderer watchdog and incident-safe recovery

- [x] Install the liveness acknowledgement before Monaco and React startup.
- [x] Give every renderer boot a Rust-issued generation and make pings/acks
  generation aware.
- [x] Coordinate native WebContent termination and heartbeat recovery through one
  reload decision state machine.
- [x] Bound heartbeat escalation to three stale 3-second observations followed
  by exactly one 3-second native pressure-shed probe before reload; recovery
  clears the probe state, minimize discards an armed probe, reload-call failure
  rolls back its slot/grace, and rate limiting suppresses further preview-probe
  churn.
- [x] Treat same-event-loop heartbeat as a renderer-stall recovery signal, not
  proof of process death; record event-loop starvation separately and never
  reload on one late observation. The preview pressure probe is relief, not an
  independent liveness oracle.
- [x] Add bounded release logging for native termination/heartbeat reload reason,
  renderer generation, suppression/rate-limit outcome, recovery start, and app
  exit PTY cleanup. Release builds persist only the watchdog module into one
  rotating 1 MiB `resilience` log; broader logs remain disabled to avoid paths,
  URLs, commands, and user text.
- [x] Exclude terminal content, prompts, secrets, full commands, and paths from
  watchdog/governor incident logs; both retain scalar metadata in bounded rings.
- [ ] Test slow Monaco initialization, deliberate event-loop stalls, genuine
  WebContent termination, and simultaneous recovery triggers.

### F. Resource accounting and user-granted terminal budgets

- [x] Mark macOS native process-tree CPU/memory as a lower bound and name the
  launchd-owned WebKit layer instead of presenting the partial number as total.
- [ ] Include the main WebContent, graphics/media, networking, preview WebContent,
  Rust host, and known child process trees in app-level accounting.
- [x] Reuse the existing two-second process scan; do not create a second full
  process-table walker.
- [x] Track current, peak, moving-average, and growth-rate footprint per terminal
  tree.
- [ ] Track the same footprint metrics per IDE/WebView layer.
- [x] Keep grant accounting and bounded, content-free transition incidents in
  Rust so they remain available when the renderer is unhealthy.
- [x] Refuse a new temporary grant when it would consume the measured host
  reserve or headroom already promised by an earlier grant.
- [ ] Protect a native/Rust control-plane reserve that does not depend on renderer
  responsiveness; monitor-only accounting cannot yet enforce this boundary.
- [x] Report platform measurement and enforcement capability honestly; macOS and
  Windows remain `monitor_only`, while Linux reports `soft_limit` only after a
  gated cgroup-v2 launch completes membership verification.
- [x] Implement monitor-only NORMAL, WARNED, AWAITING_GRANT, and OVER_ALLOWANCE
  transitions with two-sample warning debounce and clear hysteresis.
- [ ] Define NORMAL, WARNED, RELIEF, AWAITING_GRANT, PAUSED, STOPPING, and EXITED
  transitions with hysteresis and cooldowns.
- [x] Require a generation-checked, single-use explicit API call for temporary
  512 MiB or 1 GiB allowance increments; exact retries are idempotent.
- [x] Ask in a renderer dialog before a per-session allowance is raised; expose
  only the Rust-issued 512 MiB/1 GiB choices and an explicit Stop action, and
  state clearly when the platform remains monitor-only.
- [ ] Add separately confirmed, native-persisted remembered defaults for a CLI;
  do not derive them from renderer `localStorage`.
- [x] Keep grant application/refusal and state transitions in a bounded audit
  history without terminal content, prompts, commands, or paths.
- [ ] Make grant, pause, resume, and stop operations idempotent and auditable.
- [ ] Detect likely in-flight API turns before pausing where possible; warn that
  pause can time out network operations.
- [ ] Surface or lease/release file claims held by paused agents so one paused tree
  cannot block all peers indefinitely.
- [ ] On host-critical pressure, stop new heavy work, shed renderer caches and
  hidden attachments, then choose a bounded graceful-stop victim if pausing does
  not reclaim memory.
- [x] On host-critical pressure, refuse new PTY trees, pause new renderer
  byte-materialising I/O admissions, retain honest leases for work already in
  flight, compact hidden terminals immediately, and release hidden browser
  freeze frames. Automatic victim selection/graceful stop remains deliberately
  open because it can destroy an in-flight agent turn.
- [x] Refuse new PTY process trees before spawn when native pressure is critical
  or host availability has reached the protected IDE reserve; never disturb an
  already-running session as an admission-control side effect.
- [ ] Provide a non-renderer fallback decision policy when the UI cannot display
  the grant prompt.
- [x] Emit a content-free native notification, deep-linked to the terminal, when
  a session first needs a decision; automatic fallback enforcement remains open.

### G. Platform containment

- [x] Keep one platform backend/capability contract and report `monitor_only`
  unless a runtime backend completes its own spawn-time verification.
- [ ] Windows: create one Job Object per session and assign the PTY root before it
  can spawn descendants, using suspended spawn or a launcher gate.
- [ ] Windows: use job-wide notification and committed-memory limits; allow live
  limit changes and use `TerminateJobObject` for complete cleanup.
- [ ] Windows: test nested jobs, conhost/pseudoconsole placement, breakaway, WMI
  escape, allocation failure, and user-grant increases.
- [ ] Linux: create one delegated cgroup v2 subtree per session and apply
  `memory.high`, `memory.max`, `memory.current`, and `memory.events`.
- [x] Linux opt-in path: create one child of an explicitly delegated cgroup per
  future PTY, set `memory.high`, and prove launcher membership before user exec.
- [x] Linux: drive the active governor from that session cgroup's
  `memory.current` rather than comparing an RSS estimate to a different charge
  boundary.
- [x] Linux: raise `memory.high` atomically with an accepted explicit grant; a
  failed OS update does not spend the policy grant.
- [x] Linux: omit `memory.max` until allocation-failure/OOM semantics have an
  explicit user-visible recovery contract.
- [ ] Linux: support systemd user scopes/delegation and a clearly reported
  monitor-only fallback when no writable controller is available.
- [ ] Linux: test descendant inheritance, OOM behavior, live grants, cleanup, and
  distributions without delegation.
- [ ] macOS: aggregate `ri_phys_footprint` over descendants and validate it against
  Activity Monitor.
- [ ] macOS: implement process-group pause/resume as emergency growth control,
  explicitly not as reclaimed memory.
- [ ] macOS: account for network-turn loss and held claims before pause; use
  graceful group termination when critical pressure persists.
- [ ] Keep private jetsam/task-footprint SPI out of the distributable product.

### H. Verification, rollout, and operations

- [ ] Establish representative memory/output profiles for supported CLIs, MCP
  servers, language servers, build tools, and nested subprocesses.
- [ ] Add unit tests for every bound, overflow policy, state transition, and
  generation check.
- [ ] Add integration tests for renderer reload with active, idle, hidden,
  headless, and high-output PTYs.
- [ ] Add platform-specific containment tests in Windows, Linux, and macOS CI or
  dedicated runners.
- [ ] Add multi-hour soak tests for browser snapshots, previews, terminal churn,
  file switching, and reconnect cycles.
- [x] Define pass/fail footprint slopes and maximum recovery times, not only
  end-state assertions.
- [ ] Roll out behind telemetry-visible feature flags with conservative defaults.
- [ ] Provide a kill switch for governor enforcement while retaining measurement.
- [ ] Write the user-facing memory-grant, pause, recovery, and incident messages.
- [x] Publish an operational runbook for collecting bounded profiles without
  risking live terminal work.
- [x] Re-run an independent adversarial review for this atomic milestone. The
  second pass found no remaining static release blocker after fixes to active
  pane caching, pressure ordering, browser close retries, and watchdog decision
  races. Repeat this review for later milestones; runtime/platform soaks remain
  open above.

## Implementation order

### P0: terminal continuity

Ship the following as one compatibility milestone:

1. Make all PTYs Rust-owned and make renderer attachments replaceable and
   generation scoped.
2. Continue draining detached PTYs into a bounded replay ring without allowing
   acknowledgement starvation to block the child.
3. Add live-session enumeration, restore reconciliation, and gap-free reattach
   to the original PTY ids/processes.
4. Detach stale or failed renderer attachments without terminating their PTYs.
5. Remove renderer-boot `pty_kill_all` while preserving native app-exit cleanup
   and adding an explicit development orphan-reap operation.
6. Add reload, termination, startup-failure, and double-reload tests for desktop,
   headless Remote, and detached micro-task sessions.

Do this before adding more automatic renderer reload behavior.

> ⚠️ **Adversarial-review remark (2026-08-08) — steps 1–5 are ATOMIC, not
> ordered:** shipping step 1 alone is unsafe. Without reattach reconciliation,
> a reload orphans sessions the new renderer has no binding to (tab restore
> spawns *new* PTYs), and per the ack-starvation corollary in Path B, each
> orphan freezes at 2 MiB of unacked output with its child blocked on write —
> live agent turns wedge silently instead of dying visibly. Removing the boot
> call also regresses dev-workflow orphan reaping (the call's original
> purpose); the app-exit `kill_all` and an explicit dev-mode reap must remain.

### P0: reliable recovery

1. Install the heartbeat before Monaco initialization.
2. Coordinate native-termination and heartbeat reload paths.
3. Enable bounded release incident logging.
4. Record renderer generations and reload reasons.

### P1: pressure reduction

1. Stream output only to visible terminal panes.
2. Dispose or serialize inactive xterm instances after an idle period.
3. Destroy/recreate hidden preview WebViews rather than assuming reload frees
   their process heap.
4. Implement the platform `TerminalGovernor` abstraction.

### P2: policy refinement

1. Profile representative CLI and build workloads.
2. Tune dynamic defaults and grant sizes.
3. Add per-CLI remembered allowances.
4. Surface resource history and incident explanations.

## Adversarial verification plan

The independent agent should be explicitly instructed to disprove the claims.
It should not edit production code until it reports its evidence.

> ⚠️ **Adversarial-review remark (2026-08-08):** the static portions of this
> plan (section 1, and the static halves of sections 4–5) have now been
> executed — results are in "Adversarial review verdicts" above. The smallest
> remaining set of *runtime* experiments is:
>
> 1. **Channel-failure semantics** (settles C3/Path B): reload the main
>    webview and separately kill its WebContent process while a PTY streams;
>    log whether `ch.send` ever returns `Err` and whether the old session dies
>    via `terminate()` or only via the new page's `pty_kill_all`. Static
>    analysis predicts the latter.
> 2. **Heartbeat false positive** (settles C7's incident relevance): delay
>    `monacoReady` beyond ~54 s, and separately block the main event loop
>    ≥ 9 s × 3; observe whether the watchdog reloads a living renderer.
> 3. **Preview reload vs close/recreate footprint** (settles C9): section 7
>    below, unchanged.
> 4. **Double-reload race**: trigger `on_web_content_process_terminate` and
>    check whether the heartbeat path issues a second reload within its window
>    (the paths share no state — statically evident, race timing needs a run).
> 5. **Platform containment** (gates the governor only): section 6 below;
>    portable-pty exposes no suspended spawn, so open question 4 stands.
>
> C10 (incident cause) cannot be resolved by any experiment — the evidence was
> never recorded. Only the proposed release telemetry prevents recurrence of
> the ambiguity.

### 1. Static lifetime verification

Questions:

- Does every main renderer boot execute `pty_kill_all`?
- Can a WebContent reload execute that bootstrap?
- Does any path preserve a desktop-spawned PTY after its channel fails?
- Are attached/headless PTYs governed differently from desktop-spawned PTYs?
- Is `kill_all` also correctly called on native application exit, and can that
  legitimate call remain after the boot call is removed?

Suggested searches:

```sh
rg -n "pty_kill_all|ptyKillAll|kill_all\(" src src-tauri/src
rg -n "on_web_content_process_terminate|\.reload\(" src-tauri/src
rg -n "Channel<InvokeResponseBody>|session\.terminate\(\)" src-tauri/src/pty.rs
rg -n "pty_attach|attach\(" src src-tauri/src/pty.rs
```

### 2. Controlled renderer-reload reproduction

Use a development build and harmless long-running terminal commands. Do not run
the test against valuable agent sessions.

Record:

- Rust PTY id;
- root pid and descendant pids;
- a monotonically increasing marker written by the child;
- renderer generation;
- exit event and whether it was marked requested.

Trigger a normal renderer reload. Under current code, test whether the original
PTY process group receives termination. After the proposed fix, repeat multiple
reloads and assert:

- identical root pid remains alive;
- no requested `pty:exit` occurs;
- the replacement renderer reattaches;
- new input reaches the original process;
- recent output is replayed without an attach gap.

### 3. Authoritative WebContent termination test

In an isolated development session, trigger the platform's WebContent-termination
path or inject the callback through a test seam. Verify that:

- exactly one reload decision is recorded;
- heartbeat recovery does not issue a second reload;
- PTYs remain alive;
- preview and main labels are handled independently.

Avoid killing system WebKit processes outside an isolated test environment.

### 4. Heartbeat false-positive test

Artificially delay Monaco readiness beyond 45 seconds and separately block the
main JS event loop for controlled intervals. Determine whether the current
watchdog reloads a living renderer. Verify that moving the early acknowledgement
listener before Monaco eliminates slow-boot reloads, while true termination still
recovers.

Test the distinction between:

- event emit accepted by Tauri;
- event listener executed by JavaScript;
- acknowledgement command processed by Rust.

### 5. Hidden-terminal pressure test

Instrument counts rather than generating uncontrolled output:

- bytes read from each PTY;
- bytes retained in the Rust ring;
- Tauri Channel messages and bytes per terminal;
- xterm writes per visible and hidden terminal;
- renderer heartbeat latency;
- renderer physical footprint where the platform exposes it.

Open several terminals, make only one visible, and use bounded-rate output.
Confirm whether hidden terminals currently receive and parse every chunk. After
detachment, assert that hidden terminal renderer traffic approaches zero while
their CLI processes continue.

### 6. Platform-container verification

Windows:

- prove the PTY root is assigned before it can spawn descendants;
- prove descendants remain in the Job Object;
- cross notification and hard limits with a controlled allocator;
- raise the limit and confirm the same process tree continues;
- test child breakaway behavior.

Linux:

- test both delegated cgroup and no-delegation environments;
- prove all descendants appear in the session cgroup;
- cross `memory.high`, observe throttling/events, then raise it;
- cross `memory.max` only in an expendable test;
- verify fallback pause/resume without writable cgroups.

macOS:

- compare aggregate `ri_phys_footprint` with Activity Monitor for a controlled
  descendant tree;
- cross the user-space allowance and verify process-group `SIGSTOP`;
- raise allowance and verify `SIGCONT` resumes the same processes;
- confirm pause does not falsely report memory as reclaimed;
- verify critical fallback gracefully terminates the whole process group.

### 7. Preview relief verification

Measure the WebContent physical footprint across:

- no action;
- reload hidden page;
- close hidden WebView;
- close and lazily recreate it.

Use identical content and repeat enough times to expose retained allocator
capacity. Reject the close/recreate recommendation if reload consistently returns
equivalent memory without a higher transient peak.

### 8. Incident observability verification

Run a release build and induce one event of each type. Verify the rotating log
contains enough information to distinguish:

- host memory pressure;
- native renderer termination;
- heartbeat starvation;
- intentional user reload;
- pressure-driven preview destruction;
- terminal pause, grant, resume, and forced stop.

Confirm the log excludes terminal content, prompts, secrets, full command lines,
and unnecessary absolute paths.

## Acceptance criteria

The design is not complete until all of the following hold:

- Main renderer reload cannot kill or restart a PTY.
- Renderer-channel loss cannot kill a PTY.
- A replacement renderer can enumerate and reattach to every live PTY.
- Hidden terminals do not continuously send output through renderer IPC.
- Every native/Rust terminal buffer has a documented byte bound.
- Each terminal process tree has a measured aggregate footprint.
- Windows and Linux enforcement covers descendants, not only the root process.
- macOS pause/resume covers the process group and never claims to reclaim memory.
- The IDE retains a protected memory reserve and stays responsive while a
  terminal is paused at its allowance.
- User grants raise a live session's allowance without restarting it.
- Host-critical fallback works without renderer participation.
- Release incident logs identify reload initiator and reason.
- Automated tests distinguish renderer recovery from native application exit.

## Open questions

1. How many live terminal tabs and preview WebViews were present during the recent
   incident?
2. Which WebContent page label corresponded to the high custom-scheme resource
   traffic in the unified log?
3. Does the installed production build currently have any logger target not
   visible in `lib.rs`?
4. Does `portable-pty` expose the Windows suspended-spawn/Job assignment sequence,
   or is a launcher handshake required?
5. Which Linux packaging environments provide a delegated user cgroup?
6. What are representative peak footprints for each supported CLI and its common
   MCP/language-server descendants?
7. What scrollback fidelity is required after renderer reattachment: raw byte
   ring, a bounded server-side terminal parser, or durable transcript integration?
8. Should an unanswered critical-pressure prompt terminate the largest offender,
   the least recently active agent, or use a combined score?

## Independent-agent prompt

The following can be given directly to another agent:

> Adversarially review `docs/terminal-memory-webview-resilience-research.md`.
> Your job is to falsify its claims, not endorse them. Inspect the current code,
> git history, tests, and platform documentation. For every claim C1-C12, report
> Confirmed, Refuted, Partially true, or Unverified, with file/line evidence.
> Reconstruct the renderer-to-PTY lifetime graph independently. Pay special
> attention to whether WebView reload really executes `main.tsx`, whether channel
> failure necessarily reaches `session.terminate`, whether any hidden-terminal
> optimization was missed, and whether Windows/Linux/macOS controls can contain
> the complete descendant tree and be raised dynamically. Separate the cause of
> the recent incident from the consequence of a renderer reload. Do not modify
> production code. End with the smallest set of experiments needed to resolve
> remaining uncertainty and flag any recommendation that could itself lose work.
