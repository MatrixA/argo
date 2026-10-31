import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
// Standalone public scripts intentionally have no project/TypeScript dependencies.
// @ts-expect-error standalone JS module
import { buildRelease } from "../scripts/package-release.mjs";
// @ts-expect-error standalone JS module
import { connectionUrl, download, install, RELEASE, releaseUrl, validateArchive } from "../scripts/install.mjs";

const checksum = (archive:Buffer) => createHash("sha256").update(archive).digest("hex") + "  argo-connector.tar.gz\n";
function transport(archive:Buffer, sums=checksum(archive)) {
  return async(url:string, options:{redirect:string;credentials:string;headers:Record<string,string>}) => {
    assert.equal(options.redirect,"manual");assert.equal(options.credentials,"omit");
    assert.ok(!Object.keys(options.headers).some(k=>k.toLowerCase()==="authorization"));
    assert.ok(url.startsWith(RELEASE));
    return new Response(url.endsWith("SHA256SUMS")?sums:new Uint8Array(archive));
  };
}
function tamper(archive:Buffer, change:(header:Buffer)=>void) {
  const tar=gunzipSync(archive),header=tar.subarray(0,512);change(header);
  header.fill(32,148,156);const sum=header.reduce((a,b)=>a+b,0);
  header.write(sum.toString(8).padStart(6,"0")+"\0 ",148,"ascii");return gzipSync(tar);
}

test("public release installs real production dependencies and unique safe polling skill",{timeout:180000},async()=>{
  const directory=mkdtempSync("/tmp/argo-install-test-"),home=join(directory,"home"),out=join(directory,"release");
  mkdirSync(home,{mode:0o700});
  try {
    const built=buildRelease({root:resolve("."),out});
    const archive=readFileSync(built.archive),sums=readFileSync(built.sums,"utf8");
    assert.ok(sums.includes(checksum(archive).trim()));
    assert.equal(readFileSync(built.installer,"utf8"),readFileSync(resolve("scripts/install.mjs"),"utf8"));
    assert.throws(()=>buildRelease({root:resolve("."),out}),/EEXIST/);
    assert.ok(existsSync(built.archive),"failed duplicate build preserves existing artifact");
    validateArchive(archive);
    const existingSkill=join(home,".claude/skills/existing");mkdirSync(existingSkill,{recursive:true});writeFileSync(join(existingSkill,"SKILL.md"),"keep");
    const settings=join(home,".claude/settings.json");writeFileSync(settings,'{"permissions":{"deny":["all"]}}');
    const result=await install({url:"http://127.0.0.1:49123",name:"backend $(not-a-command) 'quoted'"},{home,fetchImpl:transport(archive,sums)});
    const result2=await install({url:"http://127.0.0.1:49123"},{home,fetchImpl:transport(archive,sums)});
    assert.notEqual(result.release,result2.release);assert.notEqual(result.skill,result2.skill);
    for(const entry of [result,result2]){
      assert.equal(lstatSync(entry.release).mode&0o777,0o700);assert.equal(lstatSync(entry.skillFile).mode&0o777,0o600);
      assert.equal(existsSync(entry.credential),false,"installer never claims or creates credential");
      assert.equal(existsSync(join(home,".argo/client.json")),false,"remote installer never creates local admin");
      const manifest=JSON.parse(readFileSync(join(entry.release,"package.json"),"utf8"));
      for(const field of ["workspaces","scripts","devDependencies"])assert.equal(manifest[field],undefined);
      const lock=JSON.parse(readFileSync(join(entry.release,"package-lock.json"),"utf8"));
      assert.ok(Object.keys(lock.packages).every(key=>key===""||key.startsWith("node_modules/")));
      assert.equal(lock.packages[""].workspaces,undefined);assert.equal(lock.packages[""].devDependencies,undefined);
      for(const absent of [".git",".context","test","dist/test","packages","extensions","remote-setup.json","node_modules/tsx","node_modules/typescript","node_modules/@raycast/api"])assert.equal(existsSync(join(entry.release,absent)),false,absent);
      assert.ok(existsSync(join(entry.release,"node_modules/zod/package.json")),"real npm ci ran");
      const help=execFileSync(process.execPath,[entry.launcher,"--help"],{encoding:"utf8",env:{...process.env,HOME:home}});assert.match(help,/argo attach/);
      const skill=readFileSync(entry.skillFile,"utf8");
      assert.ok(skill.includes("name: "+entry.skill));assert.ok(skill.includes(entry.launcher));assert.ok(skill.includes(entry.credential));
      assert.match(skill,/claim --url 'http:\/\/127\.0\.0\.1:49123' --stdin --out/);assert.match(skill,/attach --credential/);
      assert.match(skill,/--session '\$\{CLAUDE_SESSION_ID\}'/);assert.match(skill,/cooperative pull/);assert.match(skill,/Never delegate/);
      assert.ok(!/\bargo (attach|next|ack|reply|leave)\b/.test(skill),"every actual launcher replaced");
    }
    assert.equal(readFileSync(join(existingSkill,"SKILL.md"),"utf8"),"keep");assert.equal(readFileSync(settings,"utf8"),'{"permissions":{"deny":["all"]}}');
    assert.ok(!readdirSync(join(home,".local/share/argo/releases")).some(name=>name.startsWith(".install-")),"fresh staging cleaned");
    const before=readdirSync(join(home,".local/share/argo/releases"));
    await assert.rejects(install({url:"http://127.0.0.1:49123"},{home,fetchImpl:transport(archive,"0".repeat(64)+"  argo-connector.tar.gz\n")}),/SHA-256 mismatch/);
    await assert.rejects(install({url:"http://127.0.0.1:49123"},{home,fetchImpl:transport(archive,checksum(archive)+checksum(archive))}),/exactly one/);
    assert.deepEqual(readdirSync(join(home,".local/share/argo/releases")),before);
    for(const change of [
      (header:Buffer)=>{header.fill(0,0,100);header.write("../outside");},
      (header:Buffer)=>{header[156]=50;header.write("/tmp/outside",157);},
      (header:Buffer)=>{header[156]=49;header.write("bin/argo.mjs",157);},
      (header:Buffer)=>{header[156]=120;},
      (header:Buffer)=>{header.fill(0,0,100);header.write("credential.json");},
    ]){
      const unsafe=tamper(archive,change);
      assert.throws(()=>validateArchive(unsafe),/Unsafe|forbidden/);
      await assert.rejects(install({url:"http://127.0.0.1:49123"},{home,fetchImpl:transport(unsafe)}),/Unsafe|forbidden/);
    }
    assert.deepEqual(readdirSync(join(home,".local/share/argo/releases")),before);
    const broken=gzipSync(Buffer.alloc(2048,42));assert.throws(()=>validateArchive(broken),/Invalid/);
    // Valid, checksummed tar; fail only after real extraction and verify rollback.
    const wrongVersion=gunzipSync(archive),needle=Buffer.from('"version": "0.1.1",\n  "private"');
    const at=wrongVersion.indexOf(needle);assert.ok(at>=0);
    wrongVersion.write('"version": "9.9.9",\n  "private"',at);
    await assert.rejects(install({url:"http://127.0.0.1:49123"},{home,fetchImpl:transport(gzipSync(wrongVersion))}),/sanitized/);
    assert.deepEqual(readdirSync(join(home,".local/share/argo/releases")),before,"extraction failure cleans stage and preserves releases");
    assert.equal(readdirSync(join(home,".claude/skills")).length,3,"failure creates no extra skill");
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("downloads bound bytes, redirects and origin without a public URL override",async()=>{
  assert.equal(connectionUrl("http://127.0.0.1:49123"),"http://127.0.0.1:49123");
  for(const url of ["http://server:49123","https://127.0.0.1:49123","http://user@localhost:1234","http://127.0.0.1:1234/path","http://127.0.0.1:1234/?x=1"])assert.throws(()=>connectionUrl(url));
  for(const url of ["https://evil.example/file","http://github.com/MatrixA/argo/releases/download/v0.1.1/file","https://github.com/other/repo/file","https://github.com:444/MatrixA/argo/releases/download/v0.1.1/file","https://user@release-assets.githubusercontent.com/file"])assert.throws(()=>releaseUrl(url));
  assert.equal(releaseUrl(RELEASE+"SHA256SUMS").origin,"https://github.com");
  assert.equal(releaseUrl("https://release-assets.githubusercontent.com/path?signature=value").hostname,"release-assets.githubusercontent.com");
  let calls=0;
  await assert.rejects(download(RELEASE+"SHA256SUMS",10,async()=>{calls++;return new Response(null,{status:302,headers:{location:"http://127.0.0.1:1/secret"}});}),/non-GitHub/);assert.equal(calls,1);
  await assert.rejects(download(RELEASE+"SHA256SUMS",10,async()=>new Response(null,{status:302,headers:{location:RELEASE+"SHA256SUMS"}})),/Too many/);
  await assert.rejects(download(RELEASE+"SHA256SUMS",10,async()=>new Response("large",{headers:{"content-length":"999"}})),/size limit/);
  await assert.rejects(download(RELEASE+"SHA256SUMS",3,async()=>new Response("large")),/size limit/);
  await assert.rejects(download(RELEASE+"SHA256SUMS",10,async()=>new Response("not found",{status:404})),/404/);
  let redirected=false;
  const bytes=await download(RELEASE+"SHA256SUMS",10,async(url:string)=>{
    if(!redirected){redirected=true;return new Response(null,{status:302,headers:{location:"https://release-assets.githubusercontent.com/a"}});}
    assert.equal(url,"https://release-assets.githubusercontent.com/a");return new Response("ok");
  });assert.equal(bytes.toString(),"ok");
});


test("standalone CLI entrypoints execute through symlink paths",()=>{
  const directory=mkdtempSync("/tmp/argo-entrypoint-test-");
  try {
    const installer=join(directory,"install.mjs"),builder=join(directory,"package-release.mjs");
    symlinkSync(resolve("scripts/install.mjs"),installer);
    symlinkSync(resolve("scripts/package-release.mjs"),builder);
    const help=execFileSync(process.execPath,[installer,"--help"],{encoding:"utf8"});
    assert.match(help,/Usage: node install\.mjs/);assert.match(help,/v0\.1\.1/);
    const out=join(directory,"artifacts");
    const built=JSON.parse(execFileSync(process.execPath,[builder,"--root",resolve("."),"--out",out],{encoding:"utf8"}));
    for(const artifact of [built.archive,built.installer,built.sums])assert.ok(existsSync(artifact));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
