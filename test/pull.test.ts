import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge } from "../packages/bridge/src/server.js";
import { secret } from "../packages/bridge/src/store.js";
import { privateWrite } from "../packages/connector/src/config.js";
import { currentSession } from "../packages/connector/src/pull.js";

const exec=promisify(execFile);
async function until(predicate:()=>boolean|Promise<boolean>){const deadline=Date.now()+5000;while(!await predicate()){if(Date.now()>deadline)throw new Error("Condition timed out");await new Promise(r=>setTimeout(r,20));}}

test("pull mode binds from current Bash session, delivers once and replies without MCP",async()=>{
  const directory=mkdtempSync("/tmp/argo-pull-");
  const token=secret();const bridge=await startBridge({database:join(directory,"bridge.sqlite"),token,port:0});
  privateWrite(join(directory,"client.json"),{url:bridge.url,token});
  const env={...process.env,ARGO_HOME:directory,CLAUDE_CODE_SESSION_ID:"test-existing-session"};
  const entry=resolve("bin/argo.mjs");
  const cli=async(args:string[],input?:string)=>{
    if(input===undefined){const {stdout}=await exec(process.execPath,[entry,...args],{env,timeout:15000});return JSON.parse(stdout);}
    const child=spawn(process.execPath,[entry,...args],{env,stdio:["pipe","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",v=>stdout+=v);child.stderr.on("data",v=>stderr+=v);child.stdin.end(input);
    const [code]=await once(child,"exit");if(code!==0)throw new Error(stderr);return JSON.parse(stdout);
  };
  let binding:string|undefined,workerPid:number|undefined;
  try{
    const attached=await cli(["attach","--name","live-pull"]);binding=attached.bindingId;assert.equal(attached.mode,"pull");
    const stateFile=readdirSync(join(directory,"pull")).find(file=>file.endsWith('.json')&&!file.endsWith('.credential.json'))!;
    workerPid=JSON.parse(readFileSync(join(directory,"pull",stateFile),"utf8")).pid;
    const snapshot=()=>bridge.store.snapshot(binding!);
    assert.equal(snapshot().session.nativeSessionId,"test-existing-session");assert.equal(snapshot().session.status,"waiting");
    assert.deepEqual(snapshot().session.capabilities,{send:true,streaming:false,interrupt:false,approvals:false,questions:false});
    assert.equal((await cli(["attach"])).alreadyAttached,true);
    const abandoned=spawn(process.execPath,[entry,"next"],{env,stdio:"ignore"});
    await until(()=>snapshot().session.status==="ready");abandoned.kill("SIGTERM");await once(abandoned,"exit");
    await until(()=>snapshot().session.status==="waiting");
    const waiting=cli(["next"]);await until(()=>snapshot().session.status==="ready");
    const generation=snapshot().session.generation;
    const response=await fetch(`${bridge.url}/v1/sessions/${binding}/messages`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({generation,messageId:"prompt-1",text:"remember terminal context"})});
    assert.equal(response.status,202);
    const inbound=await waiting;assert.equal(inbound.messageId,"prompt-1");assert.equal(inbound.text,"remember terminal context");
    await assert.rejects(cli(["next"]),/already delivered/);
    await cli(["ack","--message","prompt-1"]);await until(()=>snapshot().messages[0]?.state==="accepted");
    await assert.rejects(cli(["reply","--message","wrong","--stdin"],"no"),/No delivered message/);
    await cli(["reply","--message","prompt-1","--stdin","--progress"],"working");
    await cli(["reply","--message","prompt-1","--stdin"],"same session answer\nwith multiline text");
    await until(()=>snapshot().messages[0]?.state==="completed");
    assert.equal(snapshot().messages.filter(m=>m.role==="assistant").length,1);
    assert.equal(snapshot().messages.find(m=>m.role==="assistant")?.text,"same session answer\nwith multiline text");
    await assert.rejects(cli(["reply","--message","prompt-1","--stdin"],"duplicate"),/No delivered message/);
    await cli(["leave"]);await until(()=>!bridge.store.authenticate(binding!,"unused")&&bridge.store.list().length===0);
    await until(()=>!readdirSync(join(directory,"pull")).some(f=>f.endsWith('.sock')));
  }finally{
    if(workerPid){try{process.kill(workerPid,"SIGTERM");}catch{}}
    await bridge.close();rmSync(directory,{recursive:true,force:true});
  }
});

test("pull identity is explicit and never discovered from a transcript",()=>{
  assert.equal(currentSession("explicit-session"),"explicit-session");
  assert.throws(()=>currentSession("wrong/path"));
});
