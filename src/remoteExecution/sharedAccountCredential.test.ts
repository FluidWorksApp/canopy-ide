import {expect,it} from 'vitest';
import {subscriptionCredential} from './sharedAccountCredential';
const jwt=(claims:object)=>'header.'+btoa(JSON.stringify(claims)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')+'.signature';
it('imports only Claude OAuth fields and discards configuration and arbitrary endpoints',()=>{
 const result=subscriptionCredential('anthropic',JSON.stringify({endpoint:'https://bad.test',claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:1760000000000,subscriptionType:'max'},settings:{private:true}}));
 expect(result).toEqual({provider:'anthropic',authType:'oauth',token:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:1760000000000});
});
it('normalizes Codex JWT expiry and account metadata without exporting the identity token',()=>{
 const access=jwt({exp:1760000000,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}});
 const result=subscriptionCredential('openai',JSON.stringify({tokens:{access_token:access,refresh_token:'synthetic-refresh',id_token:'sensitive-unused'}}));
 expect(result).toEqual({provider:'openai',authType:'oauth',token:access,refreshToken:'synthetic-refresh',expiresAt:1760000000000,providerAccountId:'synthetic-account'});
});
it('rejects wrong providers, missing refresh/expiry/account identity and header injection',()=>{
 for(const input of [{provider:'openai',authType:'oauth',token:'access',refreshToken:'refresh',expiresAt:1},{claudeAiOauth:{accessToken:'x\ny',refreshToken:'r',expiresAt:1}},{claudeAiOauth:{accessToken:'a',expiresAt:1}},{claudeAiOauth:{accessToken:'a',refreshToken:'r',expiresAt:'1'}}])expect(()=>subscriptionCredential('anthropic',JSON.stringify(input))).toThrow();
 expect(()=>subscriptionCredential('openai',JSON.stringify({tokens:{access_token:jwt({exp:1}),refresh_token:'r'}}))).toThrow('account identity');
 expect(()=>subscriptionCredential('openai','not JSON')).toThrow('valid JSON');
});
