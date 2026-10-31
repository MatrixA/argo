import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { startBridge } from "../packages/bridge/src/server.js";
import { Store, secret } from "../packages/bridge/src/store.js";
import { Connection } from "../packages/connector/src/connection.js";
import type { Adapter } from "../packages/connector/src/adapter.js";
import type { Command, Credential, Snapshot } from "../packages/shared/src/protocol.js";
const caps={send:true,streaming:false,interrupt:true,approvals:true,questions:true};
async function until(check:()=>boolean|Promise<boolean>) {
  const deadline=Date.now()+5000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error("Condition timed out");
}
test("authenticated bridge routes, persists and revokes one exact session",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"argo-test-"));const token=secret();
  const bridge=await startBridge({database:join(directory,"bridge.sqlite"),token,port:0});
  const config={url:bridge.url,token};
  const request=async(path:string,method="GET",body?:unknown,auth=token)=>{
    const response=await fetch(bridge.url+path,{method,headers:{Authorization:`Bearer ${auth}`,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json() as any};
  };
  let connection:Connection|undefined;
  try {
    assert.equal((await request("/v1/sessions","GET",undefined,"")).status,401);
    assert.equal((await fetch(bridge.url+"/v1/sessions",{headers:{Authorization:`Bearer ${token}`,Origin:"https://untrusted.example"}})).status,403);
    const grant=await request("/v1/grants","POST",{name:"test",adapter:"claude"});assert.equal(grant.status,201);
    const credential:Credential={...grant.data,url:bridge.url};
    connection=new Connection(credential,join(directory,"outbox.sqlite"));
    const received:Command[]=[];
    const adapter:Adapter={nativeSessionId:"original-session",runtimeId:"runtime-1",machine:"test-host",cwd:"/test",capabilities:caps,
      async handle(command){received.push(command);if(command.type==="send")connection!.emit({type:"receipt",commandId:command.commandId,messageId:command.messageId,state:"accepted"});},async close(){}};
    connection.start(adapter);connection.emit({type:"status",status:"ready"});await connection.ready();
    const path=`/v1/sessions/${credential.bindingId}`;
    await until(async()=>((await request(path)).data as Snapshot).session.status==="ready");
    const snapshot=(await request(path)).data as Snapshot;const generation=snapshot.session.generation;
    assert.equal(snapshot.session.nativeSessionId,"original-session");assert.equal("tokenHash" in snapshot.session,false);
    const messageId=randomUUID();
    const send={generation,messageId,text:"你好\nsecond line"};
    assert.equal((await request(path+"/messages","POST",send)).status,202);
    assert.equal((await request(path+"/messages","POST",send)).status,202);
    assert.equal((await request(path+"/messages","POST",{...send,text:"different"})).status,409);
    await until(()=>received.length===1);assert.equal(received[0]?.type,"send");
    const queuedId=randomUUID();assert.equal((await request(path+"/messages","POST",{generation,messageId:queuedId,text:"next"})).status,202);
    await new Promise(r=>setTimeout(r,30));assert.equal(received.length,1);
    connection.emit({type:"message",messageId:"reply-1",replyTo:messageId,text:"response",final:true});
    connection.emit({type:"completed",messageId});
    await until(()=>received.length===2);
    connection.emit({type:"interaction",interaction:{requestId:"approval-1",kind:"approval",title:"Edit test file",detail:"Only this request",expiresAt:Date.now()+30_000}});
    await until(async()=>((await request(path)).data as Snapshot).interactions.length===1);
    assert.equal((await request(path+"/interactions/approval-1","POST",{generation,decision:"allow"})).status,202);
    assert.equal((await request(path+"/interactions/approval-1","POST",{generation,decision:"allow"})).status,409);
    await until(()=>received.some(c=>c.type==="answer"));
    const stale={generation:"wrong",messageId:randomUUID(),text:"no"};assert.equal((await request(path+"/messages","POST",stale)).status,409);
    const controller=new AbortController();const events=await fetch(bridge.url+`/v1/events?after=${snapshot.cursor}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
    assert.equal(events.status,200);const reader=events.body!.getReader();const chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/id: /);controller.abort();
    await request(path,"DELETE");await until(()=>!bridge.store.authenticate(credential.bindingId,credential.token));
    assert.equal((await request(path+"/messages","POST",{generation,messageId:randomUUID(),text:"revoked"})).status,409);
  } finally {await connection?.close();await bridge.close();rmSync(directory,{recursive:true,force:true});}
});
test("store deduplicates events and never replays dispatched work after restart",()=>{
  const directory=mkdtempSync(join(tmpdir(),"argo-store-"));const path=join(directory,"store.sqlite");let store=new Store(path);
  try {
    const grant=store.createGrant("test","codex");
    const frame={type:"register" as const,version:1 as const,nativeSessionId:"native",runtimeId:"runtime",machine:"host",cwd:"/repo",capabilities:caps};
    const generation=store.register(grant.bindingId,frame);
    store.acceptEvent(grant.bindingId,"ready",{type:"status",status:"ready"});
    store.enqueue(grant.bindingId,generation,"message-1","test");assert.ok(store.nextCommand(grant.bindingId));
    store.acceptEvent(grant.bindingId,"event-1",{type:"message",messageId:"reply",replyTo:"message-1",text:"first",final:false});
    assert.equal(store.acceptEvent(grant.bindingId,"event-1",{type:"message",messageId:"reply",text:"duplicate",final:true}),false);
    store.close();store=new Store(path);
    assert.equal(store.snapshot(grant.bindingId).messages.find(m=>m.id==="message-1")?.state,"unknown");
    store.register(grant.bindingId,frame);store.acceptEvent(grant.bindingId,"ready-2",{type:"status",status:"ready"});assert.equal(store.nextCommand(grant.bindingId),undefined);
    assert.throws(()=>store.register(grant.bindingId,{...frame,nativeSessionId:"different"}),/Native session changed/);
    assert.throws(()=>store.register(grant.bindingId,{...frame,runtimeId:"different"}),/Runtime changed/);
    assert.equal(store.snapshot(grant.bindingId).messages.find(m=>m.id==="reply")?.text,"first");
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test("connector registration requires exact credentials and schema",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"argo-wire-"));const bridge=await startBridge({database:join(directory,"store.sqlite"),token:secret(),port:0});
  try {
    const grant=bridge.store.createGrant("test","claude");const url=bridge.url.replace("http:","ws:")+`/v1/connectors/${grant.bindingId}`;
    const ws=new WebSocket(url,{headers:{Authorization:`Bearer ${grant.token}`}});
    await new Promise<void>((resolve,reject)=>{ws.once("open",()=>resolve());ws.once("error",reject);});
    ws.send(JSON.stringify({type:"event",eventId:"before-register",event:{type:"status",status:"ready"}}));
    const code=await new Promise<number>(resolve=>ws.once("close",resolve));assert.equal(code,1008);
    assert.equal(bridge.store.snapshot(grant.bindingId).session.online,false);
  } finally {await bridge.close();rmSync(directory,{recursive:true,force:true});}
});

test("history paging does not lose messages created within the same millisecond",()=>{
  const directory=mkdtempSync(join(tmpdir(),"argo-pages-"));const store=new Store(join(directory,"store.sqlite"));
  try{
    const grant=store.createGrant("paging","claude");
    for(let index=0;index<405;index++)store.acceptEvent(grant.bindingId,`event-${index}`,{type:"message",messageId:`message-${index}`,text:String(index),final:true});
    const first=store.snapshot(grant.bindingId);assert.equal(first.messages.length,200);assert.equal(first.hasMore,true);
    const second=store.snapshot(grant.bindingId,first.messages[0]!.createdAt);assert.equal(second.messages.length,200);
    const third=store.snapshot(grant.bindingId,second.messages[0]!.createdAt);assert.equal(third.messages.length,5);assert.equal(third.hasMore,false);
    assert.equal(new Set([...first.messages,...second.messages,...third.messages].map(m=>m.id)).size,405);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
