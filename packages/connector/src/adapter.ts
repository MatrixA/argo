import type { AgentEvent, Capabilities, Command } from "../../shared/src/protocol.js";
export interface Adapter {
  nativeSessionId: string;
  runtimeId: string;
  machine: string;
  cwd: string;
  capabilities: Capabilities;
  handle(command: Command): Promise<void>;
  close(): Promise<void>;
}
export type Emit = (event: AgentEvent) => void;
