import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge } from "../packages/bridge/src/server.js";
import { secret } from "../packages/bridge/src/store.js";
import { privateWrite } from "../packages/connector/src/config.js";
import { validateTarget } from "../packages/connector/src/remote.js";
const exec=promisify(execFile);
async function until(check:()=>boolean){const deadline=Date.now()+30000;while(!check()){if(Date.now()>deadline)throw new Error("Condition timed out");await new Promise(r=>setTimeout(r,20));}}

test("SSH deployment installs only connector files and skill, then revokes on tunnel exit",{timeout:45000},async()=>{
  const directory=mkdtempSync("/tmp/argo-remote-");const remoteHome=join(directory,"remote"),fakeBin=join(directory,"fake-bin"),localHome=join(directory,"local");
  for(const dir of [remoteHome,fakeBin,localHome])mkdirSync(dir,{mode:0o700});
  const token=secret();const bridge=await startBridge({database:join(localHome,"bridge.sqlite"),token,port:0});
  privateWrite(join(localHome,"client.json"),{url:bridge.url,token});
  // Fake only SSH transport. Installation, npm ci, compiled launcher and skill rendering are real.
  const fake=`#!${process.execPath}\nconst {spawn}=require('node:child_process');const args=process.argv.slice(2);if(args.includes('-N')){require('node:fs').writeFileSync(process.env.TEST_TUNNEL,JSON.stringify(args));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}else{const env={...process.env,HOME:process.env.TEST_REMOTE_HOME};delete env.ARGO_HOME;const child=spawn('/bin/sh',['-c',args.at(-1)],{env,stdio:'inherit'});child.on('exit',code=>process.exit(code??1));child.on('error',()=>process.exit(1));}\n`;
  writeFileSync(join(fakeBin,"ssh"),fake,{mode:0o700});
  const env={...process.env,ARGO_HOME:localHome,TEST_REMOTE_HOME:remoteHome,TEST_TUNNEL:join(directory,"tunnel.json"),PATH:fakeBin+":"+process.env.PATH};
  const child=spawn(process.execPath,[resolve("bin/argo.mjs"),"remote","--host","test-host","--name","remote $(not-a-command)"],{env,stdio:["ignore","pipe","pipe"]});
  let output="",error="";child.stdout.on("data",v=>output+=v);child.stderr.on("data",v=>error+=v);
  try {
    await until(()=>existsSync(env.TEST_TUNNEL)||child.exitCode!==null);
    assert.ok(existsSync(env.TEST_TUNNEL),output+error);
    const sessions=bridge.store.list();assert.equal(sessions.length,1);assert.equal(sessions[0]?.online,false,"install does not launch another Agent");
    const skills=readdirSync(join(remoteHome,".claude/skills"));assert.equal(skills.length,1);
    const skill=readFileSync(join(remoteHome,".claude/skills",skills[0]!,"SKILL.md"),"utf8");
    assert.match(skill,/--credential/);assert.match(skill,/--session '\$\{CLAUDE_SESSION_ID\}'/);assert.ok(!skill.includes(token));assert.ok(skill.includes(join(remoteHome,".local/share/argo/releases")),"skill uses remote installation path");
    const releases=join(remoteHome,".local/share/argo/releases"),release=join(releases,readdirSync(releases)[0]!);
    for(const absent of [".git",".context","test","remote-setup.json","dist/test"])assert.equal(existsSync(join(release,absent)),false,absent);
    assert.equal(existsSync(join(remoteHome,".argo/client.json")),false,"Mac admin credential is not transferred");
    const credentialFiles=readdirSync(join(remoteHome,".argo/credentials"));assert.equal(credentialFiles.length,1);
    const credential=JSON.parse(readFileSync(join(remoteHome,".argo/credentials",credentialFiles[0]!),"utf8"));
    assert.notEqual(credential.token,token);assert.equal(credential.bindingId,sessions[0]?.id);
    const {stdout}=await exec(process.execPath,[join(release,"bin/argo.mjs"),"--help"],{env:{...process.env,HOME:remoteHome}});assert.match(stdout,/argo attach/);
    const tunnel=JSON.parse(readFileSync(env.TEST_TUNNEL,"utf8"));assert.ok(tunnel.includes(`127.0.0.1:49123:127.0.0.1:${new URL(bridge.url).port}`));
    child.kill("SIGTERM");await once(child,"exit");await until(()=>bridge.store.list().length===0);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");await once(child,"exit");}
    await bridge.close();rmSync(directory,{recursive:true,force:true});
  }
});

test("remote SSH destination is data, not injected options or shell commands",()=>{
  assert.equal(validateTarget("user@server.example"),"user@server.example");assert.equal(validateTarget("my-server"),"my-server");
  for(const value of ["-oProxyCommand=evil","user@host;id","host $(id)","user@host\nanything","ssh://host"])assert.throws(()=>validateTarget(value));
});


test("failed SSH installation revokes the fresh grant",async()=>{
  const directory=mkdtempSync("/tmp/argo-remote-fail-");const fakeBin=join(directory,"bin");mkdirSync(fakeBin);
  writeFileSync(join(fakeBin,"ssh"),"#!/bin/sh\nexit 37\n",{mode:0o700});
  const token=secret();const bridge=await startBridge({database:join(directory,"bridge.sqlite"),token,port:0});
  try{
    privateWrite(join(directory,"client.json"),{url:bridge.url,token});
    await assert.rejects(exec(process.execPath,[resolve("bin/argo.mjs"),"remote","--host","test-host"],{env:{...process.env,ARGO_HOME:directory,PATH:fakeBin+":"+process.env.PATH},timeout:15000}),/SSH installation|Remote installation/);
    assert.equal(bridge.store.list().length,0);
  }finally{await bridge.close();rmSync(directory,{recursive:true,force:true});}
});
