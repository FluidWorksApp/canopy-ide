// Agent PTYs reach the Canopy service through the read-only socket the host
// bound at /run/canopy-ctx (service-mount.mjs). Only a gateway-minted
// credential turns it on; without one the agent runs as before.
export const CONTAINER_CTX_SOCKET='/run/canopy-ctx/ctx.sock';
export function harnessEnvironment(harness){
 if(harness==null)return {};
 if(typeof harness!=='object'||Array.isArray(harness)||Object.keys(harness).some(k=>k!=='token')||typeof harness.token!=='string'||!/^[A-Za-z0-9._~+\/=-]{16,1024}$/.test(harness.token))throw Error('Invalid harness credential');
 return {CANOPY_CTX_SOCKET:CONTAINER_CTX_SOCKET,CANOPY_CTX_TOKEN:harness.token};
}
/** The credential request id for a structured-runner attempt (`_` becomes
 *  `:`, which request ids allow and attempt ids never contain). The service
 *  keeps a `runner-` credential while the host's structured_runner_live still
 *  lists the attempt, rather than matching it to a runner session. */
export const RUNNER_REQUEST_PREFIX='runner-';
export function runnerRequestId(attemptId){
 if(typeof attemptId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(attemptId))return null;
 return RUNNER_REQUEST_PREFIX+attemptId.replaceAll('_',':');
}
