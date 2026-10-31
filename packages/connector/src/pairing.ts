import { existsSync } from "node:fs";
import { credentialSchema, localUrl, pairingCodeSchema } from "../../shared/src/protocol.js";
import { privateWrite } from "./config.js";

export async function claimPairing(url:string, input:string, out:string) {
  localUrl(url);
  if(existsSync(out))throw new Error("Credential output already exists; pairing code was not consumed");
  const parsed=pairingCodeSchema.safeParse(input.trim());
  if(!parsed.success)throw new Error("Invalid pairing code format");
  const response=await fetch(new URL("/v1/pairings/claim",url),{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:parsed.data}),signal:AbortSignal.timeout(10_000)});
  if(!response.ok){await response.body?.cancel();throw new Error("Pairing failed or expired. Do not retry an uncertain claim automatically; generate a fresh code in Raycast.");}
  const grant=credentialSchema.safeParse({...await response.json() as object,url});
  if(!grant.success)throw new Error("Invalid pairing response; generate a fresh code in Raycast");
  try{privateWrite(out,grant.data);}catch{throw new Error("Pairing was claimed but its credential could not be saved. Revoke the binding in Raycast and generate a fresh code.");}
  return {bindingId:grant.data.bindingId,path:out};
}
