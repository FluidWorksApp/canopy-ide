// Only known provider error codes classify as permanent. Never return a raw
// SDK error message (it can contain request URLs, credentials or user data).
const authentication=new Set(['AccessDenied','AccessDeniedException','UnauthorizedOperation','UnauthorizedException','UnauthenticatedException','InvalidClientTokenId','UnrecognizedClientException','SignatureDoesNotMatch','InvalidSignatureException','AuthFailure']);
const quota=new Set(['ExceededResourceLimitException','ResourceLimitExceededException','ServiceQuotaExceededException','QuotaExceededException','AccountResourceLimitExceeded']);
const unavailable=new Set(['OptInRequired','SubscriptionRequiredException','AccountNotSubscribedException','UnsupportedOperation']);
const localConfigurationErrors=new WeakSet();
export function providerConfigurationError(){const error=new Error('Workspace provider configuration is invalid. Ask an administrator to check its compute package, location and routing configuration before retrying.');localConfigurationErrors.add(error);return error;}
export function permanentProviderFailure(error){
 if(error&&localConfigurationErrors.has(error))return error.message;
 const code=typeof error?.name==='string'?error.name:'';
 if(authentication.has(code))return 'Workspace provider authorization failed. Ask an administrator to check compute credentials and permissions before retrying.';
 if(quota.has(code))return 'Workspace provider quota is exhausted. Ask an administrator to increase the compute quota or free unused capacity before retrying.';
 if(unavailable.has(code))return 'Workspace compute is unavailable for this account or location. Ask an administrator to check the provider configuration before retrying.';
 // NotFound, throttling, capacity shortages, timeouts and ambiguous invalid
 // inputs are intentionally not classified: the worker must re-observe them.
 return null;
}
