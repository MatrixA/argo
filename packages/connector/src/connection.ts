import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { agentEventSchema, credentialSchema, localUrl, serverFrameSchema, VERSION, type AgentEvent, type Command, type Credential } from "../../shared/src/protocol.js";
import type { Adapter } from "./adapter.js";

export class Connection {
  private db:DatabaseSync;
  private socket?:WebSocket;
  private timer?:ReturnType<typeof setTimeout>;
  private stopped=false;
  private registered=false;
  private generation?:string;
  private retry=500;
  private adapter?:Adapter;
  private name?:string;
  private chain=Promise.resolve();
  private sent=new Set<string>();
  private readyWaiters:Array<()=>void>=[];
  onRevoked:()=>void=()=>{};
  onError:(message:string)=>void=message=>console.error(message);
  constructor(readonly credential:Credential,path:string) {
    credentialSchema.parse(credential);localUrl(credential.url);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,data TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const bound=this.db.prepare("SELECT value FROM metadata WHERE key='binding'").get();
    if(bound&&bound.value!==credential.bindingId)throw new Error("Outbox belongs to another binding");
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('binding',?)").run(credential.bindingId);
  }
  readonly emit=(event:AgentEvent)=>{
    if(this.stopped)return;
    agentEventSchema.parse(event);
    if(event.type==="status")this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('status',?)").run(JSON.stringify(event));
    const n=Number(this.db.prepare("SELECT count(*) AS n FROM outbox").get()?.n);
    if(n>=10_000)throw new Error("Offline event outbox is full; reconnect before continuing");
    const eventId=randomUUID();
    this.db.prepare("INSERT INTO outbox VALUES (?,?)").run(eventId,JSON.stringify(event));
    this.flush();
  };
  start(adapter:Adapter,name?:string) {
    this.adapter=adapter;this.name=name;
    const runtime=this.db.prepare("SELECT value FROM metadata WHERE key='runtime'").get();
    if(runtime&&runtime.value!==adapter.runtimeId) {
      // A new runtime may not replay authority or replies left by an old process.
      throw new Error("Runtime changed; create a new binding and outbox explicitly");
    }
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('runtime',?)").run(adapter.runtimeId);
    this.connect();
  }
  async ready(timeout=10_000) {
    if(this.registered)return;
    await new Promise<void>((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{this.readyWaiters=this.readyWaiters.filter(w=>w!==done);reject(new Error("Bridge registration timed out"));},timeout);
      this.readyWaiters.push(done);
    });
  }
  private connect() {
    if(this.stopped||!this.adapter)return;
    const url=localUrl(this.credential.url);url.protocol="ws:";url.pathname=`/v1/connectors/${this.credential.bindingId}`;
    const socket=new WebSocket(url,{headers:{Authorization:`Bearer ${this.credential.token}`},maxPayload:600_000,handshakeTimeout:5000});
    this.socket=socket;
    socket.on("open",()=>{
      const adapter=this.adapter!;
      socket.send(JSON.stringify({type:"register",version:VERSION,...(this.name?{name:this.name}:{}),nativeSessionId:adapter.nativeSessionId,runtimeId:adapter.runtimeId,machine:adapter.machine,cwd:adapter.cwd,capabilities:adapter.capabilities}));
    });
    socket.on("error",()=>{});
    socket.on("unexpected-response",(_req,res)=>{
      res.resume();
      if([401,403].includes(res.statusCode??0)){this.onError("Connector credential was rejected; pairing is required");this.stopNetwork();this.onRevoked();}
      else socket.terminate(); // End rejected handshakes so close schedules the normal retry.
    });
    socket.on("message",raw=>{
      try {
        const frame=serverFrameSchema.parse(JSON.parse(raw.toString()));
        if(frame.type==="registered") {
          this.generation=frame.generation;this.registered=true;this.retry=500;this.sent.clear();
          this.flush();
          // Re-send the latest runtime status after reconnect, even when its original event was ACKed.
          const state=this.db.prepare("SELECT value FROM metadata WHERE key='status'").get();
          if(state)this.emit(JSON.parse(String(state.value)) as AgentEvent);
          for(const waiter of this.readyWaiters.splice(0))waiter();
        } else if(frame.type==="ack") {
          this.db.prepare("DELETE FROM outbox WHERE id=?").run(frame.eventId);this.sent.delete(frame.eventId);
        } else if(frame.type==="command") {
          if(!this.registered||frame.generation!==this.generation)throw new Error("Stale command");
          this.chain=this.chain.then(()=>this.execute(frame.command)).catch(()=>this.onError("Connector command processing failed"));
        } else if(frame.type==="revoked") {this.stopNetwork();this.onRevoked();}
        else {this.onError(frame.message);}
      } catch {socket.close(1008,"Invalid bridge frame");}
    });
    socket.on("close",code=>{
      this.registered=false;this.sent.clear();
      if(code===1008){this.onError("Session identity rejected; create a new binding");this.stopNetwork();return;}
      if(!this.stopped)this.timer=setTimeout(()=>this.connect(),this.retry=Math.min(this.retry*2,10_000));
    });
  }
  private flush() {
    if(!this.registered||this.socket?.readyState!==WebSocket.OPEN)return;
    for(const row of this.db.prepare("SELECT id,data FROM outbox ORDER BY rowid").all()) {
      const eventId=String(row.id);if(this.sent.has(eventId))continue;
      this.socket.send(JSON.stringify({type:"event",eventId,event:JSON.parse(String(row.data))}));this.sent.add(eventId);
    }
  }
  private async execute(command:Command) {
    if(this.stopped||!this.adapter)return;
    const old=this.db.prepare("SELECT data,state FROM commands WHERE id=?").get(command.commandId);
    if(old) {
      if(old.data!==JSON.stringify(command))throw new Error("Command ID collision");
      // No re-execution, even if the previous process died between persistence and write.
      this.emit({type:"receipt",commandId:command.commandId,...(command.type==="send"?{messageId:command.messageId}:{}),state:"unknown",detail:"Command already seen; not executed again"});return;
    }
    this.db.prepare("INSERT INTO commands VALUES (?,?,?)").run(command.commandId,JSON.stringify(command),"started");
    try {
      await this.adapter.handle(command);
      if(command.type!=="send")this.emit({type:"receipt",commandId:command.commandId,state:"submitted"});
      this.db.prepare("UPDATE commands SET state='handled' WHERE id=?").run(command.commandId);
    } catch {
      this.db.prepare("UPDATE commands SET state='unknown' WHERE id=?").run(command.commandId);
      this.emit({type:"receipt",commandId:command.commandId,...(command.type==="send"?{messageId:command.messageId}:{}),state:"unknown",detail:"Agent operation could not be confirmed. Check the original session before retrying."});
    }
  }
  unbind(){
    if(!this.registered||this.socket?.readyState!==WebSocket.OPEN)throw new Error("Bridge is not connected");
    this.socket.send(JSON.stringify({type:"unbind"}));
  }
  private stopNetwork(){this.stopped=true;this.registered=false;clearTimeout(this.timer);this.socket?.terminate();}
  async close(){this.stopNetwork();await this.chain;this.db.close();}
}
