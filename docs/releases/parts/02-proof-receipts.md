## "Done" now needs proof: workspace receipts

An agent saying "fixed, all tests pass" is a claim. Canopy now checks it.

**What you see**

- When an agent finishes a turn that changed files, its status shows a
  **receipt** instead of a plain "finished": **✓ Proven**, **◐ Partial**,
  **✗ Unproven**, **⚠ Tests changed**, **… Verifying** or **— Unverified**.
  It appears on the agent's row in the Agents panel and page, in the control
  panel's table, on the "finished" card, in the agent's workspace tab, and on
  one-shot tasks that are wrapping up.
- Click it to open the receipt:
  - **Asked / Did** — the brain's plain-language reading of your request
    against what the change actually does.
  - **Agent says** — the agent's own closing words, shown separately from
    **Workspace verified**, so a claim never passes for proof.
  - Every check Canopy ran — the command, exit code, pass/fail counts and
    time — with the raw output one click away.
  - **Test changed by the agent — needs a human look** when the agent
    rewrote or removed an assertion, switched a test off or deleted a test file.
  - **New packages** the agent added, and whether each actually exists on
    npm, crates.io or PyPI ("unknown package" if the registry has never heard of it).
- **Re-verify**, **Copy receipt** (markdown), **Share…** (to team chat), and,
  when the receipt is not proven, **Tell the agent**: types a short factual
  summary ("npm run test failed (1 failing: …); src/sum.test.ts was modified")
  into the agent's terminal.
- **Raise PR** now ends the pull request body with a "Verification receipt"
  section copied verbatim from the branch's latest receipt.

**How it decides**

Canopy runs the project's own checks itself — tests, typecheck and lint from
package.json, `cargo test`, `go test ./...`, pytest or `make test` — in a
separate process, not in the agent's terminal (in a Linux cloud workspace they
run inside the workspace). A run that finds zero tests is not a pass, and a run
stopped at the time limit says "timed out", never "failed". Then the brain
judges the request against that raw evidence. The brain can only lower the
result: any failing check, zero-test run, changed test or unknown package means
the receipt can never read "Proven". Without a brain, passing checks reach
"Partial" at most.

**When the brain is used**

Once per verified turn, on the background (cheaper) model, with the request,
a capped diff and the check output. Identical evidence reuses the earlier
verdict instead of asking again. Spend shows under the `receipt` feature in the
brain meter and respects its budgets.

**Turning it off or changing it**

Settings → Agents → **Proof receipts**: *After every turn* (default), *When I
ask* (only on Verify now), or *Off* (no checks, no badges). To choose which
commands prove a project, open any receipt and use **Set check commands…**
(one per line); Settings lists projects with their own commands and can return
them to detected checks.
