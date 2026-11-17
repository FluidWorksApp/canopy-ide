export const READ_ONLY_NATIVE:Set<string>;
export function authorizeNativeRead(command:unknown):void;
export function viewerNativePayload<T extends {command?:unknown;args?:unknown}>(payload:T):T;
