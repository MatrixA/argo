import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { credentialSchema, id, text, type Command } from "../../shared/src/protocol.js";
import { api, home, privateRead, privateWrite, readClient } from "./config.js";
import { Connection } from "./connection.js";

type Input = Extract<Command, { type: "send" }>;
const stateSchema=z.object({session:id,bindingId:id,socket:z.string(),pid:z.number().int().positive()}).strict();
type State=z.infer<typeof stateSchema>;
const digest=(value:string)=>createHash("sha256").update(value).digest("hex").slice(0,24);
const directory=()=>join(home(),"pull");
const statePath=(session:string)=>join(directory(),`${digest(session)}.json`);
export function currentSession(value?:string) {
  const session=value??process.env.CLAUDE_CODE_SESSION_ID;
  if(!session)throw new Error("Run this command inside the current Claude Bash tool, or pass its exact --session ID. Do not guess from history.");
  return id.parse(session);
}
function readState(session:string):State {
  const state=stateSchema.parse(privateRead(statePath(session)));
  if(state.session!==session)throw new Error("Pull session identity mismatch");
  return state;
}
async function control(state:State,action:string,body:unknown={}):Promise<any> {
  return new Promise((resolve,reject)=>{
    const req=request({socketPath:state.socket,path:`/${action}`,method:"POST",headers:{"Content-Type":"application/json","X-Argo-Session":state.session}},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on("data",chunk=>{size+=chunk.length;if(size>600_000){req.destroy();reject(new Error("Pull response too large"));}else chunks.push(chunk);});
      res.on("end",()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(res.statusCode!==200)throw new Error(data.error??"Pull operation rejected");resolve(data);}catch(error){reject(error);}});
      res.on("error",()=>reject(new Error("Pull response interrupted; inspect the session before retrying")));
    });
    req.setTimeout(60_000,()=>req.destroy(new Error("Pull command timed out")));
    req.on("error",()=>reject(new Error("Pull connector unavailable. Check the original attachment process; do not replay uncertain prompts.")));
    req.end(JSON.stringify(body));
  });
}
export async function pullCommand(action:string,session:string,messageId?:string,body?:string,progress=false) {
  const state=readState(session);
  if(action==="reply")return control(state,"reply",{messageId:id.parse(messageId),text:text.parse(body),final:!progress});
  if(action==="ack")return control(state,"ack",{messageId:id.parse(messageId)});
  return control(state,action);
}
export async function attachPull(options:{session:string;name:string;credentialPath?:string;launcher:string}) {
  const {session}=options;id.parse(session);z.string().trim().min(1).max(100).parse(options.name);
  mkdirSync(directory(),{recursive:true,mode:0o700});
  if(existsSync(statePath(session))) {
    const state=readState(session);await control(state,"ping");
    return {bindingId:state.bindingId,mode:"pull",attached:true,alreadyAttached:true};
  }
  const lock=statePath(session)+".lock";
  let fd:number;try{fd=openSync(lock,"wx",0o600);writeFileSync(fd,String(process.pid));}catch{throw new Error("Attachment already starting, or stale session lock exists. Check its PID before removing it.");}
  try {
    let path=options.credentialPath?resolve(options.credentialPath):undefined;
    if(!path) {
      const config=readClient();
      const grant=await api<{version:1;adapter:"claude";bindingId:string;token:string}>(config,"/v1/grants","POST",{adapter:"claude",name:options.name});
      path=join(directory(),`${grant.bindingId}.credential.json`);privateWrite(path,{...grant,url:config.url});
    }
    const credential=credentialSchema.parse(privateRead(path));if(credential.adapter!=="claude")throw new Error("Pull attachment needs a Claude credential");
    const socket=join(directory(),`${digest(credential.bindingId)}.sock`);
    if(Buffer.byteLength(socket)>100)throw new Error("ARGO_HOME is too long for a Unix socket. Use a shorter private directory.");
    const log=join(directory(),`${credential.bindingId}.log`);const logFd=openSync(log,"ax",0o600);
    let child:ReturnType<typeof spawn>;
    try {
      child=spawn(process.execPath,[options.launcher,"pull-worker","--credential",path,"--session",session,"--name",options.name],{detached:true,stdio:["ignore",logFd,logFd],env:process.env});
    }finally{closeSync(logFd);}
    let failed=false;child.on("error",()=>{failed=true;});child.unref();
    const deadline=Date.now()+12_000;
    while(!existsSync(statePath(session))) {
      if(failed||(child.exitCode!==null||child.signalCode!==null)||Date.now()>deadline){child.kill("SIGTERM");throw new Error(`Pull connector did not start. Inspect private log: ${log}`);}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const state=readState(session);await control(state,"ping");
    return {bindingId:state.bindingId,mode:"pull",attached:true,detail:"Run next in this same session, process each message, reply via stdin, then wait again. No MCP or model process was started."};
  }finally{closeSync(fd);unlinkSync(lock);}
}

/** Cooperative pull mode. Only a live next request advertises ready; no terminal injection or model calls. */
export async function runPullWorker(options:{session:string;name:string;credentialPath:string}) {
  const {session}=options;const credential=credentialSchema.parse(privateRead(options.credentialPath));
  if(credential.adapter!=="claude")throw new Error("Not a Claude credential");
  const credentialLock=options.credentialPath+".lock";
  const fd=openSync(credentialLock,"wx",0o600);writeFileSync(fd,String(process.pid));
  let connection:Connection|undefined;let pending:Input|undefined;let delivered=false;
  let waiter:{res:import("node:http").ServerResponse;timer:NodeJS.Timeout}|undefined;
  let closing=false;
  const socket=join(directory(),`${digest(credential.bindingId)}.sock`);
  const json=(res:import("node:http").ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(data));};
  const status=(value:"ready"|"busy"|"waiting")=>connection!.emit({type:"status",status:value,detail:value==="ready"?"Pull mode: current Agent is waiting in next; no native push or approval relay":value==="busy"?"Pull mode: awaiting explicit Agent reply":"Pull mode paused: Agent must run next to receive queued messages"});
  const deliver=()=>{
    if(!pending||!waiter)return;
    const target=waiter;waiter=undefined;clearTimeout(target.timer);delivered=true;
    json(target.res,200,{type:"message",messageId:pending.messageId,text:pending.text,instructions:"Call ack, process in this session, then reply with this messageId and final=true. Do not execute twice."});
  };
  const server=createServer(async(req,res)=>{
    try {
      if(req.headers["x-argo-session"]!==session)throw new Error("Wrong originating session");
      if(req.method!=="POST"||req.headers["content-type"]!=="application/json")throw new Error("Invalid control request");
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>600_000)throw new Error("Request too large");chunks.push(Buffer.from(chunk));}
      let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new Error("Invalid JSON");}
      if(req.url==="/ping"){json(res,200,{bindingId:credential.bindingId,mode:"pull"});return;}
      if(req.url==="/next") {
        z.object({}).strict().parse(body);
        if(waiter)throw new Error("Another next request is already waiting");
        if(pending&&delivered)throw new Error("A message was already delivered. Reply or check its result before waiting again; it will not be replayed.");
        const timer=setTimeout(()=>{if(waiter?.res===res){waiter=undefined;status("waiting");json(res,200,{type:"idle",instructions:"Run next again in this same session to keep receiving. No model request was made by the wait."});}},45_000);
        waiter={res,timer};
        res.on("close",()=>{if(waiter?.res===res){clearTimeout(timer);waiter=undefined;if(!closing)status("waiting");}});
        if(pending)deliver();else status("ready");return;
      }
      if(req.url==="/ack"||req.url==="/reply") {
        const input=z.object({messageId:id,text:text.optional(),final:z.boolean().optional()}).strict().parse(body);
        if(req.url==="/reply" && (input.text===undefined || input.final===undefined))throw new Error("Reply needs text and final");
        if(!pending||!delivered||input.messageId!==pending.messageId)throw new Error("No delivered message with that ID; no operation was repeated");
        if(req.url==="/ack")connection!.emit({type:"receipt",commandId:pending.commandId,messageId:pending.messageId,state:"accepted"});
        else if(input.text!==undefined && input.final!==undefined){
          connection!.emit({type:"message",messageId:`reply:${pending.messageId}`,replyTo:pending.messageId,text:input.text,final:input.final});
          if(input.final){connection!.emit({type:"completed",messageId:pending.messageId});pending=undefined;delivered=false;status("waiting");}
        }
        json(res,200,{ok:true});return;
      }
      if(req.url==="/leave") {
        z.object({}).strict().parse(body);connection!.unbind();json(res,200,{ok:true});setImmediate(()=>{void close();});return;
      }
      throw new Error("Unknown operation");
    }catch(error){if(!res.headersSent)json(res,409,{error:error instanceof z.ZodError?"Invalid control input":error instanceof Error?error.message:"Pull operation failed"});else res.destroy();}
  });
  server.requestTimeout=15_000;
  const close=async()=>{
    if(closing)return;closing=true;
    if(waiter){clearTimeout(waiter.timer);json(waiter.res,200,{type:"unbound"});waiter=undefined;}
    await connection?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const path of [statePath(session),socket,credentialLock])if(existsSync(path))unlinkSync(path);
    closeSync(fd);
  };
  try {
    connection=new Connection(credential,join(home(),"outbox",`${credential.bindingId}.sqlite`));
    connection.onRevoked=()=>{void close();};
    connection.start({nativeSessionId:session,runtimeId:randomUUID(),machine:hostname(),cwd:process.cwd(),capabilities:{send:true,streaming:false,interrupt:false,approvals:false,questions:false},
      async handle(command){if(command.type!=="send"||pending)throw new Error("Unsupported pull command");pending=command;delivered=false;status("busy");connection!.emit({type:"receipt",commandId:command.commandId,messageId:command.messageId,state:"submitted"});deliver();},async close(){}} ,options.name);
    status("waiting");await connection.ready();
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,resolve);});chmodSync(socket,0o600);
    privateWrite(statePath(session),{session,bindingId:credential.bindingId,socket,pid:process.pid});
    for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void close();});
  }catch(error){await close();throw error;}
}
