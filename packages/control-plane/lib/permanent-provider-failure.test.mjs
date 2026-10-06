import test from 'node:test';import assert from 'node:assert/strict';import {permanentProviderFailure,providerConfigurationError} from './permanent-provider-failure.mjs';
test('known authorization, quota and account configuration failures have safe actionable messages',()=>{
 for(const name of ['AccessDeniedException','UnauthorizedOperation','InvalidClientTokenId','SignatureDoesNotMatch','ExceededResourceLimitException','QuotaExceededException','OptInRequired','UnsupportedOperation']){
  const message=permanentProviderFailure({name,message:'SECRET signed request URL https://private.invalid/?token=leak'});assert.equal(typeof message,'string');assert.doesNotMatch(message,/SECRET|https:|token=|private.invalid/);assert.match(message,/administrator/);
 }
});
test('resource races, capacity, throttling and unknown failures remain retryable',()=>{
 for(const name of ['NotFoundException','InvalidInputException','ThrottlingException','TooManyRequestsException','InsufficientInstanceCapacity','TimeoutError','NetworkingError','OperationFailureException','Unexpected'])assert.equal(permanentProviderFailure({name,message:'AccessDeniedException'}),null);
 assert.equal(permanentProviderFailure(null),null);assert.equal(permanentProviderFailure({message:'UnauthorizedOperation'}),null);
 assert.match(permanentProviderFailure(providerConfigurationError()),/configuration is invalid/);
 assert.equal(permanentProviderFailure({code:'CANOPY_PROVIDER_CONFIGURATION',message:'SECRET'}),null);
});
