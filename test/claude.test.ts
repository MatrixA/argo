import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { startBridge } from "../packages/bridge/src/server.js";
import { privateWrite } from "../packages/connector/src/config.js";
import { secret } from "../packages/bridge/src/store.js";
import type { Snapshot } from "../packages/shared/src/protocol.js";

test("real MCP subprocess negotiates Channel, binds exact process, relays input and replies",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"argo-mcp-"));
  const token=secret();const bridge=await startBridge({database:join(directory,"bridge.sqlite"),token,port:0});
  const grant=bridge.store.createGrant("channel-test","claude");const credentialPath=join(directory,"credential.json");
  privateWrite(credentialPath,{version:1,adapter:"claude",...grant,url:bridge.url});
  const client=new Client({name:"argo-channel-test",version:"0.1.0"});
  const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx","packages/connector/src/cli.ts","channel","--credential",credentialPath],env:{...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==="string")),ARGO_HOME:join(directory,"connector")},stderr:"pipe"});
  const inbound:Array<{content:string;meta:Record<string,string>}>=[];
  client.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})}),async notification=>{inbound.push(notification.params);});
  const permissionReplies:unknown[]=[];
  client.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel/permission"),params:z.object({request_id:z.string(),behavior:z.enum(["allow","deny"])})}),async n=>{permissionReplies.push(n.params);});
  const until=async(check:()=>boolean)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,10));}throw new Error("Condition timed out");};
  try {
    await client.connect(transport);
    assert.ok(client.getServerCapabilities()?.experimental?.["claude/channel"]);
    const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==="bind"));
    assert.equal((await client.callTool({name:"bind",arguments:{name:"test"}})).isError,true,"Ordinary MCP connection is not assumed to be an enabled channel");
    await client.callTool({name:"channel_ready",arguments:{}});
    const bound=await client.callTool({name:"bind",arguments:{name:"test"}});assert.notEqual(bound.isError,true);
    const session=bridge.store.snapshot(grant.bindingId).session;assert.equal(session.status,"ready");
    const result=await fetch(`${bridge.url}/v1/sessions/${grant.bindingId}/messages`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({generation:session.generation,messageId:"mcp-message",text:"hello existing process"})});
    assert.equal(result.status,202);await until(()=>inbound.length===1);assert.equal(inbound[0]?.content,"hello existing process");
    const messageId=inbound[0]!.meta.message_id!;
    await client.callTool({name:"acknowledge",arguments:{message_id:messageId}});
    await client.callTool({name:"reply",arguments:{message_id:messageId,text:"reply through original MCP process",final:true}});
    await until(()=>bridge.store.snapshot(grant.bindingId).messages.some(m=>m.role==="assistant"));
    const history=bridge.store.snapshot(grant.bindingId).messages;assert.equal(history[0]?.state,"completed");assert.equal(history[1]?.replyTo,"mcp-message");
    await client.notification({method:"notifications/claude/channel/permission_request",params:{request_id:"abcde",tool_name:"Edit",description:"Edit a test file",input_preview:'{"file_path":"/test/file"}'}});
    await until(()=>bridge.store.snapshot(grant.bindingId).interactions.length===1);
    const response=await fetch(`${bridge.url}/v1/sessions/${grant.bindingId}/interactions/abcde`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({generation:session.generation,decision:"deny"})});assert.equal(response.status,202);
    await until(()=>permissionReplies.length===1);assert.deepEqual(permissionReplies[0],{request_id:"abcde",behavior:"deny"});
    assert.equal((bridge.store.snapshot(grant.bindingId) as Snapshot).interactions[0]?.state,"submitted","No native ACK means no claimed approval resolution");
  } finally {await client.close();await bridge.close();rmSync(directory,{recursive:true,force:true});}
});
