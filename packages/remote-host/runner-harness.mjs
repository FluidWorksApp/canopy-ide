// Agent PTYs reach the Canopy service through the read-only socket the host
// bound at /run/canopy-ctx (service-mount.mjs). Only a gateway-minted
// credential turns it on; without one the agent runs as before.
export const CONTAINER_CTX_SOCKET='/run/canopy-ctx/ctx.sock';
export function harnessEnvironment(harness){
 if(harness==null)return {};
 if(typeof harness!=='object'||Array.isArray(harness)||Object.keys(harness).some(k=>k!=='token')||typeof harness.token!=='string'||!/^[A-Za-z0-9._~+\/=-]{16,1024}$/.test(harness.token))throw Error('Invalid harness credential');
 return {CANOPY_CTX_SOCKET:CONTAINER_CTX_SOCKET,CANOPY_CTX_TOKEN:harness.token};
}
