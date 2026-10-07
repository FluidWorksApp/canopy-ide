// Replica only: module resolution hooks for the local control plane. Imports
// of the AWS clients made by canopy-website code resolve to the local
// stand-ins; every other module, including all of lib/canopy and api/, is the
// unmodified website source.
const LOCAL={
 '@aws-sdk/client-lightsail':'./local-lightsail.mjs',
 '@aws-sdk/client-route-53':'./local-route53.mjs',
 '@aws-sdk/client-s3':'./local-s3.mjs',
};
const WEBSITE='file:///website/';
const REAL='canopy-replica-real:';
export async function resolve(specifier,context,next){
 if(specifier.startsWith(REAL))return next(specifier.slice(REAL.length),{...context,parentURL:`${WEBSITE}lib/canopy/bootstrap.mjs`});
 const local=LOCAL[specifier];
 if(local&&(context.parentURL?.startsWith(`${WEBSITE}lib/`)||context.parentURL?.startsWith(`${WEBSITE}api/`)))return {url:new URL(local,import.meta.url).href,shortCircuit:true};
 return next(specifier,context);
}
