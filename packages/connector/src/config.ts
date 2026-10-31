import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_URL, localUrl } from "../../shared/src/protocol.js";
const secret = () => randomBytes(32).toString("hex");

export const home=()=>process.env.ARGO_HOME??join(homedir(),".argo");
export const clientPath=()=>join(home(),"client.json");
export function privateRead(path:string):unknown {
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())) throw new Error("Credential file must be a private regular file owned by you (chmod 600)");
  if(stat.size>16_384)throw new Error("Credential file is too large");
  try{return JSON.parse(readFileSync(path,"utf8"));}catch{throw new Error("Credential file is not valid JSON");}
}
export function privateWrite(path:string,value:unknown,overwrite=false) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(existsSync(path)&&!overwrite)throw new Error("Refusing to overwrite an existing credential file");
  if(overwrite&&existsSync(path)) privateRead(path);
  const temp=`${path}.${randomUUID()}.tmp`;
  const fd=openSync(temp,"wx",0o600);
  try {writeFileSync(fd,JSON.stringify(value,null,2)+"\n");fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,path);chmodSync(path,0o600);
}
const clientSchema=z.object({url:z.string(),token:z.string().min(32)}).strict();
export function readClient(path=clientPath()) {const config=clientSchema.parse(privateRead(path));localUrl(config.url);return config;}
export function initClient(url=DEFAULT_URL) {
  localUrl(url);
  if(existsSync(clientPath())) {const config=readClient();if(config.url!==url)throw new Error("Existing bridge address differs; use a separate ARGO_HOME");return config;}
  const config={url,token:secret()};privateWrite(clientPath(),config);return config;
}
export async function api<T>(config:{url:string;token:string},path:string,method="GET",body?:unknown):Promise<T> {
  localUrl(config.url);
  const response=await fetch(new URL(path,config.url),{method,redirect:"error",headers:{Authorization:`Bearer ${config.token}`,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10_000)});
  const result=await response.json() as {error?:string};
  if(!response.ok)throw new Error(result.error??`Bridge returned ${response.status}`);
  return result as T;
}
