import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { startBridge } from "../packages/bridge/src/server.js";
import { secret } from "../packages/bridge/src/store.js";
import { Connection } from "../packages/connector/src/connection.js";
import { Hub } from "../extensions/raycast/src/core.js";

// Real bidirectional byte forwards, not an SSH server or a model acceptance test.
test("independent Mac and Agent loopback endpoints reach the same authenticated bridge",async()=>{
 const directory=mkdtempSync("/tmp/argo-topology-");const token=secret();
 const bridge=await startBridge({database:join(directory,"bridge.sqlite"),port:0,token});const sockets=new Set<Socket>();
 async function forward(){
  const server=createServer(socket=>{
   const upstream=connect(Number(new URL(bridge.url).port),"127.0.0.1");sockets.add(socket);sockets.add(upstream);
   socket.on("error",()=>upstream.destroy());upstream.on("error",()=>socket.destroy());
   socket.on("close",()=>{sockets.delete(socket);upstream.destroy();});upstream.on("close",()=>sockets.delete(upstream));
   socket.pipe(upstream).pipe(socket);
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address==="object");
  return {server,url:`http://127.0.0.1:${address.port}`};
 }
 const mac=await forward(),agent=await forward(),hub=new Hub({url:mac.url,token});let connector:Connection|undefined;
 const until=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw new Error("Timed out");await new Promise(resolve=>setTimeout(resolve,10));}};
 try{
  const pairing=await hub.createPairing("topology-fixture");
  const claimed=await fetch(agent.url+"/v1/pairings/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:pairing.code})});assert.equal(claimed.status,201);
  const grant=await claimed.json() as {bindingId:string;token:string;adapter:"claude";version:1};
  connector=new Connection({...grant,url:agent.url},join(directory,"outbox.sqlite"));
  connector.start({nativeSessionId:"exact-existing-fixture",runtimeId:"fixture-runtime",machine:"fixture-server",cwd:"/synthetic",capabilities:{send:true,streaming:false,interrupt:false,approvals:false,questions:false},async handle(command){
   if(command.type!=="send")return;
   connector!.emit({type:"receipt",commandId:command.commandId,messageId:command.messageId,state:"accepted"});
   connector!.emit({type:"message",messageId:"fixture-reply",replyTo:command.messageId,text:"Reply through independent forward",final:true});
   connector!.emit({type:"completed",messageId:command.messageId});
  },async close(){}});
  connector.emit({type:"status",status:"ready"});await connector.ready();await until(async()=>(await hub.snapshot(grant.bindingId)).session.status==="ready");
  const snapshot=await hub.snapshot(grant.bindingId);assert.equal(snapshot.session.nativeSessionId,"exact-existing-fixture");
  const controller=new AbortController();let watched=false;
  const watch=hub.watch(snapshot.cursor,controller.signal,()=>{watched=true;},async()=>snapshot.cursor,()=>{});
  await hub.mutate(grant.bindingId,"/messages",{generation:snapshot.session.generation,messageId:"topology-request",text:"Synthetic topology check"});
  await until(async()=>(await hub.snapshot(grant.bindingId)).messages.some(message=>message.id==="fixture-reply"));
  await until(()=>watched);
  await hub.mutate(grant.bindingId,"",undefined,"DELETE");assert.equal((await hub.sessions()).sessions.length,0);
  controller.abort();await watch;
 }finally{
  hub.close();await connector?.close();for(const socket of sockets)socket.destroy();
  await Promise.all([mac.server,agent.server].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
  await bridge.close();rmSync(directory,{recursive:true,force:true});
 }
});
