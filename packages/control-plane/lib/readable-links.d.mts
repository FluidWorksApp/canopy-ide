// Types for the app side of readable links (src/readableLinks.ts and its test),
// which must agree with this module on link shapes and reserved names.
export type LinkKind = 'workspace' | 'session' | 'message';
export const LINK_KINDS: readonly LinkKind[];
export const CHANNELS: readonly ('general' | 'dm')[];
export const RESERVED_HANDLES: readonly string[];
export function linkOrigin(configured?: string): string;
export function slugify(value: unknown, max?: number): string;
export function wordSlug(seed: string, attempt?: number): string;
export function sessionSlug(title: string, seed: string, attempt?: number): string;
export function workspaceSlug(name: string, attempt?: number): string;
export function handleCandidate(name: string, attempt?: number, fallback?: string): string;
export function pathKind(path: string): LinkKind | null;
export function parseReadableUrl(raw: string, origin?: string): {namespace: string; path: string; kind: LinkKind} | null;
export function readableUrl(namespace: string, path: string, origin?: string): string;
type Grant = {role: string; permissions?: unknown};
export function maySeeSession(grants: Grant[], projectId: string): boolean;
type Db = {query(sql: string, args?: unknown[]): Promise<{rows: Record<string, unknown>[]}>};
type User = {id: string; name?: string; email?: string};
export function resolveReadableLink(db: Db, user: User, input: {url: string; origin?: string}): Promise<{link: {url: string; kind: LinkKind; target: Record<string, unknown>}}>;
export function readableLinkAction(db: Db, user: User, input: Record<string, unknown>): Promise<Record<string, unknown>>;
