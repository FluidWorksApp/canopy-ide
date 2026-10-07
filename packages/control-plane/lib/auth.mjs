import {betterAuth} from 'better-auth';
import {magicLink,bearer} from 'better-auth/plugins';
import {Pool} from 'pg';
import {Resend} from 'resend';
export const pool=new Pool({connectionString:process.env.CANOPY_DATABASE_URL,max:3,connectionTimeoutMillis:8000});
export function authOrigin(){
 const preview=process.env.VERCEL_ENV==='preview'?process.env.VERCEL_URL:null;
 if(preview && /^[a-z0-9-]+\.vercel\.app$/.test(preview))return `https://${preview}`;
 return process.env.CANOPY_AUTH_URL??'https://canopyide.dev';
}
export function createAuth({sendMagicLink=deliverLink,secret=process.env.CANOPY_AUTH_SECRET}={}){return betterAuth({
 baseURL:authOrigin(),
 secret,
 database:pool,
 trustedOrigins:[authOrigin()],
 session:{expiresIn:60*60*24*7},
 rateLimit:{enabled:true,storage:'database',window:60,max:60},
 plugins:[bearer(),magicLink({expiresIn:600,storeToken:'hashed',sendMagicLink})]
});}
async function deliverLink({email,url}){
 const from=process.env.CANOPY_AUTH_FROM??process.env.CRASH_REPORT_FROM;
 if(!from||!process.env.RESEND_API_KEY)throw Error('Sign-in email is not configured');
 const result=await new Resend(process.env.RESEND_API_KEY).emails.send({from,to:email,subject:'Sign in to Canopy',text:`Sign in to your Canopy account:\n\n${url}\n\nThis link expires in 10 minutes. If you did not request it, ignore this email.`});
 if(result.error)throw Error('Sign-in email could not be sent');
}
export const auth=createAuth();
