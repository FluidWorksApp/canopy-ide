// Informational provider quota only, never Canopy billing or account identity.
// Exact fields parsed by Codex0.160.0 codex-api/src/rate_limits.rs.
const fields=['x-codex-primary-used-percent','x-codex-primary-window-minutes','x-codex-primary-reset-at','x-codex-secondary-used-percent','x-codex-secondary-window-minutes','x-codex-secondary-reset-at'];
export function providerQuotaHeaders(headers){
 const result={};for(const field of fields){const value=headers.get(field);if(typeof value!=='string'||value.length>20||! /^[0-9]+(?:\.[0-9]+)?$/.test(value))continue;const number=Number(value);if(!Number.isFinite(number))continue;
  if(field.endsWith('-used-percent')){if(number<0||number>100)continue;}else if(!Number.isSafeInteger(number)||number<0)continue;
  result[field]=value;
 }return result;
}
