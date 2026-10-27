// A proof-receipt check in a Linux workspace. A test suite can run for up to
// twenty minutes (receipt-check.mjs's ceiling), far longer than the gateway
// holds one request open, so the check runs as a job on the host and this
// long-polls for its answer. An older host that only knows receipt_run_check
// still gets the single long request.
type Native = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

type Status =
  | { state: "running" }
  | { state: "done"; result: unknown }
  | { state: "failed"; error: string };

const POLL_WAIT_MS = 8000;
/** Polls that may fail in a row (a reconnect) before the check is given up. */
const MAX_POLL_FAILURES = 6;

export async function workspaceReceiptCheck(
  native: Native,
  args: Record<string, unknown>,
  disposed: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<unknown> {
  let id: string;
  try {
    id = (await native<{ id: string }>("receipt_check_start", args)).id;
  } catch (error) {
    if (/does not support receipt_check_start yet/.test(String(error))) return native("receipt_run_check", args);
    throw error;
  }
  let failures = 0;
  for (;;) {
    if (disposed()) throw Error("Workspace disconnected while the check was running");
    let status: Status;
    try {
      status = await native<Status>("receipt_check_status", { id, wait: POLL_WAIT_MS });
      failures = 0;
    } catch (error) {
      if (/No such check/.test(String(error)) || ++failures >= MAX_POLL_FAILURES) throw error;
      await sleep(1000 * failures);
      continue;
    }
    if (status.state === "done") return status.result;
    if (status.state === "failed") throw Error(status.error);
  }
}
