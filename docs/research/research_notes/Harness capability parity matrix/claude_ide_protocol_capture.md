# Claude Code IDE integration protocol: verified capture (Claude Code 2.1.310)

Captured 2026-10-26 by driving the real `claude` binary against a logging fake IDE server. Every claim is tagged:

- **[observed run X]**: seen on the wire or in the TUI/transcript during capture run X (run logs listed in the appendix).
- **[binary]**: read from the JS bundled in the 2.1.310 executable (`strings` / byte search). The code is minified, so identifiers are not stable across versions, but the logic is quoted closely.
- **[community]**: comes only from claudecode.nvim / PROTOCOL.md and was **not** confirmed here.

## 1. Environment & versions

| Item | Value |
|---|---|
| Claude Code | `2.1.310 (Claude Code)`, native ELF (Bun-compiled), `GIT_SHA 0d2056ec…`, `BUILD_TIME 2026-10-23T17:43:32Z` |
| OS | Linux 7.0.0-1012-aws (x86_64), no WSL |
| Node (fake IDE) | v24.18.0, `ws@8` |
| Auth | Claude Max subscription via `$CLAUDE_CONFIG_DIR/.credentials.json` |
| Config dir | `CLAUDE_CONFIG_DIR=/home/agent/.canopy/profiles/vj/.claude` (a Canopy profile dir). **Canopy already sets `CLAUDE_CONFIG_DIR` per profile, so lock files must go in `$CLAUDE_CONFIG_DIR/ide/`** (see §2.1). |
| Reference | `coder/claudecode.nvim` @ HEAD (cloned 2026-10-26): `lua/claudecode/server/*`, `tools/*`, `lockfile.lua`, `PROTOCOL.md` |

How the child was launched: in a real PTY (Python `pty.fork`, 160x50, `TERM=xterm-256color`) with cwd = a scratch workspace folder. Removed from the environment: `CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED CLAUDE_EFFORT TERM_PROGRAM` and all `CANOPY_*` vars. `CLAUDE_CONFIG_DIR` was kept so auth worked.

**Nesting:** after those vars were unset, running inside another Claude Code session did not interfere. The child still loaded the user settings: the Canopy hooks ran, and the `canopy` MCP server from `.claude.json` connected. Neither affected the IDE channel.

## 2. Discovery and connect rules

### 2.1 Lock-file directories [binary]
The CLI scans these directories, newest `*.lock` first by mtime:
1. `$CLAUDE_CONFIG_DIR/ide` (or `~/.claude/ide` when the var is unset)
2. **also** `~/.claude/ide` when `CLAUDE_CONFIG_DIR` is set
3. on WSL only: `%USERPROFILE%\.claude\ide` and `/mnt/c/Users/*/.claude/ide`

### 2.2 Lock-file parsing [binary]
- The port is taken from the **file name** (`<port>.lock`), not from the content.
- Fields read: `workspaceFolders` (string[]), `pid`, `ideName`, `transport` (`"ws"` means WebSocket; anything else means legacy `http://host:port/sse`), `runningInWindows` (bool), `authToken`.
- If the JSON fails to parse, the whole file is read as newline-separated workspace folders (legacy format).
- The CLI does **not** check file mode (0600) or directory mode. claudecode.nvim uses 0600/0700 and we did the same.
- **Stale-lock deletion [binary]:** at the start of each IDE search the CLI **deletes** any lock file whose `pid` is not alive (`process.kill(pid,0)` fails). If there is no `pid`, it deletes the file when the TCP port is unreachable within 500 ms. It also deletes unreadable lock files. So `pid` must be a live process **in the same PID namespace as `claude`**.

Lock we wrote (works) [observed A]:
```json
{"pid":<fake-ide pid>,"workspaceFolders":["<WS>"],"ideName":"Canopy","transport":"ws","authToken":"<uuid>"}
```

### 2.3 When the CLI tries to connect at all [binary + observed]
`shouldAutoConnect`:
```
if (CLAUDE_CODE_AUTO_CONNECT_IDE === false) → no
if (CLAUDE_CODE_SIMPLE || --bare) → only if forced
else → config.autoConnectIde || --ide || inSupportedIdeTerminal (TK) || CLAUDE_CODE_SSE_PORT set || CLAUDE_CODE_AUTO_CONNECT_IDE === true
```
`TK` is true when `TERM_PROGRAM` identifies VS Code, Cursor, Windsurf or JetBrains, or `FORCE_CODE_TERMINAL` is set.

Search loop [binary]: poll every 1 s for up to 30 s. **Auto-connect happens only when exactly one candidate has `workspaceContainsCwd`.**

Candidate matching [binary]:
- `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` set, **or** `lock port == CLAUDE_CODE_SSE_PORT`: treated as matching, with no workspace check.
- Otherwise some `workspaceFolders` entry must contain cwd (after NFC normalization and drive-letter upper-casing). Auto-connect considers only this "contains cwd" case. When `/ide` builds its list, locks with unrelated workspaces are **not** skipped: every lock is listed, subject to the TK ancestor filter. "Inside cwd" or "contains cwd" only sets an `isValid` display attribute.
- When `TK` is true and the port is not `CLAUDE_CODE_SSE_PORT`, the lock `pid` must be alive **and** be `process.ppid` or one of claude's ancestors (walks up 10 levels). This is the VS Code integrated-terminal rule.
- When `CLAUDE_CODE_SSE_PORT` is set and exactly one valid candidate has that port, only that one is returned.
- Host is `127.0.0.1`, or `CLAUDE_CODE_IDE_HOST_OVERRIDE` if set. On WSL with `runningInWindows`, the default gateway IP is probed instead.

Observed matrix. Each run used one fake IDE with ideName "Canopy", the cwd was the workspace unless noted, and each run waited 14 s:

| Run | Env / flags | Lock workspace | Result |
|---|---|---|---|
| B0 | none | = cwd | **no connect** (default: `autoConnectIde` unset, not TK) |
| A | `CLAUDE_CODE_AUTO_CONNECT_IDE=true` | = cwd | **connect** (~10 s after launch; delayed by the trust dialog) |
| B1 | `CLAUDE_CODE_SSE_PORT=<port>` | = cwd | **connect** |
| B2 | `CLAUDE_CODE_SSE_PORT=<port>` | unrelated dir | **connect** (SSE_PORT bypasses the workspace check) |
| B3 | `--ide` flag | = cwd | **connect** |
| B4 | `AUTO_CONNECT_IDE=true` | unrelated dir | no connect |
| C1 | `FORCE_CODE_TERMINAL=1` | = cwd | **no connect**. Matches the ancestor-pid rule; the fake IDE was not an ancestor. I did not run a positive control with the IDE as an ancestor. |
| C2 | `FORCE_CODE_TERMINAL=1` + `SSE_PORT` | = cwd | **connect** (SSE_PORT bypasses the ancestor rule) |
| B5 | `AUTO_CONNECT_IDE=true`, **two** matching locks | = cwd (both) | **no connect to either** (ambiguous) |
| B5s | `SSE_PORT=<second port>`, two matching locks | = cwd (both) | connects to the **SSE_PORT** one; `/ide` lists both, with ✔ on that one |
| B6 | `SSE_PORT`, lock token ≠ server token | = cwd | one upgrade attempt, server returns 401, **no retry within 25 s**; TUI shows "Canopy disconnected" |

`CLAUDE_CODE_SSE_PORT` is a misleading name. It only selects which lock file/port to use; the transport still comes from the lock's `transport` field. `ENABLE_IDE_INTEGRATION` **does not occur anywhere in the 2.1.310 binary** [binary]. Env vars present in the binary: `CLAUDE_CODE_AUTO_CONNECT_IDE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_IDE_SKIP_VALID_CHECK`, `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`, `CLAUDE_CODE_IDE_HOST_OVERRIDE`, `FORCE_CODE_TERMINAL`.

### 2.3a Manual `/ide` connect [observed M1–M3]
`/ide` opens "Select IDE" with ✔ on the **currently selected** entry. ✔ means selected, not connected: B6 showed `✔ Canopy` next to "Canopy disconnected", and M1 showed `✔ None`. With no auto-connect env, the cursor starts on "None". Choosing "Canopy" opens a follow-up dialog, "Enable auto-connect to IDE? Yes / No (default)". Yes would persist `autoConnectIde` in global config; that was not chosen. Answering No (M3) or Esc (M2) still connects immediately and prints "Connected to Canopy." The trigger is only the 1 s × 30 s search, so **a lock written after that window can only be picked up through `/ide`**.

### 2.4 Reconnect behaviour [observed R1/R2]
- R1: the IDE server was killed and restarted on the same port with a **new** token and a new lock. The CLI made 2 reconnect attempts, at about +7 s and +15 s after the drop. Both sent the **old cached token**, got 401, and the CLI gave up ("Canopy disconnected"). It does not re-read the lock file.
- R2: restarted on the same port with the **same token** about 3.5 s after the drop. Reconnected at +7.4 s with a full handshake again (`initialize`, `notifications/initialized`, `ide_connected`, `tools/list`, `prompts/list`).
- R2c: the server stayed down for 20 s and then came back with the same token. **No reconnect** within the next 55 s.
- The client never sent WS pings during any run (0 pings logged across all runs).
- On `/exit` the client closes with WS code **1005** (no status) [observed A, D5].

## 3. Handshake frames (verbatim, secrets redacted) [observed A, every run]

HTTP upgrade (`GET /`):
```
host: 127.0.0.1:<port>
connection: Upgrade
upgrade: websocket
sec-websocket-version: 13
sec-websocket-extensions: permessage-deflate; client_max_window_bits
sec-websocket-key: <random>
sec-websocket-protocol: mcp
user-agent: claude-code/2.1.310 (cli)
x-claude-code-ide-authorization: <authToken from lock>
```
No `Origin` header. Path is `/`.

- **The server must accept the `mcp` subprotocol.** In run S1 the server accepted the upgrade without echoing `mcp`, and the client dropped the socket after about 70 ms (close 1006) before sending `initialize` [observed S1]. The binary opens with `new WebSocket(url, {protocols:["mcp"], headers})` [binary].
- Frames are WebSocket **text** frames, one JSON-RPC 2.0 message per frame. permessage-deflate is offered; our server did not negotiate it and everything still worked.

Sequence (client → server is "→"):
```json
→ {"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{},"extensions":{"io.modelcontextprotocol/tasks":{}}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.310","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}},"jsonrpc":"2.0","id":0}
← {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","capabilities":{"logging":{},"prompts":{"listChanged":true},"tools":{"listChanged":true}},"serverInfo":{"name":"canopy-fake-ide","version":"0.0.1"}}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","method":"ide_connected","params":{"pid":<claude pid>}}
→ {"method":"tools/list","jsonrpc":"2.0","id":1}
→ {"method":"prompts/list","jsonrpc":"2.0","id":2}
```
- Answering `initialize` with `"protocolVersion":"2024-11-05"` (what claudecode.nvim does) also works: the full session, including diff and diagnostics, ran normally [observed G1].
- `tools/list` and `prompts/list` are both requested in parallel immediately after `ide_connected`. `resources/list` was **not** requested (we did not advertise resources).
- Server→client requests work over the same socket [observed G1]:
  - `ping` → `{"result":{}}`
  - `roots/list` → `{"result":{"roots":[{"uri":"file://<cwd>"}]}}`
- `ide_connected.params.pid` is the claude process pid. It is useful for mapping a connection to a Canopy PTY.

## 4. tools/list expectations

**What the CLI actually does with the tool list [binary + observed]:**
- Only **`mcp__ide__getDiagnostics`** and **`mcp__ide__executeCode`** are exposed to the model. A hard-coded allow-list in the binary drops every other `mcp__ide__*` tool. In run A's transcript, the model's deferred-tool list contained exactly those two out of the 12 advertised.
- The CLI calls `openDiff`, `close_tab`, `closeAllDiffTabs` and `getDiagnostics` **directly by name**. It does not check whether they appear in `tools/list`. In G1, `tools/list` advertised only `getDiagnostics`, and the CLI still called `closeAllDiffTabs`, `openDiff` and `close_tab` [observed G1].
- The strings `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty` and `saveDocument` appear **nowhere** in the 2.1.310 binary as IDE RPC names [binary]. The CLI never calls them, and the model cannot see them. They come from older or extension-specific protocol versions.

Minimum tool surface Canopy needs to serve: `openDiff`, `close_tab`, `closeAllDiffTabs`, `getDiagnostics`, and optionally `executeCode`. Advertise those in `tools/list`, with names and schemas as below. The model-visible descriptions only matter for `getDiagnostics` and `executeCode`.

```json
{"name":"getDiagnostics","description":"Get language diagnostics (errors, warnings) from the editor",
 "inputSchema":{"type":"object","properties":{"uri":{"type":"string","description":"Optional file URI to get diagnostics for. If not provided, gets diagnostics for all open files."}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}}
{"name":"openDiff","inputSchema":{"type":"object","properties":{"old_file_path":{"type":"string"},"new_file_path":{"type":"string"},"new_file_contents":{"type":"string"},"tab_name":{"type":"string"}},"required":["old_file_path","new_file_path","new_file_contents","tab_name"],"additionalProperties":false}}
{"name":"close_tab","inputSchema":{"type":"object","properties":{"tab_name":{"type":"string"}},"required":["tab_name"]}}
{"name":"closeAllDiffTabs","inputSchema":{"type":"object","properties":{}}}
{"name":"executeCode","inputSchema":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}}
```
Our `executeCode` schema follows the community/VS Code convention (`{code}`). I did not trigger an `executeCode` call; the model only uses it for Jupyter notebooks. Its real input and output shapes are **unverified**.

## 5. Tool calls observed

Every `tools/call` from the CLI carries `params._meta.progressToken` (an integer). Results are standard MCP `{content:[{type:"text",text:...}]}`.

### 5.1 `closeAllDiffTabs` [observed A, D*, G1]
Sent with `{}` **on each prompt submit** (G1: 2 prompts → 2 calls), before the model runs, whenever the IDE is connected. The CLI ignores the result (errors are swallowed) [binary]. We answered `CLOSED_0_DIFF_TABS`.

### 5.2 `openDiff`: the IDE diff as a permission prompt [observed D2–D5, T1]
Triggered when **all** of the following hold [binary]:
- The tool is Edit or Write (MultiEdit was not checked).
- A permission prompt is actually shown. With `--permission-mode default` it fired. With `acceptEdits` [D6] and the user-configured `auto` mode [D7], **no `openDiff` was sent** and the edit was applied directly.
- Global config `diffTool` is `"auto"`, which is the default. `/config` → "Diff tool" can set `"terminal"` to disable it.
- The IDE client is connected, and the path is not excluded (e.g. internal `.claude` paths).

Request (D2):
```json
{"method":"tools/call","params":{"name":"openDiff","arguments":{
  "old_file_path":"<WS>/hello.py","new_file_path":"<WS>/hello.py",
  "new_file_contents":"def greet():\n    return \"howdy\"\n",
  "tab_name":"✻ [Claude Code] hello.py (84bf2c) ⧉"},"_meta":{"progressToken":4}},"jsonrpc":"2.0","id":4}
```
- `old_file_path` == `new_file_path`, an absolute local path. `new_file_contents` is the **whole file** after the edit.
- `tab_name` = `✻ [Claude Code] <basename> (<6 hex chars>) ⧉`.
- At the same time the terminal shows `Opened changes in Canopy ⧉` plus the normal `Do you want to make this edit…? 1 Yes / 2 Yes, and switch to accept edits / 3 No`. **Whichever answers first wins.**
- The call is **blocking with no timeout**: answering after 100 s still worked [observed T1].

Result handling. Rows marked [observed] were run; the binary decision logic matches them:

| IDE result | CLI behaviour |
|---|---|
| `[{"type":"text","text":"FILE_SAVED"},{"type":"text","text":"<final file contents>"}]` | **Accept.** The CLI writes **`content[1].text`** to disk. If it differs from the proposal, the tool result says `"…has been updated successfully.  The user modified your proposed changes before accepting them."` and `userModified:true`. D2: we appended `# EDITED_IN_IDE`, it landed on disk, and the model was told. `content[1]` is **required**; the check is `typeof e[1].text==="string"`. |
| `[{"type":"text","text":"DIFF_REJECTED"}]` | **Reject.** The tool result is the standard user-rejection text, followed by `[Request interrupted by user for tool use]`, and the **turn is aborted**. TUI: "User rejected update to hello.py" [D3]. |
| `[{"type":"text","text":"TAB_CLOSED"}]` | **Accept with the original proposal**: the file was edited [D4]. **Do not use TAB_CLOSED to mean "user dismissed/rejected".** |
| anything else | Throws "Not accepted"; the error is logged and the terminal prompt stays authoritative [binary]. |

After any resolution the CLI sends `close_tab` with the same `tab_name`, **twice** in a row (D2–D4, T1). If the user answers in the **terminal** first, the CLI sends `close_tab` once, and the pending `openDiff` request is **never cancelled**: no `notifications/cancelled` was sent [D5]. The IDE must treat `close_tab(tab_name)` as "discard the pending diff and drop the request". Any late reply to that id is ignored.

### 5.3 `close_tab` [observed D2–D5]
`{"tab_name":"✻ [Claude Code] hello.py (bf5015) ⧉"}`. We replied `TAB_CLOSED`; the result is ignored apart from logging.

### 5.4 `getDiagnostics` [observed D2, D4–D7, G1, T1; binary]
Two different calls bracket every file write made by Edit/Write in **every** permission mode, including acceptEdits and auto:
1. **Baseline**, just before the write: `{"uri":"file://<abs path>"}`. **Timeout is 500 ms.** After 3 consecutive timeouts, baselines are disabled for the session. If `result[0].uri` does not normalize to the same path, the baseline is discarded (`path_mismatch`). The call is skipped when the server's `serverInfo.name` is `"Claude Code JetBrains Plugin"`.
2. **New-diagnostics fetch**, about 150 ms to 2 s after the write, and again at later query steps: `{}`. **Timeout is 2000 ms.** Only one is in flight at a time. Only files that have a baseline are considered. URIs must start with `file://` (or the internal `_claude_fs_right:`). New = present now but not in the baseline, keyed on `(message, severity, source, code, range)`.

Result format the CLI parses: the first `text` content item, JSON-parsed as
```json
[{"uri":"file:///abs/path","diagnostics":[{"message":"…","severity":"Error|Warning|Info|Hint","source":"…","code":"…","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}]}]
```
`line` and `character` are **0-based**. Severity is a **string**; unknown values are treated as Hint.

What the model sees. In D2 the baseline returned `[]` and the fetch returned one error. The model got this attachment (rendered as a system-reminder, lines converted to 1-based):
```
<new-diagnostics>The following new diagnostic issues were detected:

hello.py:
  ✘ [Line 2:1] CANARY_DIAG: undefined name "frobnicate" (fake-lsp)</new-diagnostics>
```
When baseline and fetch return the same diagnostics, nothing reaches the model (D, D4).

The model can also call `mcp__ide__getDiagnostics` itself (a deferred tool). That was not exercised here.

## 6. Notifications

### 6.1 IDE → CLI `selection_changed` [observed A, G1; binary schema]
CLI schema (zod): `params: { selection?: {start:{line,character}, end:{line,character}} | null, text?: string, filePath?: string }`. `fileUrl` and `isEmpty` are accepted but ignored.

| Sent | TUI footer | Effect on the next prompt |
|---|---|---|
| 1-line selection with text | `[⧉ 1 line selected]` | Attachment `selected_lines_in_ide` with `ideName` (from the lock), `lineStart`/`lineEnd` (1-based), `filename`, `content`. Rendered to the model as: `The user selected the lines 2 to 2 from <abs path>:\n    return "hello"\n\nThis may or may not be related to the current task.` The TUI echoes `⎿ ⧉ Selected 1 lines from hello.py in Canopy`. The model repeated the text and line exactly [A]. |
| 2-line selection | `[⧉ 2 lines selected]` | (same) |
| end at `character:0` on the next line | `1 line selected` | lineCount = end.line − start.line + 1, minus 1 when end.character is 0 |
| empty selection (start == end, `text:""`) | `[⧉ In hello.py]` | Attachment `opened_file_in_ide`: `The user opened the file <abs path> in the IDE. This may or may not be related to the current task.` [G1, verified with a model call] |
| `selection: null` / missing start or end | unchanged | Ignored; the previous state is kept. To clear, send an empty selection, which becomes the opened-file state. |

The selection is attached when the user submits a prompt. The CLI does not poll `getCurrentSelection` or `getLatestSelection`.

### 6.2 IDE → CLI `at_mentioned` [observed A]
`{"filePath":"<abs>","lineStart":0,"lineEnd":1}` caused `@hello.py#L1-2 ` (relative to cwd, 1-based, trailing space) to be **inserted into the prompt input box**. Nothing is sent to the model until the user submits. If `lineStart`/`lineEnd` are omitted, `@hello.py ` is inserted [binary].

### 6.3 Other methods [binary]
- IDE → CLI `log_event {eventName, eventData}` is forwarded to telemetry as `tengu_ide_<eventName>`. Not useful to Canopy.
- CLI → IDE `ide_connected {pid}` (see §3).
- `experiment_gates` and `set_permission_mode` are sent only to the `claude-vscode`/SDK channel, **not** to the `ws-ide` client. Neither was seen on our socket.

## 7. Headless behaviour [observed F1–F4]
`claude -p "…" --output-format stream-json --verbose` **never connects to the IDE**. Tested with `CLAUDE_CODE_AUTO_CONNECT_IDE=true` (F1), with `CLAUDE_CODE_SSE_PORT` (F2), with `--ide` (F3), with all three together plus a 15 s Bash `sleep` to rule out timing (F4), and in the bidirectional `-p --input-format stream-json` mode that SDK embedders use, with all three triggers and stdin held open for 20 s (F5). Zero upgrade attempts each time. `system/init` listed no `ide` server and no `mcp__ide__*` tools. **The IDE integration only works in the interactive TUI**, so Canopy's PTY sessions qualify and `-p` sessions (including stream-json input) do not. The Agent SDK itself was not run; it drives the same `-p --input-format stream-json` path, so the same result is expected.

## 8. ideName sensitivity [observed A, N-*; binary]
- `ideName` is display-only. With `"Canopy"`, `"Visual Studio Code"` and `"Windsurf"`, the frames were identical (same handshake, same calls).
- Display: `/ide` lists `✔ Canopy`, `✔ Visual Studio Code` (with the extra note "Only one Claude Code instance can be connected to VS Code at a time.") or `✔ Devin Desktop` (the CLI rewrites "windsurf" to "Devin Desktop"). The selection echo and the model attachment carry `ideName`: "…from hello.py in Canopy". The diff prompt says "Opened changes in Canopy ⧉".
- Extension auto-install and "is VS Code" logic key off the **terminal** (`TERM_PROGRAM`/TK), not off `ideName`. No difference was observed.
- `/mcp` does not list the IDE connection; `/ide` is the status surface.

## 9. Failures / unknowns
- **Requires an interactive TTY:** the whole IDE channel (§7). On first launch in an untrusted folder, the trust dialog ("Yes, I trust this folder", default "No, exit") blocks startup, and the IDE connects only after it is accepted. Accepting it adds a trust entry to `$CLAUDE_CONFIG_DIR/.claude.json` (claude does this itself).
- **Model calls needed:** only to make the model act (edits, which trigger `openDiff`/`getDiagnostics`) or to check what context reached it. Discovery, handshake, `/ide`, `selection_changed` display and `at_mentioned` all work without one. Total spend was about 12 tiny prompts.
- **Not verified:**
  - `executeCode` shapes.
  - MultiEdit/NotebookEdit diff behaviour.
  - The model calling `mcp__ide__getDiagnostics` on its own.
  - The positive case of the TK ancestor-pid rule.
  - WSL / `runningInWindows` / `CLAUDE_CODE_IDE_HOST_OVERRIDE` paths (binary only).
  - The legacy SSE transport (`transport` ≠ `"ws"`).
  - Exact reconnect backoff constants. Observed: about +7 s and +15 s, then it gives up.
  - Whether the CLI tolerates a server that never answers `tools/list`.
- Plan mode and bypassPermissions were not tested for `openDiff`. Expectation from the binary: `openDiff` fires only where a permission prompt for Edit/Write appears.
- The binary is minified. The constants (500 ms / 2000 ms / 3 timeouts / 30 s search) are from 2.1.310 and may change.

## 10. Recommended implementation contract for Canopy

1. **Server:** one WebSocket server per Canopy *agent PTY session*, bound to `127.0.0.1` on a random free port, **on the same host/VM and PID namespace as the `claude` process**. For remote workspaces this means inside the remote host agent, not on the desktop. Accept upgrades only when `x-claude-code-ide-authorization` matches, using a constant-time compare. Otherwise return 401. **Echo `Sec-WebSocket-Protocol: mcp`** (required). Text frames, one JSON-RPC message each.
2. **Lock file:** write it **before spawning the PTY**. The CLI searches only once per second for the first 30 s after launch; after that, only `/ide` will find it. Write it atomically (temp file plus rename, 0600, directory 0700) to `$CLAUDE_CONFIG_DIR/ide/<port>.lock`, using the same `CLAUDE_CONFIG_DIR` the PTY gets. Content: `{"pid":<live pid of the long-lived server process>,"workspaceFolders":[<component root>],"ideName":"Canopy","transport":"ws","authToken":"<≥32 random hex>"}`. Delete it on shutdown. If `pid` dies, *any* claude process will delete the file.
3. **Launch env for the PTY:** set `CLAUDE_CODE_SSE_PORT=<port>`. This alone enables auto-connect, pins the session to *its* server even when several Canopy locks match the cwd, and skips both the workspace-match and the ancestor-pid checks. Do **not** set `TERM_PROGRAM=vscode` or `FORCE_CODE_TERMINAL`: TK mode adds the ancestor-pid requirement (SSE_PORT bypasses it, but there is no benefit) and makes the CLI try to install the VS Code extension. Optional: `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1`. Do not rely on `CLAUDE_CODE_AUTO_CONNECT_IDE=true` alone, because two Canopy sessions in the same folder make auto-connect ambiguous, so neither connects (B5).
4. **Token stability:** keep the same token and port for the lifetime of the PTY session. After a server restart, the CLI reconnects only with the cached token, and only within about 15 s (R1/R2). For longer outages the user must run `/ide`; ideally Canopy restarts the claude session or types `/ide` for them.
5. **Handshake:** answer `initialize` echoing the client's `protocolVersion` (or `2024-11-05`), with `capabilities:{tools:{listChanged:true},prompts:{listChanged:true},logging:{}}` and a `serverInfo.name` that is **not** `"Claude Code JetBrains Plugin"`. Answer `prompts/list` → `{prompts:[]}` and `ping` → `{}`. Treat `ide_connected {pid}` as the binding between the socket and the PTY. Return `-32601` for unknown methods.
6. **Tools to implement** (advertise only these):
   - `closeAllDiffTabs {}`: close any stale Canopy diff views for this session. Return any text.
   - `openDiff {old_file_path,new_file_path,new_file_contents,tab_name}`: show a diff in the Canopy editor and hold the request open with no timeout.
     - Accept: `[{text:"FILE_SAVED"},{text:<final contents>}]`. Canopy may let the user edit the right-hand side, and the CLI writes those contents.
     - Reject: `[{text:"DIFF_REJECTED"}]`. This aborts the turn.
     - If Canopy cannot render the diff, return a JSON-RPC error. The CLI logs it (`ide_diff_view_failed`), still sends `close_tab`, and the terminal permission prompt remains the fallback [binary].
     - Never send `TAB_CLOSED` as a reply to `openDiff` unless you mean "accept as proposed".
     - Key the pending diff by `tab_name`.
   - `close_tab {tab_name}`: close that diff and drop its pending `openDiff` without replying (or reply; it is ignored). Expect it twice, and expect it while `openDiff` is still pending (the user answered in the terminal). Return `TAB_CLOSED`.
   - `getDiagnostics {uri?}`: answer from Canopy's warm LSP cache, **within 500 ms for the `uri` form** and within 2 s for the workspace form. Return `[{uri:"file://…",diagnostics:[{message,severity:"Error"|"Warning"|"Info"|"Hint",source,code,range:{start:{line,character},end:{…}}}]}]` (0-based). For the `uri` form, `result[0].uri` must be that same file. Return `[]` rather than an error when nothing is known. Canopy should refresh the LSP after the write so the `{}` fetch reflects the new content.
   - `executeCode`: optional. Not verified; return an error text if unsupported.
7. **Notifications to send:**
   - `selection_changed {text, filePath, selection:{start,end}}` (0-based) whenever the active editor selection changes. Debounce it, and send an empty selection (start == end, `text:""`) to mean "file open, nothing selected". Sending `null` does not clear.
   - `at_mentioned {filePath, lineStart?, lineEnd?}` (0-based) for an "Add to Claude" action. It inserts `@path#Lx-y` into the prompt box without submitting.
8. **Do not bother implementing** `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty` or `saveDocument` for Claude Code 2.1.310. They are never called and never exposed to the model.
9. **Scope:** interactive PTY sessions only. Headless `-p`/SDK runs get no IDE channel, so Canopy has to handle those through its own MCP server.
10. **UX nuance:** the diff appears only when Claude Code would show a permission prompt for an edit (default/manual mode). In `acceptEdits` or `auto` mode, edits apply directly, and Canopy sees only the `getDiagnostics` pair around each write. If Canopy wants to show those edits, it has to watch the file system or the hooks.

## Appendix: capture scripts and logs
All files are in `/scratch/claude-1000/-workspace-p-muy5cwnw-fn9waa-repo-1-canopy-ide/fba7413e-f9bd-4860-b733-ede50bb38a9a/scratchpad/ide-capture/`:
- `ide-server.mjs`: logging fake IDE. Options: `--port --workspace --ide-name --log --diff-mode save|reject|close|pending --diff-delay ms --diff-override --diag-mode baseline-empty --proto --tools a,b --token --lock-token --no-subproto`. The control port is port+1: `POST /notify {method,params}`, `POST /request {method,params}`.
- `pty-driver.py`: runs a command in a PTY and logs `pty.raw`/`pty.txt`; keystrokes come in through `ctl.fifo`.
- `run-claude.sh`, `send.sh`, `start-server.sh`, `stop.sh`, `edit-test.sh`, `connect-test.sh`, `headless-test.sh`: drivers for the runs above.
- Manual `/ide` runs are M1–M3; the stream-json headless run is F5.
- `runs/<RUN>/frames.jsonl`: every WS frame with a timestamp. Also `server.out`, `pty.txt`, and `stream.jsonl` for the F runs. These logs contain auth tokens for dead servers.
- `ctx.py`, `ctx_methods.txt`, `ctx_workspaceFolders.txt`, `claude-strings.txt`: binary-extraction helpers and excerpts.
- `ref/claudecode.nvim`: the reference clone.
- Child-session transcripts were written by the child claude (not deleted) under `$CLAUDE_CONFIG_DIR/projects/-scratch-claude-1000--workspace-…-ide-capture-ws/`.
