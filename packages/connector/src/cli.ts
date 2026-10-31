#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { credentialSchema, localUrl, type Session, type Snapshot } from "../../shared/src/protocol.js";
import { startBridge } from "../../bridge/src/server.js";
import { api, clientPath, home, initClient, privateRead, privateWrite, readClient } from "./config.js";
import { Connection } from "./connection.js";
import { createClaudeChannel } from "./claude.js";

const help=`Argo: connect Raycast to an existing Agent session.

  argo serve [--port 48123]                 Run the loopback bridge
  argo invite --name NAME [--agent claude|codex]
                                          Create a single-use pairing code, valid for ten minutes
  argo claim --url LOOPBACK_URL --stdin --out FILE
                                          Exchange a pairing code for a private scoped credential
  argo remote --host SSH_ALIAS [--name NAME] [--remote-port 49123]
                                          Install remote connector + skill and hold SSH tunnel
  argo pair --name NAME --agent claude|codex --out FILE
                                          Authorize one binding; writes a private credential
  argo attach [--name NAME] [--credential FILE]
                                          Attach current Claude via cooperative pull; no MCP/restart
  argo next                               Wait for the next Raycast message in this session
  argo ack --message ID                    Confirm processing of a pulled message
  argo reply --message ID --stdin [--progress]
                                          Return text; final unless --progress
  argo leave                              Revoke this session's pull binding
  argo channel --credential FILE          MCP Channel, launched by Claude Code
  argo connect --credential FILE --thread ID [--socket PATH]
                                          Join a loaded Codex thread in its existing daemon
  argo list                               List bindings without conversation content
  argo send --binding ID --text TEXT       Submit text (prefer --stdin for private prompts)
  argo show --binding ID                   Read recent bridge messages
  argo reconcile --binding ID --message ID --confirm-checked
                                          Release queue after checking an uncertain turn
  argo detach --binding ID                Revoke binding, leave Agent running
  argo setup-claude --credential FILE      Print MCP config and startup instructions
  argo launchd [--out FILE]                Print or write a launchd template; never installs it

Credentials are files, not command-line tokens. ARGO_HOME defaults to ~/.argo.
Remote connectors use the same loopback URL through an SSH reverse tunnel.
`;
function stopOnSignal(close:()=>Promise<void>) {
  let closing=false;const stop=()=>{if(closing)return;closing=true;void close().finally(()=>process.exit(0));};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
async function main() {
  const parsed=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{
    host:{type:"string"},"remote-port":{type:"string"},url:{type:"string"},port:{type:"string"},name:{type:"string"},agent:{type:"string"},out:{type:"string"},
    credential:{type:"string"},thread:{type:"string"},socket:{type:"string"},binding:{type:"string"},
    session:{type:"string"},progress:{type:"boolean"},message:{type:"string"},"confirm-checked":{type:"boolean"},text:{type:"string"},stdin:{type:"boolean"},help:{type:"boolean",short:"h"},
  }});
  const command=parsed.positionals[0];const opts=parsed.values;
  const required=(name:keyof typeof opts)=>{const value=opts[name];if(typeof value!=="string"||!value)throw new Error(`Missing --${name}`);return value;};
  if(!command||opts.help){console.log(help);return;}
  if(command==="invite") {
    const adapter=opts.agent??"claude";if(adapter!=="claude"&&adapter!=="codex")throw new Error("Agent must be claude or codex");
    console.log(JSON.stringify(await api(readClient(),"/v1/pairings","POST",{name:required("name"),adapter}),null,2));return;
  }
  if(command==="claim") {
    if(!opts.stdin)throw new Error("Provide the one-time pairing code via --stdin, not command-line arguments");
    const url=required("url"),out=resolve(required("out"));localUrl(url);
    let input="";for await(const chunk of process.stdin){input+=chunk.toString();if(input.length>200)throw new Error("Pairing input too large");}
    const {claimPairing}=await import("./pairing.js");
    console.log(JSON.stringify(await claimPairing(url,input,out),null,2));return;
  }
  if(command==="remote") {
    const {connectRemote}=await import("./remote.js");
    const source=resolve(fileURLToPath(new URL("../../../bin/argo.mjs",import.meta.url)));
    const launcher=existsSync(source)?source:resolve(fileURLToPath(new URL("../../../../bin/argo.mjs",import.meta.url)));
    await connectRemote({target:required("host"),name:opts.name||required("host"),remotePort:Number(opts["remote-port"]??49123),root:resolve(launcher,"../..")});return;
  }
  if(["attach","next","ack","reply","leave","pull-worker"].includes(command)) {
    const {attachPull,currentSession,pullCommand,runPullWorker}=await import("./pull.js");
    const session=currentSession(opts.session);
    if(command==="pull-worker"){await runPullWorker({session,name:required("name"),credentialPath:resolve(required("credential"))});return;}
    if(command==="attach") {
      const source=resolve(fileURLToPath(new URL("../../../bin/argo.mjs",import.meta.url)));
      const launcher=existsSync(source)?source:resolve(fileURLToPath(new URL("../../../../bin/argo.mjs",import.meta.url)));
      console.log(JSON.stringify(await attachPull({session,name:opts.name||"Claude",credentialPath:opts.credential,launcher}),null,2));return;
    }
    let body:string|undefined;
    if(command==="reply") {
      if(!opts.stdin)throw new Error("Use --stdin for replies; never put response text into shell arguments");
      const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){size+=Buffer.byteLength(chunk);if(size>400_000)throw new Error("Reply too large");chunks.push(Buffer.from(chunk));}
      body=Buffer.concat(chunks).toString("utf8");
    }
    console.log(JSON.stringify(await pullCommand(command,session,opts.message,body,opts.progress),null,2));return;
  }
  if(command==="serve") {
    const port=Number(opts.port??48123);if(!Number.isInteger(port)||port<1||port>65535)throw new Error("Invalid port");
    const config=initClient(`http://127.0.0.1:${port}`);
    const lock=join(home(),"bridge.lock");
    let lockFd:number;try{lockFd=openSync(lock,"wx",0o600);writeFileSync(lockFd,String(process.pid));}catch{throw new Error("Bridge already running, or stale bridge.lock exists. Check its PID before removing it.");}
    let bridge:Awaited<ReturnType<typeof startBridge>>;
    try {bridge=await startBridge({database:join(home(),"bridge.sqlite"),token:config.token,port});}
    catch(error){closeSync(lockFd);unlinkSync(lock);throw error;}
    console.log(`Argo bridge listening at ${bridge.url}\nRaycast configuration: ${clientPath()}`);
    stopOnSignal(async()=>{await bridge.close();closeSync(lockFd);unlinkSync(lock);});return;
  }
  if(command==="pair") {
    const adapter=required("agent");if(adapter!=="claude"&&adapter!=="codex")throw new Error("Agent must be claude or codex");
    const out=resolve(required("out"));if(existsSync(out))throw new Error("Credential output already exists");
    const config=readClient();localUrl(opts.url??config.url);
    const grant=await api<{bindingId:string;token:string;version:1;adapter:"claude"|"codex"}>(config,"/v1/grants","POST",{name:required("name"),adapter});
    const target=opts.url??config.url;localUrl(target);
    privateWrite(out,{...grant,url:target});
    console.log(`Authorized ${grant.bindingId}. Private credential written to ${out}.\nTransfer privately to the Agent machine if needed. Do not paste its contents into chat.`);return;
  }
  if(command==="list") {const result=await api<{sessions:Session[]}>(readClient(),"/v1/sessions");console.log(JSON.stringify(result.sessions,null,2));return;}
  if(command==="detach") {await api(readClient(),`/v1/sessions/${encodeURIComponent(required("binding"))}`,"DELETE");console.log("Detached. Agent was not stopped.");return;}
  if(command==="show") {const result=await api<Snapshot>(readClient(),`/v1/sessions/${encodeURIComponent(required("binding"))}`);console.log(JSON.stringify(result,null,2));return;}
  if(command==="reconcile") {
    if(!opts["confirm-checked"])throw new Error("Check the original Agent is idle and the uncertain result, then pass --confirm-checked. This may release queued prompts.");
    const config=readClient(),binding=required("binding");const {session}=await api<Snapshot>(config,`/v1/sessions/${encodeURIComponent(binding)}`);
    await api(config,`/v1/sessions/${encodeURIComponent(binding)}/reconcile`,"POST",{generation:session.generation,messageId:required("message")});
    console.log("Queue released. The uncertain prompt was not replayed or marked completed.");return;
  }
  if(command==="send") {
    const config=readClient(),binding=required("binding");const {session}=await api<Snapshot>(config,`/v1/sessions/${encodeURIComponent(binding)}`);
    let text=opts.text;
    if(opts.stdin){const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){size+=Buffer.byteLength(chunk);if(size>400_000)throw new Error("Input too large");chunks.push(Buffer.from(chunk));}text=Buffer.concat(chunks).toString("utf8");}
    if(!text)throw new Error("Provide --text or --stdin");
    const result=await api(config,`/v1/sessions/${encodeURIComponent(binding)}/messages`,"POST",{generation:session.generation,messageId:randomUUID(),text});console.log(JSON.stringify(result,null,2));return;
  }
  if(command==="channel"||command==="connect") {
    const path=resolve(required("credential"));const credential=credentialSchema.parse(privateRead(path));localUrl(credential.url);
    const lock=`${path}.lock`;mkdirSync(join(home(),"outbox"),{recursive:true,mode:0o700});
    let fd:number;
    try{fd=openSync(lock,"wx",0o600);writeFileSync(fd,String(process.pid));}catch{throw new Error("This credential is already in use, or has a stale lock. Check the original process before removing its .lock file.");}
    let connection:Connection;
    try{connection=new Connection(credential,join(home(),"outbox",`${credential.bindingId}.sqlite`));}
    catch(error){closeSync(fd);unlinkSync(lock);throw error;}
    let closeAdapter:()=>Promise<void>=async()=>{};
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;await connection.close();await closeAdapter();closeSync(fd);unlinkSync(lock);};
    connection.onRevoked=()=>{void close().finally(()=>process.exit(0));};stopOnSignal(close);
    try {
      if(command==="channel") {
        if(credential.adapter!=="claude")throw new Error("Credential is not for Claude");
        let bound=false;
        const channel=createClaudeChannel({
          async bind(name,url){
            if(url&&localUrl(url).origin!==localUrl(credential.url).origin)throw new Error("Address differs from paired credential; pair explicitly for this forwarded address");
            if(!bound){connection.start(channel.adapter,name);bound=true;connection.emit({type:"status",status:"ready",detail:"Channel enabled by user confirmation; awaiting first message acknowledgement"});}
            await connection.ready();
          },
          async unbind(){connection.unbind();},
        });
        closeAdapter=()=>channel.adapter.close();channel.setEmit(connection.emit);
        channel.mcp.onclose=()=>{void close().finally(()=>process.exit(0));};
        await channel.start();
      } else {
        if(credential.adapter!=="codex")throw new Error("Credential is not for Codex");
        const {createCodexAdapter}=await import("./codex.js");
        const adapter=await createCodexAdapter({threadId:required("thread"),socket:opts.socket},connection.emit);
        closeAdapter=()=>adapter.close();connection.start(adapter);await connection.ready();console.error("Codex thread connected to Argo.");
      }
    } catch(error){await close();throw error;}return;
  }
  if(command==="setup-claude") {
    const path=resolve(required("credential"));const credential=credentialSchema.parse(privateRead(path));if(credential.adapter!=="claude")throw new Error("Not a Claude credential");
    const launcher=resolve(fileURLToPath(new URL("../../../bin/argo.mjs",import.meta.url)));
    // From compiled dist/packages/connector/src, the repository root is one level higher.
    const entry=existsSync(launcher)?launcher:resolve(fileURLToPath(new URL("../../../../bin/argo.mjs",import.meta.url)));
    console.log(JSON.stringify({mcpServers:{argo:{command:process.execPath,args:[entry,"channel","--credential",path]}}},null,2));
    console.error("Save this as an MCP config, then launch interactively:\nclaude --mcp-config /path/to/argo.mcp.json --dangerously-load-development-channels server:argo\nConfirm the registered-channel startup notice, then ask Claude to bind the current session. This flag does not bypass tool permissions.");return;
  }
  if(command==="launchd") {
    const launcher=resolve("bin/argo.mjs");const escape=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>local.argo.bridge</string>\n<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(launcher)}</string><string>serve</string></array>\n<key>WorkingDirectory</key><string>${escape(process.cwd())}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>EnvironmentVariables</key><dict><key>ARGO_HOME</key><string>${escape(resolve(home()))}</string></dict>\n<key>StandardOutPath</key><string>${escape(join(home(),"bridge.log"))}</string>\n<key>StandardErrorPath</key><string>${escape(join(home(),"bridge-error.log"))}</string>\n</dict></plist>\n`;
    if(opts.out){writeFileSync(opts.out,plist,{flag:"wx",mode:0o600});console.log(`Template written to ${opts.out}. No service was installed.`);return;}
    console.log(plist);return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Argo failed");process.exitCode=1;});
