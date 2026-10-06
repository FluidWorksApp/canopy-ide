export interface DelegationPolicy {
  projects: 'all' | 'selected';
  projectIds: string[];
  git: 'personal' | 'shared';
  agents: 'personal' | 'shared';
  sessions: 'private' | 'view' | 'interact';
}
export function canDelegateWorkspacePolicy(
  grants: ReadonlyArray<{ role: string; permissions?: unknown }>,
  requested: unknown,
): boolean;
