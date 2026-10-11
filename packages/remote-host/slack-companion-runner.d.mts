import type {StructuredRunnerLaunch} from '../../src/structuredRunners';
export const BUILTIN_WRITERS:string[];
export const WORKSPACE_ROOT:string;
export function companionLaunch(input:{bin:string;sessionId:string;systemPrompt:string;roots?:string[];model?:string;cwd?:string}):StructuredRunnerLaunch;
export function launchArgs(cli:string,launch:StructuredRunnerLaunch,opts?:{resume?:boolean}):string[];
