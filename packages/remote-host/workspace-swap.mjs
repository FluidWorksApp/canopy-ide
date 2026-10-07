// Container swap allowance. Hosts have a fixed 3 GiB /swapfile (canopy-website
// bootstrap), so control-plane configuration sets an absolute `swapMiB`
// (3072): --memory-swap is memory + swapMiB. The legacy `swapRatio` (default
// 0.75 of memory) remains for configurations written before swapMiB existed.
// Host bootstrap detects this file to choose the matching --memory-swap.
export const WORKSPACE_SWAP_MIB=3072;
export function workspaceSwapMiB(workspace,memoryMiB=workspace.memoryMiB){
 if(workspace?.swapMiB!=null)return workspace.swapMiB;
 return Math.round(memoryMiB*(workspace?.swapRatio??0.75));
}
export function memorySwapMiB(workspace,memoryMiB){return memoryMiB+workspaceSwapMiB(workspace,memoryMiB);}
/** Aggregate (capacity slice) swap ceiling in bytes. */
export function aggregateSwapBytes(workspace){
 return workspace?.swapMiB!=null?workspace.swapMiB*1048576:Math.round(workspace.memoryMiB*1048576*(workspace.swapRatio??0.75));
}
