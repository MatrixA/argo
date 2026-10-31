import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { Store } from "./store.js";
import { answerSchema, connectorFrameSchema, pairingCodeSchema, id, MAX_TEXT, VERSION, type BridgeEvent } from "../../shared/src/protocol.js";

export interface BridgeOptions { database: string; token: string; port?: number }
export async function startBridge(options: BridgeOptions) {
  const store = new Store(options.database);
  const sockets = new Map<string, WebSocket>();
  const listeners = new Map<ServerResponse, boolean>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 600_000 });
  const sameSecret = (value: string) => {
    const expected=Buffer.from(options.token), actual=Buffer.from(value);
    return actual.length===expected.length && timingSafeEqual(actual,expected);
  };
  const json = (response:ServerResponse,status:number,data:unknown) => {
    response.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    response.end(JSON.stringify(data));
  };
  const sendEvent = (res:ServerResponse,event:BridgeEvent) => {
    if (!res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`)) res.destroy();
  };
  store.onEvent = event => { for(const listener of listeners.keys()) sendEvent(listener,event); };
  const pump = (binding:string) => {
    const socket=sockets.get(binding);
    if (!socket || socket.readyState!==WebSocket.OPEN) return;
    const command=store.nextCommand(binding);
    if(command) socket.send(JSON.stringify({type:"command",generation:store.get(binding).generation,command}));
  };
  function boundary(req:IncomingMessage) {
    // Browser-origin requests have no reason to reach this native-only control service.
    if(req.headers.origin!==undefined || !req.headers.host) return false;
    return /^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/.test(req.headers.host);
  }
  async function body(req:IncomingMessage):Promise<unknown> {
    if(req.headers["content-type"]?.split(";")[0]!=="application/json") throw new Error("Expected application/json");
    let length=0; const chunks:Buffer[]=[];
    for await(const chunk of req) { length+=Buffer.byteLength(chunk); if(length>600_000) throw new Error("Request too large"); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const authenticationError = new Error("Authentication required");
  let claimWindow=Date.now(), claimCount=0;
  const server=createServer(async(req,res)=>{
    if(!boundary(req)) { json(res,403,{error:"Loopback native clients only"}); return; }
    try {
      const url=new URL(req.url??"/","http://127.0.0.1");
      if(req.method==="GET" && url.pathname==="/v1/discovery") {
        if(url.searchParams.getAll("challenge").length!==1) {json(res,409,{error:"Invalid discovery challenge"});return;}
        const challenge=z.string().length(32).regex(/^[a-f0-9]{32}$/).parse(url.searchParams.get("challenge"));
        json(res,200,store.discovery(challenge));return;
      }
      // Both narrowly scoped exchanges share a bounded unauthenticated attempt budget.
      // Codes have 128 random bits, expire after ten minutes and are single-use/hashed.
      if(req.method==="POST" && ["/v1/pairings/claim","/v1/client-pairings/claim"].includes(url.pathname)) {
        if(Date.now()-claimWindow>=60_000){claimWindow=Date.now();claimCount=0;}
        if(++claimCount>60){json(res,429,{error:"Too many pairing attempts; wait a minute"});return;}
        const client=url.pathname==="/v1/client-pairings/claim";
        const code=client?z.string().length(109).regex(/^ARGO-CLIENT-[a-f0-9]{64}-[a-f0-9]{32}$/):pairingCodeSchema;
        const input=z.object({code}).strict().parse(await body(req));
        json(res,201,client?store.claimClientPairing(input.code):store.claimPairing(input.code));return;
      }
      const token=(req.headers.authorization??"").replace(/^Bearer /,"");
      const admin=sameSecret(token);
      if(!admin && !store.authenticateClient(token)) { json(res,401,{error:"Authentication required"}); return; }
      const authorizedBody = async () => {
        const input = await body(req);
        // Body upload yields to revocation requests. Recheck before any mutation.
        if(!admin && !store.authenticateClient(token)) throw authenticationError;
        return input;
      };
      if(req.method==="POST" && url.pathname==="/v1/client-pairings") {
        if(!admin) {json(res,403,{error:"Administrator authentication required"});return;}
        z.object({}).strict().parse(await authorizedBody());
        json(res,201,store.createClientPairing());return;
      }
      if(req.method==="DELETE" && url.pathname==="/v1/clients") {
        if(!admin) {json(res,403,{error:"Administrator authentication required"});return;}
        store.revokeClients();
        for(const [listener,isAdmin] of listeners) if(!isAdmin) {listeners.delete(listener);listener.end();}
        json(res,200,{ok:true});return;
      }
      if(req.method==="POST" && url.pathname==="/v1/pairings") {
        const input=z.object({name:z.string().trim().min(1).max(100),adapter:z.enum(["claude","codex"])}).strict().parse(await authorizedBody());
        json(res,201,store.createPairing(input.name,input.adapter));return;
      }
      if(req.method==="DELETE" && url.pathname==="/v1/pairings") {
        const input=z.object({code:pairingCodeSchema}).strict().parse(await authorizedBody());
        store.cancelPairing(input.code);json(res,200,{ok:true});return;
      }
      if(req.method==="GET" && url.pathname==="/v1/sessions") { json(res,200,{sessions:store.list(),cursor:store.cursor()}); return; }
      if(req.method==="POST" && url.pathname==="/v1/grants") {
        const input=z.object({name:z.string().trim().min(1).max(100),adapter:z.enum(["claude","codex"])}).strict().parse(await authorizedBody());
        json(res,201,{version:VERSION,adapter:input.adapter,...store.createGrant(input.name,input.adapter)}); return;
      }
      if(req.method==="GET" && url.pathname==="/v1/events") {
        const after=z.coerce.number().int().min(0).parse(url.searchParams.get("after")??0);
        const events=store.events(after);
        if(events.length>1000 || after>store.cursor()) { json(res,409,{error:"Reload a snapshot before subscribing"}); return; }
        res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store","Connection":"keep-alive","X-Content-Type-Options":"nosniff"});
        res.write(": connected\n\n");
        for(const event of events) sendEvent(res,event);
        listeners.set(res,admin);
        req.on("close",()=>listeners.delete(res)); return;
      }
      const match=/^\/v1\/sessions\/([\w.-]+)(?:\/(messages|interrupt|interactions|reconcile)(?:\/([\w:.-]+))?)?$/.exec(url.pathname);
      if(!match) { json(res,404,{error:"Not found"}); return; }
      const binding=id.parse(match[1]), resource=match[2], requestId=match[3];
      if(req.method==="GET" && !resource) {
        const before=z.coerce.number().int().positive().parse(url.searchParams.get("before")??Number.MAX_SAFE_INTEGER);
        json(res,200,store.snapshot(binding,before)); return;
      }
      if(req.method==="DELETE" && !resource) {
        store.revoke(binding); sockets.get(binding)?.send(JSON.stringify({type:"revoked"})); sockets.get(binding)?.close(1000,"Unbound");
        json(res,200,{ok:true}); return;
      }
      if(req.method==="POST" && resource==="messages") {
        const input=z.object({generation:id,messageId:id,text:z.string().min(1).max(MAX_TEXT).refine(s=>s.trim().length>0,"Message is empty")}).strict().parse(await authorizedBody());
        const message=store.enqueue(binding,input.generation,input.messageId,input.text); pump(binding); json(res,202,message); return;
      }
      if(req.method==="POST" && resource==="interactions" && requestId) {
        const input=z.object({generation:id,decision:z.enum(["allow","deny"]).optional(),answers:z.record(z.string(),z.array(z.string().max(10_000))).optional()}).strict().parse(await authorizedBody());
        const answer=answerSchema.parse({...(input.decision?{decision:input.decision}:{}),...(input.answers?{answers:input.answers}:{})});
        const commandId=store.answer(binding,input.generation,requestId,answer);pump(binding);json(res,202,{commandId});return;
      }
      if(req.method==="POST" && resource==="reconcile") {
        const input=z.object({generation:id,messageId:id}).strict().parse(await authorizedBody());
        store.reconcile(binding,input.generation,input.messageId);pump(binding);json(res,200,{ok:true});return;
      }
      if(req.method==="POST" && resource==="interrupt") {
        const input=z.object({generation:id}).strict().parse(await authorizedBody());
        const commandId=store.interrupt(binding,input.generation);pump(binding);json(res,202,{commandId});return;
      }
      json(res,404,{error:"Not found"});
    } catch(error) {
      const message=error instanceof z.ZodError || error instanceof SyntaxError?"Invalid request":error instanceof Error?error.message:"Request failed";
      if(!res.headersSent) json(res,error===authenticationError?401:error instanceof SyntaxError?400:409,{error:message}); else res.destroy();
    }
  });
  server.requestTimeout=15_000;
  server.headersTimeout=10_000;
  server.on("upgrade",(req,socket,head)=>{
    let url:URL;
    try {url=new URL(req.url??"/","http://127.0.0.1");}
    catch {socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");return;}
    const match=/^\/v1\/connectors\/([\w.-]+)$/.exec(url.pathname);
    const binding=match?.[1]; const token=(req.headers.authorization??"").replace(/^Bearer /,"");
    if(!boundary(req)||!binding||!store.authenticate(binding,token)) {socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return;}
    if(sockets.has(binding)) {socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      sockets.set(binding,ws);
      let registered=false,alive=true;
      const registrationTimeout=setTimeout(()=>{if(!registered) ws.close(1008,"Registration required");},5000);
      ws.on("pong",()=>{alive=true;});
      const heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},15_000);
      ws.on("error",()=>{});
      ws.on("message",raw=>{
        try {
          const frame=connectorFrameSchema.parse(JSON.parse(raw.toString()));
          if(frame.type==="register") {
            if(registered) throw new Error("Already registered");
            const generation=store.register(binding,frame);registered=true;clearTimeout(registrationTimeout);
            ws.send(JSON.stringify({type:"registered",bindingId:binding,generation}));
          } else if(frame.type==="unbind") {
            if(!registered)throw new Error("Register first");
            store.revoke(binding);ws.send(JSON.stringify({type:"revoked"}));ws.close(1000,"Unbound");
          } else {
            if(!registered) throw new Error("Register first");
            store.acceptEvent(binding,frame.eventId,frame.event);
            ws.send(JSON.stringify({type:"ack",eventId:frame.eventId}));pump(binding);
          }
        } catch {ws.close(1008,"Invalid connector frame or session identity");}
      });
      ws.on("close",()=>{
        clearInterval(heartbeat);clearTimeout(registrationTimeout);
        if(sockets.get(binding)===ws) {sockets.delete(binding);if(registered && !store.get(binding).revoked) store.disconnect(binding);}
      });
    });
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port??48123,"127.0.0.1",resolve);});
  } catch(error) { wss.close();store.close();throw error; }
  const keepalive=setInterval(()=>{for(const listener of listeners.keys()) if(!listener.write(": heartbeat\n\n")) listener.destroy();},15_000);
  const address=server.address();if(!address||typeof address==="string")throw new Error("No listening port");
  return {
    url:`http://127.0.0.1:${address.port}`,store,
    async close(){clearInterval(keepalive);for(const listener of listeners.keys())listener.end();for(const socket of sockets.values())socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));wss.close();store.close();},
  };
}
