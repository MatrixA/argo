import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { id, text, localUrl, type Command } from "../../shared/src/protocol.js";
import type { Adapter, Emit } from "./adapter.js";

const permissionSchema=z.object({method:z.literal("notifications/claude/channel/permission_request"),params:z.object({request_id:z.string().regex(/^[a-km-z]{5}$/),tool_name:z.string().max(500),description:z.string().max(10_000),input_preview:z.string().max(100_000)})});
export function createClaudeChannel(options:{bind:(name:string,url?:string)=>Promise<void>;unbind:()=>Promise<void>}) {
  const runtimeId=randomUUID();
  let emit:Emit=()=>{};
  let confirmed=false;
  const pending=new Map<string,Command&{type:"send"}>();
  const permissions=new Map<string,number>();
  const usedPermissions=new Set<string>();
  const mcp=new Server({name:"argo",version:"0.1.0"},{
    capabilities:{experimental:{"claude/channel":{},"claude/channel/permission":{}},tools:{}},
    instructions:"Argo connects this exact session to Raycast. When asked to bind, call bind with the display name. Never read credential files or include secrets in tool arguments. Inbound <channel> messages carry message_id. Call acknowledge(message_id) when you start processing, and reply(message_id,text,final) to send all progress and final answers back to Raycast; final=true only when done. Do not put the answer only in terminal prose. Before bind, call channel_ready ONLY after the user confirms the startup banner lists server:argo as a registered channel. Ordinary MCP tools alone cannot enable a channel.",
  });
  const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({name,description,inputSchema:{type:"object" as const,properties,required,additionalProperties:false}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
    tool("channel_ready","Record the user's confirmation that the startup banner lists Argo as an enabled Channel. This does not bypass channel registration or permissions.",{},[]),
    tool("bind","Bind this session to the paired Raycast bridge. Pairing credentials must already be installed by the user, never passed as arguments.",{name:{type:"string",description:"Display name"},url:{type:"string",description:"Optional loopback bridge address, including forwarded port"}},["name"]),
    tool("unbind","Detach Raycast without stopping this Agent.",{},[]),
    tool("acknowledge","Acknowledge that you started processing an inbound Raycast message.",{message_id:{type:"string"}},["message_id"]),
    tool("reply","Send a progress update or final response to a specific inbound message.",{message_id:{type:"string"},text:{type:"string"},final:{type:"boolean"}},["message_id","text","final"]),
  ]}));
  mcp.setRequestHandler(CallToolRequestSchema,async request=>{
    try {
      const args=request.params.arguments??{};
      switch(request.params.name) {
        case "channel_ready": z.object({}).strict().parse(args);confirmed=true;break;
        case "bind": {
          const input=z.object({name:z.string().min(1).max(100),url:z.string().optional()}).strict().parse(args);
          if(!confirmed)throw new Error("Ask the user to confirm the startup banner lists server:argo as an enabled Channel, then call channel_ready. Otherwise restart with the documented channel flag.");
          if(input.url)localUrl(input.url);
          await options.bind(input.name,input.url);break;
        }
        case "unbind":z.object({}).strict().parse(args);await options.unbind();break;
        case "acknowledge": {
          const input=z.object({message_id:id}).strict().parse(args);const command=pending.get(input.message_id);
          if(!command)throw new Error("No pending inbound message with that ID");
          emit({type:"receipt",commandId:command.commandId,messageId:command.messageId,state:"accepted"});break;
        }
        case "reply": {
          const input=z.object({message_id:id,text,final:z.boolean()}).strict().parse(args);
          const command=pending.get(input.message_id);if(!command)throw new Error("No pending inbound message with that ID");
          emit({type:"message",messageId:`reply:${command.messageId}`,text:input.text,replyTo:command.messageId,final:input.final});
          if(input.final){emit({type:"completed",messageId:command.messageId});emit({type:"status",status:"ready"});pending.delete(input.message_id);}break;
        }
        default:throw new Error("Unknown tool");
      }
      return {content:[{type:"text" as const,text:"Done"}]};
    } catch(error) {return {isError:true,content:[{type:"text" as const,text:error instanceof Error?error.message:"Tool failed"}]};}
  });
  mcp.setNotificationHandler(permissionSchema,async notification=>{
    const {request_id,tool_name,description,input_preview}=notification.params;
    if(usedPermissions.has(request_id))return; // Native IDs that repeat must be answered in the terminal.
    usedPermissions.add(request_id);
    const expiresAt=Date.now()+5*60_000;permissions.set(request_id,expiresAt);
    emit({type:"interaction",interaction:{requestId:request_id,kind:"approval",title:`${tool_name}: ${description}`,detail:input_preview,expiresAt}});
  });
  const adapter:Adapter={
    nativeSessionId:`channel:${runtimeId}`,runtimeId,machine:hostname(),cwd:process.cwd(),
    capabilities:{send:true,streaming:false,interrupt:false,approvals:true,questions:false},
    async handle(command) {
      if(command.type==="send") {
        pending.set(command.messageId,command);
        emit({type:"status",status:"busy"});
        await mcp.notification({method:"notifications/claude/channel",params:{content:command.text,meta:{message_id:command.messageId}}});
        emit({type:"receipt",commandId:command.commandId,messageId:command.messageId,state:"submitted"});
      } else if(command.type==="answer") {
        const expiry=permissions.get(command.requestId);
        if(!expiry||expiry<=Date.now()||!command.answer.decision)throw new Error("Permission request is expired or unsupported");
        permissions.delete(command.requestId);
        await mcp.notification({method:"notifications/claude/channel/permission",params:{request_id:command.requestId,behavior:command.answer.decision}});
        // Native relay has no resolved acknowledgement; report submitted, never claim it was applied.
      } else throw new Error("This channel does not provide native interruption");
    },
    async close(){await mcp.close();},
  };
  return {mcp,adapter,setEmit(sink:Emit){emit=sink;},async start(){await mcp.connect(new StdioServerTransport());}};
}
