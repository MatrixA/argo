import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge } from "../packages/bridge/src/server.js";
import { Store, secret, hash } from "../packages/bridge/src/store.js";
import { privateWrite } from "../packages/connector/src/config.js";
const exec=promisify(execFile);

test("pairing exchange is scoped, single-use, expiring, hashed and browser-inaccessible",async()=>{
  const directory=mkdtempSync("/tmp/argo-pair-");const token=secret();
  const bridge=await startBridge({database:join(directory,"bridge.sqlite"),token,port:0});
  const request=(path:string,body:unknown,auth?:string,method="POST",extra:Record<string,string>={})=>fetch(bridge.url+path,{method,headers:{"Content-Type":"application/json",...(auth?{Authorization:`Bearer ${auth}`} :{}),...extra},body:JSON.stringify(body)});
  try {
    assert.equal((await request("/v1/pairings",{name:"remote",adapter:"claude"})).status,401);
    const response=await request("/v1/pairings",{name:"remote",adapter:"claude"},token);assert.equal(response.status,201);
    const pairing=await response.json() as {code:string;expiresAt:number};assert.match(pairing.code,/^ARGO-[a-f0-9]{32}$/);
    const row=bridge.store.db.prepare("SELECT hash FROM pairings").get();assert.equal(row?.hash,hash(pairing.code));assert.notEqual(row?.hash,pairing.code);
    assert.equal(bridge.store.list().length,0,"unclaimed code isn't a session");
    assert.equal((await request("/v1/pairings/claim",{code:pairing.code},undefined,"POST",{Origin:"https://evil.example"})).status,403);
    assert.equal((await request("/v1/pairings/claim",{code:pairing.code,name:"override"})).status,409);
    const claims=await Promise.all([request("/v1/pairings/claim",{code:pairing.code}),request("/v1/pairings/claim",{code:pairing.code})]);
    assert.deepEqual(claims.map(r=>r.status).sort(),[201,409]);
    const grant=await claims.find(r=>r.status===201)!.json() as {token:string;bindingId:string;adapter:string};
    assert.notEqual(grant.token,token);assert.equal(grant.adapter,"claude");assert.equal(bridge.store.list()[0]?.name,"remote");
    assert.equal((await request("/v1/pairings",{name:"stolen",adapter:"claude"},grant.token)).status,401);
    const cancelled=bridge.store.createPairing("cancelled","claude");assert.equal((await request("/v1/pairings",{code:cancelled.code},token,"DELETE")).status,200);
    assert.equal((await request("/v1/pairings/claim",{code:cancelled.code})).status,409);
    const expired=bridge.store.createPairing("expired","claude");bridge.store.db.prepare("UPDATE pairings SET expires=1 WHERE hash=?").run(hash(expired.code));
    assert.equal((await request("/v1/pairings/claim",{code:expired.code})).status,409);
    const result=await request("/v1/pairings/claim",{code:"secret-wrong-format"});assert.equal(result.status,409);assert.ok(!(await result.text()).includes("secret-wrong-format"));
    for(let i=0;i<60;i++)await request("/v1/pairings/claim",{code:"ARGO-"+"0".repeat(32)});
    assert.equal((await request("/v1/pairings/claim",{code:"ARGO-"+"0".repeat(32)})).status,429);
  }finally{await bridge.close();rmSync(directory,{recursive:true,force:true});}
});

test("pairing code survives a service restart but cannot be reused",()=>{
  const directory=mkdtempSync("/tmp/argo-pair-restart-");const path=join(directory,"bridge.sqlite");let store=new Store(path);
  try{
    const pairing=store.createPairing("remote","claude");store.close();store=new Store(path);
    const grant=store.claimPairing(pairing.code);assert.equal(store.get(grant.bindingId).name,"remote");assert.throws(()=>store.claimPairing(pairing.code));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("public compiled claim CLI saves private credentials without printing them or requiring remote admin config",async()=>{
  const directory=mkdtempSync("/tmp/argo-claim-");const token=secret();const bridge=await startBridge({database:join(directory,"bridge.sqlite"),token,port:0});
  const remote=join(directory,"remote"),out=join(remote,"credential.json"),entry=resolve("bin/argo.mjs");
  const claim=async(code:string,path=out)=>{
    const child=spawn(process.execPath,[entry,"claim","--url",bridge.url,"--stdin","--out",path],{env:{...process.env,ARGO_HOME:remote},stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.on("data",v=>stdout+=v);child.stderr.on("data",v=>stderr+=v);child.stdin.end(code);
    const [exit]=await once(child,"exit");return {exit,stdout,stderr};
  };
  try{
    privateWrite(join(directory,"client.json"),{url:bridge.url,token});
    const {stdout}=await exec(process.execPath,[entry,"invite","--name","remote"],{env:{...process.env,ARGO_HOME:directory}});
    const pairing=JSON.parse(stdout);const result=await claim(pairing.code);assert.equal(result.exit,0,result.stderr);
    const saved=JSON.parse(readFileSync(out,"utf8"));assert.equal(saved.url,bridge.url);assert.notEqual(saved.token,token);
    assert.ok(!result.stdout.includes(saved.token));assert.ok(!result.stdout.includes(pairing.code));assert.ok(!result.stderr.includes(pairing.code));assert.equal(existsSync(join(remote,"client.json")),false);
    const next=bridge.store.createPairing("fresh","claude");const refused=await claim(next.code);assert.notEqual(refused.exit,0);assert.match(refused.stderr,/already exists/);
    assert.ok(bridge.store.claimPairing(next.code),"existing output must not consume code");
    const reused=await claim(pairing.code,join(remote,"second.json"));assert.notEqual(reused.exit,0);assert.equal(existsSync(join(remote,"second.json")),false);
  }finally{await bridge.close();rmSync(directory,{recursive:true,force:true});}
});
