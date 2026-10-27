export const HOST_PROTOCOL:number;
export const NATIVE_PREFIXES:string[];
export const NATIVE_COMMANDS:Set<string>;
export function isNativeCommand(command:unknown):boolean;
export function nativeTimeoutMs(command:unknown):number;
