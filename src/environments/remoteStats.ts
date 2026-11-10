// Process readings for the terminals this window started on other machines, in
// the shape and under the ids the local readings use, so the Agents panel, the
// team board and the card count them with no special case.
//
// Only terminals this window started there (those with an alias) are kept:
// anyone else's sessions on that workspace are not this window's business. A
// machine that is slow or silent adds nothing and never delays the local rows.
import type { Host } from "../host/contract";
import type { SessionStats } from "../ipc";
import { aliasOf, routedHosts } from "./ptyRoute";

export const REMOTE_STATS_TIMEOUT_MS = 2_000;

export function rekeyStats(env: string, rows: readonly SessionStats[]): SessionStats[] {
  const out: SessionStats[] = [];
  for (const row of rows) {
    const alias = aliasOf(env, row.id);
    if (alias !== undefined) out.push({ ...row, id: alias });
  }
  return out;
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

export async function remoteStats(
  machines: readonly { env: string; host: Pick<Host, "invoke"> }[] = routedHosts(),
  timeoutMs = REMOTE_STATS_TIMEOUT_MS,
): Promise<SessionStats[]> {
  if (machines.length === 0) return [];
  const lists = await Promise.all(
    machines.map((m) =>
      withTimeout(m.host.invoke<SessionStats[]>("pty_stats"), timeoutMs)
        .then((rows) => rekeyStats(m.env, rows))
        .catch(() => [] as SessionStats[]),
    ),
  );
  return lists.flat();
}
