import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { api, readClient } from "./config.js";
import { localUrl } from "../../shared/src/protocol.js";

export function validateTarget(value:string) {
  if(!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value))throw new Error("Use an SSH config alias or user@host, not shell text or SSH flags. Put ports and keys in SSH config.");
  return value;
}
export function remoteBundle(root:string,directory:string,setup:unknown) {
  const stage=join(directory,"bundle");mkdirSync(stage,{mode:0o700});
  // Explicit allowlist: no user home, .context, git history, logs, or development credentials.
  for(const file of ["package.json","package-lock.json","LICENSE","bin","skills/argo-bind","scripts/install-remote.mjs","extensions/raycast/package.json","dist/packages"]) {
    mkdirSync(join(stage,file,".."),{recursive:true,mode:0o700});cpSync(join(root,file),join(stage,file),{recursive:true});
  }
  writeFileSync(join(stage,"remote-setup.json"),JSON.stringify(setup),{flag:"wx",mode:0o600});
  const archive=join(directory,"connector.tar");execFileSync("tar",["-cf",archive,"-C",stage,"."],{env:{...process.env,COPYFILE_DISABLE:"1"}});
  return archive;
}
export async function connectRemote(options:{target:string;name:string;remotePort:number;root:string}) {
  const target=validateTarget(options.target);
  if(!Number.isInteger(options.remotePort)||options.remotePort<1||options.remotePort>65535)throw new Error("Invalid remote port");
  if(!options.name.trim()||options.name.length>100)throw new Error("Remote name must contain 1–100 characters");
  const config=readClient(),local=localUrl(config.url);
  const grant=await api<{version:1;adapter:"claude";bindingId:string;token:string}>(config,"/v1/grants","POST",{adapter:"claude",name:options.name});
  const skill="argo-remote-"+createHash("sha256").update(grant.bindingId).digest("hex").slice(0,12);
  const directory=mkdtempSync(join(tmpdir(),"argo-deploy-"));
  let tunnel:ReturnType<typeof spawn>|undefined;
  let installer:ReturnType<typeof spawn>|undefined;
  let interrupted=false;
  const stop=()=>{interrupted=true;installer?.kill("SIGTERM");tunnel?.kill("SIGTERM");};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  try {
    const archive=remoteBundle(options.root,directory,{name:options.name,skill,credential:{...grant,url:`http://127.0.0.1:${options.remotePort}`}});
    console.log(`Installing connector on ${target} over SSH. Only a scoped binding credential is transferred.`);
    const install='set -eu; umask 077; command -v node >/dev/null; command -v npm >/dev/null; d=$(mktemp -d "$HOME/.argo-install.XXXXXX"); trap \'test ! -d "$d" || rm -rf "$d"\' EXIT HUP INT TERM; tar -xf - -C "$d"; node "$d/scripts/install-remote.mjs" "$d"';
    const child=spawn("ssh",["-T","--",target,install],{stdio:["pipe","pipe","inherit"]});
    installer=child;
    let output="";child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.length>1_000_000)child.kill();});
    const exited=new Promise<number|null>(resolve=>{child.once("close",resolve);child.once("error",()=>resolve(1));});
    try {await pipeline(createReadStream(archive),child.stdin);}catch{child.kill();await exited;throw new Error("SSH installation transfer failed; the new binding was revoked");}
    const code=await exited;
    if(code!==0||!output.split("\n").some(line=>line.startsWith("ARGO_REMOTE_READY ")&&line.includes(skill)))throw new Error("Remote installation did not complete. The new binding was revoked; no Agent was started.");
    installer=undefined;if(interrupted)throw new Error("Remote setup interrupted; the new binding was revoked");
    rmSync(directory,{recursive:true,force:true});
    console.log(`Installed. In the EXISTING remote Claude session, run /${skill}.\nKeep this terminal open for the SSH tunnel. Ctrl+C closes it and revokes this binding.`);
    tunnel=spawn("ssh",["-T","-N","-o","ExitOnForwardFailure=yes","-o","ServerAliveInterval=30","-o","ServerAliveCountMax=3","-R",`127.0.0.1:${options.remotePort}:127.0.0.1:${local.port||80}`,"--",target],{stdio:"inherit"});
    try {const code=await new Promise<number|null>(resolve=>{tunnel!.once("close",resolve);tunnel!.once("error",()=>resolve(1));});if(code!==0&&code!==null)throw new Error("SSH tunnel closed with an error; this binding has been revoked");}
    finally{tunnel=undefined;}
  }finally {
    process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);installer?.kill("SIGTERM");
    tunnel?.kill("SIGTERM");rmSync(directory,{recursive:true,force:true});
    try{await api(config,`/v1/sessions/${grant.bindingId}`,"DELETE");}catch{console.error(`Could not confirm revocation. Run detach --binding ${grant.bindingId} when the bridge is reachable.`);}
  }
}
