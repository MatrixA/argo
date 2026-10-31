// Drives the public compiled CLI and a real connector over loopback, without a model call.
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { Connection } from "../packages/connector/src/connection.js";
import { api, privateRead } from "../packages/connector/src/config.js";
import { credentialSchema, type Snapshot } from "../packages/shared/src/protocol.js";

const directory=mkdtempSync(join(tmpdir(),"argo-cli-smoke-"));
const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,"127.0.0.1",resolve));
const address=listener.address();if(!address||typeof address==="string")throw new Error("No port");
await new Promise<void>(resolve=>listener.close(()=>resolve()));
const env={...process.env,ARGO_HOME:directory};const entry=join(process.cwd(),"bin/argo.mjs");
const bridge=spawn(process.execPath,[entry,"serve","--port",String(address.port)],{env,stdio:["ignore","pipe","pipe"]});
bridge.stdout.resume();bridge.stderr.resume();
let connection:Connection|undefined;
try {
  const deadline=Date.now()+5000;
  while(!existsSync(join(directory,"client.json"))){if(Date.now()>deadline)throw new Error("CLI did not start");await new Promise(r=>setTimeout(r,20));}
  const config=privateRead(join(directory,"client.json")) as {url:string;token:string};
  while(true){try{await api(config,"/v1/sessions");break;}catch{if(Date.now()>deadline)throw new Error("Bridge not listening");await new Promise(r=>setTimeout(r,20));}}
  const credentialPath=join(directory,"binding.json");
  execFileSync(process.execPath,[entry,"pair","--agent","claude","--name","cli-smoke","--out",credentialPath],{env,stdio:"pipe"});
  const credential=credentialSchema.parse(privateRead(credentialPath));
  connection=new Connection(credential,join(directory,"connector.sqlite"));
  connection.start({nativeSessionId:"smoke-existing",runtimeId:"smoke-runtime",machine:"smoke-machine",cwd:"/isolated/test",capabilities:{send:true,streaming:false,interrupt:false,approvals:false,questions:false},
    async handle(command){if(command.type!=="send")throw new Error("Unexpected command");connection!.emit({type:"receipt",commandId:command.commandId,messageId:command.messageId,state:"accepted"});connection!.emit({type:"message",messageId:"smoke-reply",replyTo:command.messageId,text:"Round-trip through the public CLI",final:true});connection!.emit({type:"completed",messageId:command.messageId});},async close(){}});
  connection.emit({type:"status",status:"ready"});await connection.ready();
  execFileSync(process.execPath,[entry,"send","--binding",credential.bindingId,"--stdin"],{env,input:"hello\nfrom CLI",stdio:["pipe","pipe","pipe"]});
  let snapshot:Snapshot;
  do{snapshot=await api<Snapshot>(config,`/v1/sessions/${credential.bindingId}`);if(Date.now()>deadline)throw new Error("Reply timed out");if(!snapshot.messages.some(m=>m.role==="assistant"))await new Promise(r=>setTimeout(r,20));}while(!snapshot.messages.some(m=>m.role==="assistant"));
  assert.equal(snapshot.messages[0]?.state,"completed");
  assert.equal(snapshot.messages[1]?.text,"Round-trip through the public CLI");
  assert.equal(snapshot.session.nativeSessionId,"smoke-existing");
  execFileSync(process.execPath,[entry,"detach","--binding",credential.bindingId],{env,stdio:"pipe"});
  const listing=JSON.parse(execFileSync(process.execPath,[entry,"list"],{env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));assert.equal(listing.length,0);
  console.log("PASS: public CLI start, pair, existing-session connector, multiline send, reply, history and detach");
}finally{await connection?.close();bridge.kill("SIGTERM");if(bridge.exitCode===null&&bridge.signalCode===null)await once(bridge,"exit");rmSync(directory,{recursive:true,force:true});}
