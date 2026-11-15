import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { crc32 } from "node:zlib";
import { WebSocketServer } from "ws";
import { startBridge } from "../packages/bridge/src/server.js";
import { Store, secret } from "../packages/bridge/src/store.js";
import { Connection } from "../packages/connector/src/connection.js";
import { commandSchema, capabilitiesSchema, imageAttachmentSchema, imageUploadSchema, imageMime, MAX_IMAGE_BYTES, type Command, type ImageUpload } from "../packages/shared/src/protocol.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX4kAAAAASUVORK5CYII=","base64");
const upload=(bytes=png):ImageUpload=>({name:"capture.png",mimeType:"image/png",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),data:bytes.toString("base64")});
const caps={send:true,streaming:false,interrupt:false,approvals:false,questions:false,images:true};
const registration={type:"register" as const,version:1 as const,nativeSessionId:"native",runtimeId:"runtime",machine:"host",cwd:"/test",capabilities:caps};
async function until(check:()=>boolean|Promise<boolean>) {const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw new Error("Condition timed out");await new Promise(resolve=>setTimeout(resolve,10));}}
function ready(store:Store) {const grant=store.createGrant("image fixture","claude");const generation=store.register(grant.bindingId,registration);store.acceptEvent(grant.bindingId,"ready",{type:"status",status:"ready"});return {...grant,generation};}

test("strict metadata, bounded base64 and structural PNG/JPEG/WebP keep text protocol shapes",()=>{
  const {data,...image}=upload();
  assert.equal(MAX_IMAGE_BYTES,4*1024*1024);assert.equal(imageMime(png),"image/png");
  assert.deepEqual(imageAttachmentSchema.parse(image),image);assert.deepEqual(imageUploadSchema.parse(upload()),upload());
  for(const name of ["../secret","bad\\path","line\nname",".","..","\x7f", " ","a".repeat(256)]) assert.equal(imageAttachmentSchema.safeParse({...image,name}).success,false);
  for(const change of [{size:0},{size:MAX_IMAGE_BYTES+1},{sha256:image.sha256.toUpperCase()},{mimeType:"image/gif"},{data}])assert.equal(imageAttachmentSchema.safeParse({...image,...change}).success,false);
  for(const data of ["", "%%%='", "AAAA\n", "AAA", "AAAA=" , "A".repeat(4*Math.ceil(MAX_IMAGE_BYTES/3)+4)]) assert.equal(imageUploadSchema.safeParse({...image,data}).success,false);
  for(const bytes of [Buffer.alloc(0),png.subarray(0,8),png.subarray(0,29),png.subarray(0,-1),Buffer.from([255,216,255]),Buffer.from("RIFF0000WEBP"),Buffer.from("GIF89a"),Buffer.alloc(MAX_IMAGE_BYTES+1)])assert.throws(()=>imageMime(bytes));
  const webp=Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA","base64");
  assert.equal(imageMime(webp),"image/webp");assert.throws(()=>imageMime(webp.subarray(0,-1)));
  // Complete structural baseline JPEG headers + one entropy byte + EOI.
  const jpeg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
  assert.equal(imageMime(jpeg),"image/jpeg");assert.throws(()=>imageMime(jpeg.subarray(0,-2)));
  const command={type:"send",commandId:"c",messageId:"m",text:"text"};assert.deepEqual(commandSchema.parse(command),command);
  const {images,...textCaps}=caps;assert.deepEqual(capabilitiesSchema.parse(textCaps),textCaps);
});

test("connector binding IDs cannot escape the private images root",()=>{
  const root=mkdtempSync(join(tmpdir(),"argo-image-path-"));
  try {
    for(const bindingId of [".",".."])assert.throws(()=>new Connection({version:1,adapter:"claude",bindingId,token:secret(),url:"http://127.0.0.1:48123"},join(root,"outbox.sqlite")),/Invalid binding ID/);
    assert.equal(existsSync(join(root,"outbox.sqlite")),false);
  }finally {rmSync(root,{recursive:true,force:true});}
});

test("image enqueue is atomic, compares full identity, retains unknown bytes and expires completed payload only",()=>{
  const root=mkdtempSync(join(tmpdir(),"argo-image-store-"));const store=new Store(join(root,"bridge.sqlite"));
  try {
    const {bindingId,generation}=ready(store);const image=upload();
    const message=store.enqueue(bindingId,generation,"one","comment",image);
    assert.deepEqual(Buffer.from(store.image(bindingId,"one")!),png);assert.deepEqual(message.image,((({data,...meta})=>meta)(image)));
    assert.deepEqual(store.enqueue(bindingId,generation,"one","comment",image),message);
    for(const changed of [undefined,{...image,name:"renamed.png"}])assert.throws(()=>store.enqueue(bindingId,generation,"one","comment",changed),/different content/);
    const otherBytes=Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA","base64");
    assert.throws(()=>store.enqueue(bindingId,generation,"one","comment",{...upload(otherBytes),mimeType:"image/webp"}),/different content/);
    const legacy=store.createGrant("old connector","claude"), {images,...textCaps}=caps;
    const legacyGeneration=store.register(legacy.bindingId,{...registration,capabilities:textCaps});store.acceptEvent(legacy.bindingId,"ready",{type:"status",status:"ready"});
    assert.throws(()=>store.enqueue(legacy.bindingId,legacyGeneration,"image","comment",image),/Update the bridge and connector/);
    assert.equal(store.enqueue(legacy.bindingId,legacyGeneration,"text","comment").image,undefined);
    for(const changed of [{...image,data:Buffer.alloc(png.length).toString("base64")},{...image,sha256:"0".repeat(64)},{...image,mimeType:"image/jpeg" as const},{...image,size:png.length+1},{...image,data:image.data.replace(/=$/,"A")}])assert.throws(()=>store.enqueue(bindingId,generation,"bad","comment",changed));
    assert.equal(store.message(bindingId,"bad"),undefined);assert.equal(store.image(bindingId,"bad"),undefined);
    store.db.exec("CREATE TRIGGER fail_image_command BEFORE INSERT ON commands BEGIN SELECT RAISE(FAIL,'fixture rollback'); END");
    assert.throws(()=>store.enqueue(bindingId,generation,"rollback","comment",image),/fixture rollback/);
    assert.equal(store.message(bindingId,"rollback"),undefined);assert.equal(store.image(bindingId,"rollback"),undefined);store.db.exec("DROP TRIGGER fail_image_command");
    const command=store.nextCommand(bindingId);assert.ok(command?.type==="send");
    store.acceptEvent(bindingId,"unknown",{type:"receipt",commandId:command.commandId,state:"unknown"});
    assert.deepEqual(store.enqueue(bindingId,generation,"one","comment",image),store.message(bindingId,"one"));
    assert.deepEqual(Buffer.from(store.image(bindingId,"one")!),png);
    store.acceptEvent(bindingId,"complete",{type:"completed",messageId:"one"});
    store.db.prepare("UPDATE images SET completed=? WHERE binding=?").run(Date.now()-7*24*60*60_000-1,bindingId);
    assert.equal(store.image(bindingId,"one"),undefined);assert.ok(store.message(bindingId,"one")?.image);
    assert.deepEqual(store.enqueue(bindingId,generation,"one","comment",image),store.message(bindingId,"one"));assert.equal(store.image(bindingId,"one"),undefined,"dedup never resurrects an expired payload");
    const snapshot=JSON.stringify(store.snapshot(bindingId));assert.ok(!snapshot.includes(image.data));
    assert.ok(!JSON.stringify(store.db.prepare("SELECT data FROM commands").all()).includes(image.data));
    store.db.prepare("INSERT INTO images VALUES (?,?,zeroblob(?),NULL)").run(bindingId,"quota",100*1024*1024);
    assert.throws(()=>store.enqueue(bindingId,generation,"over-quota","comment",image),/quota/);assert.equal(store.message(bindingId,"over-quota"),undefined);
    store.revoke(bindingId);assert.equal(store.db.prepare("SELECT count(*) AS n FROM images").get()?.n,0);assert.ok(store.message(bindingId,"one")?.image);
  }finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("real bridge and WS download exact private bytes, keep binary out of frames, enforce scope and revoke",async()=>{
  const root=mkdtempSync(join(tmpdir(),"argo-image-wire-"));const before=process.env.ARGO_HOME;process.env.ARGO_HOME=join(root,"connector");
  const token=secret();const bridge=await startBridge({database:join(root,"bridge.sqlite"),token,port:0});
  const grant=bridge.store.createGrant("image fixture","claude");const other=bridge.store.createGrant("other fixture","claude");
  const clientToken=bridge.store.claimClientPairing(bridge.store.createClientPairing().code).token;
  const connection=new Connection({version:1,adapter:"claude",...grant,url:bridge.url},join(root,"outbox.sqlite"));
  const received:Array<{command:Command;path?:string}>=[];let revoked=false;connection.onRevoked=()=>{revoked=true;};
  const request=(path:string,method="GET",body?:unknown,auth=token,extra:Record<string,string>={})=>fetch(bridge.url+path,{method,headers:{Authorization:`Bearer ${auth}`,"Content-Type":"application/json",...extra},...(body?{body:JSON.stringify(body)}:{})});
  try {
    connection.start({...registration,async handle(command,path){received.push({command,path});},async close(){}});connection.emit({type:"status",status:"ready"});await connection.ready();
    await until(()=>bridge.store.get(grant.bindingId).status==="ready");assert.equal(bridge.store.get(grant.bindingId).capabilities.images,true);
    const generation=bridge.store.get(grant.bindingId).generation;const payload={generation,messageId:"image:one",text:"comment",image:upload()};
    const messagePath=`/v1/sessions/${grant.bindingId}/messages`,downloadPath=`/v1/connectors/${grant.bindingId}/images/image:one`;
    assert.equal((await request(messagePath,"POST",payload)).status,202);await until(()=>received.length===1);
    assert.deepEqual(readFileSync(received[0]!.path!),png);assert.equal(statSync(received[0]!.path!).mode&0o777,0o600);assert.equal(statSync(join(process.env.ARGO_HOME!,"images",grant.bindingId)).mode&0o777,0o700);
    assert.ok(received[0]!.path!.startsWith(join(process.env.ARGO_HOME!,"images",grant.bindingId)));assert.ok(!JSON.stringify(received[0]!.command).includes(upload().data));
    assert.equal((await request(messagePath,"POST",payload)).status,202);assert.equal((await request(messagePath,"POST",{...payload,image:{...payload.image,name:"different.png"}})).status,409);assert.equal(received.length,1);
    for(const auth of [grant.token,token,clientToken]){const response=await request(downloadPath,"GET",undefined,auth);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/png");assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);}
    assert.equal((await request(downloadPath,"GET",undefined,other.token)).status,401);assert.equal((await request(downloadPath,"GET",undefined,"")).status,401);
    assert.equal((await request(downloadPath,"GET",undefined,grant.token,{Origin:"https://untrusted.invalid"})).status,403);
    assert.equal((await request("/v1/sessions","GET",undefined,grant.token)).status,401);
    assert.equal((await request(`/v1/connectors/${other.bindingId}/images/image:one`,"GET",undefined,grant.token)).status,401);
    const snapshot=await (await request(`/v1/sessions/${grant.bindingId}`)).text();assert.ok(!snapshot.includes(upload().data));
    const local=new DatabaseSync(join(root,"outbox.sqlite"));
    try {
      connection.emit({type:"completed",messageId:"image:one"});await until(()=>bridge.store.message(grant.bindingId,"image:one")?.state==="completed");
      local.prepare("UPDATE images SET completed=? WHERE id=?").run(Date.now()-7*24*60*60_000-1,"image:one");
      connection.emit({type:"status",status:"ready"});assert.equal(existsSync(received[0]!.path!),false);assert.equal(local.prepare("SELECT count(*) AS n FROM commands").get()?.n,1,"file cleanup retains command dedup");
      await until(()=>bridge.store.get(grant.bindingId).status==="ready");
      local.prepare("INSERT INTO images VALUES (?,?,?,NULL)").run("quota",join(process.env.ARGO_HOME!,"images",grant.bindingId,"quota.png"),100*1024*1024);
      assert.equal((await request(messagePath,"POST",{...payload,messageId:"local-quota"})).status,202);
      await until(()=>bridge.store.message(grant.bindingId,"local-quota")?.state==="failed");assert.equal(received.length,1,"local quota failure never reaches Agent");
      assert.equal(bridge.store.get(grant.bindingId).status,"ready","safe pre-native failure releases in-flight work");
      assert.equal(bridge.store.get(grant.bindingId).inFlight,null);local.prepare("DELETE FROM images WHERE id='quota'").run();
      assert.equal((await request(messagePath,"POST",{...payload,messageId:"image:two"})).status,202);await until(()=>received.length===2);assert.deepEqual(readFileSync(received[1]!.path!),png);
      const failedCommand=bridge.store.db.prepare("SELECT data FROM commands WHERE binding=?").all(grant.bindingId).map(row=>JSON.parse(String(row.data))).find(command=>command.messageId==="local-quota");
      bridge.store.acceptEvent(grant.bindingId,"duplicate-local-failure",{type:"receipt",commandId:failedCommand.commandId,state:"failed"});
      assert.equal(bridge.store.get(grant.bindingId).status,"busy");assert.equal(bridge.store.get(grant.bindingId).inFlight,"image:two");
      connection.emit({type:"completed",messageId:"image:two"});await until(()=>bridge.store.message(grant.bindingId,"image:two")?.state==="completed");
      // A valid private ancillary chunk pads a real PNG to the exact upload limit.
      const padding=Buffer.alloc(MAX_IMAGE_BYTES-png.length);padding.writeUInt32BE(padding.length-12);padding.write("arGo",4);padding.writeUInt32BE(crc32(padding.subarray(4,-4)),padding.length-4);
      const maximum=Buffer.concat([png.subarray(0,-12),padding,png.subarray(-12)]);
      assert.equal(maximum.length,MAX_IMAGE_BYTES);assert.equal((await request(messagePath,"POST",{...payload,messageId:"maximum",image:upload(maximum)})).status,202);
      await until(()=>received.length===3);assert.deepEqual(readFileSync(received[2]!.path!),maximum);
    }finally {local.close();}
    assert.equal((await request(messagePath,"POST",{...payload,messageId:"too-large",image:{...payload.image,size:MAX_IMAGE_BYTES+1}})).status,409);
    assert.equal((await request(messagePath,"POST",{...payload,messageId:"bad-base64",image:{...payload.image,data:"AAAA"}})).status,409);
    assert.equal((await request(messagePath,"POST",{generation,messageId:"large-text-body",text:"text",padding:" ".repeat(600_000)})).status,409);
    await request(`/v1/sessions/${grant.bindingId}`,"DELETE");await until(()=>revoked);
    assert.equal((await request(downloadPath,"GET",undefined,grant.token)).status,401);assert.equal(bridge.store.db.prepare("SELECT count(*) AS n FROM images WHERE binding=?").get(grant.bindingId)?.n,0);
    assert.throws(()=>readFileSync(received[1]!.path!));assert.throws(()=>readFileSync(received[2]!.path!));
  }finally {await connection.close();await bridge.close();if(before===undefined)delete process.env.ARGO_HOME;else process.env.ARGO_HOME=before;rmSync(root,{recursive:true,force:true});}
});

test("new connector omits images for an old bridge; failed downloads never invoke Agent or replay",async()=>{
  const root=mkdtempSync(join(tmpdir(),"argo-image-compat-"));const before=process.env.ARGO_HOME;process.env.ARGO_HOME=join(root,"connector");
  let forbiddenRequests=0;
  const server=createServer((req,res)=>{
    if(req.url==="/forbidden"){forbiddenRequests++;res.end();return;}
    if(req.url?.endsWith("redirect")){res.writeHead(302,{Location:"/forbidden"});res.end();return;}
    res.writeHead(200,{"Content-Type":req.url?.endsWith("mime")?"image/jpeg":"image/png"});
    res.end(req.url?.endsWith("oversized")?Buffer.alloc(MAX_IMAGE_BYTES+1):req.url?.endsWith("truncated")?png.subarray(0,-1):Buffer.alloc(png.length));
  });
  const wss=new WebSocketServer({noServer:true});let supportsImages=false;let invoked=0;
  const registrations:any[]=[];const events:any[]=[];
  wss.on("headers",headers=>{if(supportsImages)headers.push("X-Argo-Images: 1");});
  server.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>ws.on("message",raw=>{
    const frame=JSON.parse(raw.toString());
    if(frame.type==="register") {
      registrations.push(frame);ws.send(JSON.stringify({type:"registered",bindingId:"binding",generation:"generation"}));
      if(supportsImages){
        const {data,...image}=upload();
        for(const mode of ["redirect","redirect","hash","mime","oversized","truncated"]) {
          const command={type:"send",commandId:`command-${mode}`,messageId:mode,text:"comment",image};ws.send(JSON.stringify({type:"command",generation:"generation",command}));
        }
      }
    }else if(frame.type==="event"){events.push(frame.event);ws.send(JSON.stringify({type:"ack",eventId:frame.eventId}));}
  })));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("No port");
  const credential={version:1 as const,adapter:"claude" as const,bindingId:"binding",token:secret(),url:`http://127.0.0.1:${address.port}`};
  let connection=new Connection(credential,join(root,"old.sqlite"));
  try {
    const adapter={...registration,async handle(){invoked++;},async close(){}};
    connection.start(adapter);await connection.ready();assert.equal("images" in registrations[0].capabilities,false);await connection.close();
    supportsImages=true;connection=new Connection(credential,join(root,"new.sqlite"));connection.start(adapter);await connection.ready();
    await until(()=>events.filter(event=>event.type==="receipt").length===6);
    assert.equal(registrations[1].capabilities.images,true);assert.equal(invoked,0);assert.equal(forbiddenRequests,0);assert.ok(events.filter(event=>event.type==="receipt").every(event=>event.state==="failed"));
    assert.match(events.find(event=>event.type==="receipt").detail,/no Agent operation was invoked/);
    const outside=join(root,"other-binding-root");mkdirSync(join(outside,"binding"),{recursive:true,mode:0o700});const sentinel=join(outside,"binding","keep.png");writeFileSync(sentinel,png,{mode:0o600});
    rmSync(join(process.env.ARGO_HOME!,"images"),{recursive:true,force:true});symlinkSync(outside,join(process.env.ARGO_HOME!,"images"));
    let revoked=false;connection.onRevoked=()=>{revoked=true;};for(const ws of wss.clients)if(ws.readyState===1)ws.send(JSON.stringify({type:"revoked"}));await until(()=>revoked);
    assert.deepEqual(readFileSync(sentinel),png,"revoke never follows a pre-existing images-root symlink into another directory");
  }finally {await connection.close();for(const socket of wss.clients)socket.terminate();wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));if(before===undefined)delete process.env.ARGO_HOME;else process.env.ARGO_HOME=before;rmSync(root,{recursive:true,force:true});}
});
