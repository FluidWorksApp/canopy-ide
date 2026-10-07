// Replica only: the real `@aws-sdk/client-s3` (so the real presigner signs the
// real virtual-hosted S3 URL that runtimeReleasePreflight validates), except
// that object requests are answered from the local runtime package that
// server.mjs also serves at that S3 hostname inside the replica network.
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as real from 'canopy-replica-real:@aws-sdk/client-s3';
export * from 'canopy-replica-real:@aws-sdk/client-s3';
const file=process.env.REPLICA_RUNTIME_FILE;
const sha=()=>createHash('sha256').update(readFileSync(file)).digest('hex');
export class S3Client extends real.S3Client{
 async send(command,options){
  const input=command.input??{};
  if(input.Bucket!==process.env.CANOPY_RUNTIME_BUCKET||input.Key!==process.env.CANOPY_RUNTIME_KEY)throw Object.assign(new Error('NoSuchKey'),{name:'NoSuchKey',$metadata:{httpStatusCode:404}});
  if(command instanceof real.HeadObjectCommand)return {ContentLength:statSync(file).size,Metadata:{sha256:sha()},$metadata:{httpStatusCode:200}};
  throw new Error(`${command.constructor.name} is not replicated`);
 }
}
