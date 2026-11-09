import type {
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionResponse,
} from "./protocol";
import type { StructuredRunnerAuthority } from "../structuredRunners";

export interface PermissionDecision {
  response: AcpPermissionResponse;
  /** True when Canopy refused: the host is told with a `blocked` event. */
  denied: boolean;
}

const pick = (options: AcpPermissionOption[], kind: string): AcpPermissionOption | undefined =>
  options.find((o) => o.kind === kind);

const cancelled = (): PermissionDecision => ({
  response: { outcome: { outcome: "cancelled" } },
  denied: true,
});

/** Answer `session/request_permission` from the launch authority alone.
 *
 *  Read-only refuses, workspace-write allows this one call. `allow_always` and
 *  `reject_always` are never chosen: a standing grant outlives the policy that
 *  justified it, and an unattended task has nobody to revoke it. When the
 *  agent offers no matching one-shot option the request is cancelled, which
 *  ACP defines as a refusal. */
export function decidePermission(
  request: AcpPermissionRequest,
  authority: StructuredRunnerAuthority,
): PermissionDecision {
  const options = request.options ?? [];
  if (authority === "workspace-write") {
    const allow = pick(options, "allow_once");
    if (allow) {
      return {
        response: { outcome: { outcome: "selected", optionId: allow.optionId } },
        denied: false,
      };
    }
  }
  const reject = pick(options, "reject_once");
  if (!reject) return cancelled();
  return {
    response: { outcome: { outcome: "selected", optionId: reject.optionId } },
    denied: true,
  };
}

/** An interactive surface may answer instead of the policy. Whatever it picks
 *  is still held to the one-shot rule: an `allow_always` choice is downgraded
 *  to `allow_once`, or refused when the agent offered no such option. */
export function constrainChoice(
  request: AcpPermissionRequest,
  optionId: string | null,
): PermissionDecision | null {
  if (optionId === null) return cancelled();
  const chosen = request.options.find((o) => o.optionId === optionId);
  if (!chosen) return null;
  if (chosen.kind === "allow_once" || chosen.kind === "reject_once") {
    return {
      response: { outcome: { outcome: "selected", optionId: chosen.optionId } },
      denied: chosen.kind === "reject_once",
    };
  }
  if (chosen.kind === "allow_always") {
    const once = pick(request.options, "allow_once");
    if (once) {
      return {
        response: { outcome: { outcome: "selected", optionId: once.optionId } },
        denied: false,
      };
    }
  }
  const reject = pick(request.options, "reject_once");
  return reject
    ? { response: { outcome: { outcome: "selected", optionId: reject.optionId } }, denied: true }
    : cancelled();
}
