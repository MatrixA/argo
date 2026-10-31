import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, BridgeEvent, Capabilities, Command, ConnectorFrame, Interaction, Message, Session, Snapshot, Status } from "../../shared/src/protocol.js";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("hex");
// Read public pinning metadata only: constructing Store would recover/mutate live sessions.
export function readBridgeId(database: string): string | undefined {
  if (!existsSync(database)) return undefined;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()) return undefined;
    const row = db.prepare("SELECT value FROM metadata WHERE key='bridge_public_key'").get();
    if (!row) return undefined;
    try {
      const der = Buffer.from(String(row.value), "base64");
      const key = createPublicKey({ key: der, type: "spki", format: "der" });
      if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "der" }).toString("base64") !== row.value) throw new Error();
      return createHash("sha256").update(der).digest("hex");
    } catch { throw new Error("Invalid persisted bridge public identity"); }
  } finally { db.close(); }
}
const noCapabilities: Capabilities = { send: false, streaming: false, interrupt: false, approvals: false, questions: false };
interface StoredSession extends Session { tokenHash: string; runtimeId: string | null; inFlight: string | null; runtimeStatus?: Status }
export class Store {
  readonly db: DatabaseSync;
  readonly bridgeId: string;
  readonly publicKey: string;
  readonly #identityKey: KeyObject;
  onEvent: (event: BridgeEvent) => void = () => {};
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_pairings (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clients (hash TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (binding TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(binding,id));
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, binding TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions (binding TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(binding,id));
      CREATE TABLE IF NOT EXISTS receipts (binding TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(binding,id));
      CREATE TABLE IF NOT EXISTS pairings (hash TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, binding TEXT NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_history ON messages(binding,created);
      CREATE INDEX IF NOT EXISTS command_queue ON commands(binding,state,created);`);
    let identity = this.db.prepare("SELECT value FROM metadata WHERE key='bridge_identity'").get();
    if (!identity) {
      const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('bridge_identity',?)").run(key);
      identity = this.db.prepare("SELECT value FROM metadata WHERE key='bridge_identity'").get();
    }
    this.#identityKey = createPrivateKey({ key: Buffer.from(String(identity!.value), "base64"), type: "pkcs8", format: "der" });
    const publicKey = createPublicKey(this.#identityKey).export({ type: "spki", format: "der" });
    this.publicKey = publicKey.toString("base64");
    this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('bridge_public_key',?)").run(this.publicKey);
    this.bridgeId = createHash("sha256").update(publicKey).digest("hex");
    for (const session of this.allStored()) {
      session.online = false;
      session.runtimeStatus = "offline";
      session.status = "offline";
      if (session.inFlight) {
        const message = this.message(session.id, session.inFlight);
        if (message) { message.state = "unknown"; message.detail = "Bridge restarted before a confirmed turn result. Do not resend automatically."; this.saveMessage(session.id, message); }
      }
      this.saveSession(session);
    }
    this.db.exec("UPDATE commands SET state='unknown' WHERE state='dispatched'");
    // Pending UI decisions never survive a service restart.
    for (const row of this.db.prepare("SELECT binding,data FROM interactions").all() as unknown as {binding:string;data:string}[]) {
      const interaction = JSON.parse(row.data) as Interaction;
      if (["pending", "submitted"].includes(interaction.state)) { interaction.state = "expired"; this.saveInteraction(row.binding, interaction); }
    }
    // Recovery mutates snapshots too. Persist invalidations for clients resuming an old SSE cursor.
    for (const session of this.allStored()) this.publish(session.id, "recovery");
  }
  discovery(challenge: string) {
    if (challenge.length !== 32 || !/^[a-f0-9]{32}$/.test(challenge)) throw new Error("Invalid discovery challenge");
    const signature = sign(null, Buffer.from(`argo-discovery-v1\n${challenge}\n${this.bridgeId}`, "utf8"), this.#identityKey).toString("base64");
    return { service: "argo" as const, protocol: 1 as const, bridgeId: this.bridgeId, publicKey: this.publicKey, challenge, signature };
  }
  createClientPairing() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM client_pairings WHERE expires<=?").run(Date.now());
      if (Number(this.db.prepare("SELECT count(*) AS n FROM client_pairings").get()?.n) >= 20) throw new Error("Too many pending client pairing codes; wait for expiry");
      const code = `ARGO-CLIENT-${this.bridgeId}-${randomBytes(16).toString("hex")}`;
      const expiresAt = Date.now() + 10 * 60_000;
      this.db.prepare("INSERT INTO client_pairings VALUES (?,?)").run(hash(code), expiresAt);
      this.db.exec("COMMIT");
      return { code, expiresAt, bridgeId: this.bridgeId };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  claimClientPairing(code: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pairing = this.db.prepare("SELECT expires FROM client_pairings WHERE hash=?").get(hash(code));
      if (!pairing || Number(pairing.expires) <= Date.now()) throw new Error("Client pairing code is invalid, expired, or already used");
      const token = secret();
      this.db.prepare("DELETE FROM client_pairings WHERE hash=?").run(hash(code));
      this.db.prepare("INSERT INTO clients VALUES (?,?)").run(hash(token), Date.now());
      this.db.exec("COMMIT");
      return { token, bridgeId: this.bridgeId };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  authenticateClient(token: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM clients WHERE hash=?").get(hash(token))); }
  revokeClients() { this.db.exec("DELETE FROM clients"); }
  private allStored(): StoredSession[] { return this.db.prepare("SELECT data FROM sessions").all().map(r => JSON.parse(String(r.data)) as StoredSession); }
  get(binding: string): StoredSession {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(binding);
    if (!row) throw new Error("Unknown binding");
    return JSON.parse(String(row.data)) as StoredSession;
  }
  private saveSession(session: StoredSession) { this.db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?)").run(session.id, JSON.stringify(session)); }
  private publicSession(session: StoredSession): Session {
    const { tokenHash: _token, runtimeId: _runtime, inFlight, runtimeStatus: _status, ...publicData } = session;
    return {...publicData,...(inFlight && this.message(session.id,inFlight)?.state==="unknown" ? {uncertainMessageId:inFlight} : {})};
  }
  list(): Session[] { return this.allStored().filter(s => !s.revoked).map(s => this.publicSession(s)); }
  createGrant(name: string, adapter: Session["adapter"]): {bindingId:string;token:string} {
    const token = secret();
    const session: StoredSession = {
      id: randomUUID(), name, adapter, generation: randomUUID(), nativeSessionId: null,
      machine: "", cwd: "", online: false, status: "offline", capabilities: noCapabilities,
      updatedAt: Date.now(), revoked: false, tokenHash: hash(token), runtimeId: null, inFlight: null,
    };
    this.saveSession(session); this.publish(session.id, "session");
    return { bindingId: session.id, token };
  }
  createPairing(name: string, adapter: Session["adapter"]) {
    this.db.prepare("DELETE FROM pairings WHERE expires<=?").run(Date.now());
    if (Number(this.db.prepare("SELECT count(*) AS n FROM pairings").get()?.n) >= 20) throw new Error("Too many pending pairing codes; cancel one or wait for expiry");
    const code = "ARGO-" + randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 10 * 60_000;
    this.db.prepare("INSERT INTO pairings VALUES (?,?,?,?)").run(hash(code), name, adapter, expiresAt);
    return { code, expiresAt };
  }
  cancelPairing(code: string) { this.db.prepare("DELETE FROM pairings WHERE hash=?").run(hash(code)); }
  claimPairing(code: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pairing = this.db.prepare("SELECT name,adapter,expires FROM pairings WHERE hash=?").get(hash(code));
      if (!pairing || Number(pairing.expires) <= Date.now()) throw new Error("Pairing code is invalid, expired, or already used");
      this.db.prepare("DELETE FROM pairings WHERE hash=?").run(hash(code));
      const grant = this.createGrant(String(pairing.name), pairing.adapter as Session["adapter"]);
      this.db.exec("COMMIT");
      return { version: 1 as const, adapter: pairing.adapter as Session["adapter"], ...grant };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  authenticate(binding: string, token: string): boolean {
    try { const session = this.get(binding); return !session.revoked && session.tokenHash === hash(token); } catch { return false; }
  }
  register(binding: string, frame: Extract<ConnectorFrame,{type:"register"}>) {
    const session = this.get(binding);
    if (session.revoked) throw new Error("Binding was revoked");
    if (session.nativeSessionId && session.nativeSessionId !== frame.nativeSessionId) throw new Error("Native session changed; pair a new binding");
    if (session.runtimeId && session.runtimeId !== frame.runtimeId) throw new Error("Runtime changed; pair a new binding explicitly");
    if(frame.name)session.name=frame.name;
    Object.assign(session, { nativeSessionId: frame.nativeSessionId, runtimeId: frame.runtimeId,
      machine: frame.machine, cwd: frame.cwd, capabilities: frame.capabilities,
      online: true, status: "connecting", runtimeStatus: "connecting", updatedAt: Date.now() });
    this.saveSession(session); this.publish(binding, "session");
    return session.generation;
  }
  disconnect(binding: string) {
    const session = this.get(binding); session.online = false; session.status = "offline"; session.runtimeStatus="offline"; session.updatedAt = Date.now();
    if(session.inFlight) {
      const message=this.message(binding,session.inFlight);
      if(message && !["completed","failed"].includes(message.state)) {
        message.state="unknown";message.detail="Connection lost before a confirmed result. Check the original session; this prompt is not replayed.";
        this.saveMessage(binding,message);
      }
    }
    this.db.prepare("UPDATE commands SET state='unknown' WHERE binding=? AND state='dispatched'").run(binding);
    this.saveSession(session); this.publish(binding, "session");
  }
  revoke(binding: string) {
    const session = this.get(binding); session.revoked = true; session.online = false; session.status = "offline";
    this.saveSession(session);
    this.db.prepare("UPDATE commands SET state='cancelled' WHERE binding=? AND state='queued'").run(binding);
    this.publish(binding, "revoked");
  }
  private checked(binding: string, generation: string) {
    const session = this.get(binding);
    if (session.revoked || session.generation !== generation) throw new Error("Stale or revoked binding");
    if (!session.online) throw new Error("Agent is offline");
    return session;
  }
  enqueue(binding: string, generation: string, messageId: string, text: string): Message {
    const session = this.checked(binding, generation);
    if (!session.capabilities.send || ["connecting", "unknown", "error"].includes(session.status)) throw new Error("Session is not ready for input");
    const existing = this.message(binding, messageId);
    if (existing) {
      if (existing.text !== text || existing.role !== "user") throw new Error("Message ID already used for different content");
      return existing;
    }
    const count = this.db.prepare("SELECT count(*) AS n FROM commands WHERE binding=? AND state='queued'").get(binding);
    if (Number(count?.n) >= 100) throw new Error("Queue is full; no messages were discarded");
    const message: Message = { id: messageId, role: "user", text, state: "queued", createdAt: this.nextMessageTime(binding) };
    const command: Command = { type: "send", commandId: randomUUID(), messageId, text };
    this.db.exec("BEGIN IMMEDIATE");
    try { this.saveMessage(binding, message); this.addCommand(binding, command); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.publish(binding, "message"); return message;
  }
  answer(binding: string, generation: string, requestId: string, answer: Extract<Command,{type:"answer"}>["answer"]) {
    const session = this.checked(binding, generation);
    const row = this.db.prepare("SELECT data FROM interactions WHERE binding=? AND id=?").get(binding, requestId);
    if (!row) throw new Error("Unknown interaction");
    const interaction = JSON.parse(String(row.data)) as Interaction;
    if (interaction.state !== "pending" || interaction.expiresAt <= Date.now()) throw new Error("Interaction already answered or expired");
    if (interaction.kind === "approval" ? !session.capabilities.approvals || !answer.decision : !session.capabilities.questions || !answer.answers) throw new Error("Unsupported answer");
    if (answer.answers && interaction.questions?.some(q => !answer.answers?.[q.id]?.length)) throw new Error("Answer every question");
    const command: Command = { type:"answer", commandId:randomUUID(), requestId, answer };
    interaction.state = "submitted"; interaction.commandId = command.commandId;
    this.db.exec("BEGIN IMMEDIATE");
    try { this.saveInteraction(binding, interaction); this.addCommand(binding, command); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.publish(binding, "interaction"); return command.commandId;
  }
  reconcile(binding:string,generation:string,messageId:string) {
    const session=this.checked(binding,generation);
    if(session.inFlight!==messageId || this.message(binding,messageId)?.state!=="unknown") throw new Error("Uncertain message changed; refresh before confirming");
    if(session.runtimeStatus!=="ready") throw new Error("Original Agent must report ready before reconciliation");
    // Explicit user confirmation only releases the queue. Never replay or fabricate the old result.
    session.inFlight=null;session.status="ready";session.detail=undefined;
    this.saveSession(session);this.publish(binding,"reconciled");
  }
  interrupt(binding: string, generation: string) {
    const session = this.checked(binding, generation);
    if (!session.capabilities.interrupt || !["busy", "waiting"].includes(session.status)) throw new Error("No interruptible turn");
    const command: Command = { type: "interrupt", commandId: randomUUID() };
    this.addCommand(binding, command); return command.commandId;
  }
  private addCommand(binding: string, command: Command) { this.db.prepare("INSERT INTO commands VALUES (?,?,?,?,?)").run(command.commandId,binding,JSON.stringify(command),"queued",Date.now()); }
  nextCommand(binding: string): Command | undefined {
    const session = this.get(binding);
    if (!session.online || session.revoked || ["connecting", "error", "offline"].includes(session.status)) return;
    const rows = this.db.prepare("SELECT id,data FROM commands WHERE binding=? AND state='queued' ORDER BY created,rowid").all(binding);
    for (const row of rows) {
      const command = JSON.parse(String(row.data)) as Command;
      if (command.type === "send" && (session.inFlight || session.status !== "ready")) continue;
      if (command.type === "answer") {
        const current = this.db.prepare("SELECT data FROM interactions WHERE binding=? AND id=?").get(binding, command.requestId);
        const interaction = current ? JSON.parse(String(current.data)) as Interaction : undefined;
        if (!interaction || interaction.state !== "submitted" || interaction.expiresAt <= Date.now()) {
          this.db.prepare("UPDATE commands SET state='cancelled' WHERE id=?").run(command.commandId); continue;
        }
      }
      // Persist before writing: a crash leaves an unknown operation, never an automatic replay.
      this.db.prepare("UPDATE commands SET state='dispatched' WHERE id=?").run(command.commandId);
      if (command.type === "send") {
        session.inFlight = command.messageId; session.status = "busy"; this.saveSession(session);
      }
      return command;
    }
  }
  acceptEvent(binding: string, eventId: string, event: AgentEvent): boolean {
    if (this.db.prepare("SELECT 1 FROM receipts WHERE binding=? AND id=?").get(binding,eventId)) return false;
    const session = this.get(binding);
    if (session.revoked) throw new Error("Binding revoked");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.applyEvent(session, event);
      this.db.prepare("INSERT INTO receipts VALUES (?,?)").run(binding,eventId);
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
    this.publish(binding,event.type); return true;
  }
  private applyEvent(session: StoredSession, event: AgentEvent) {
    const binding = session.id;
    if (event.type === "status") {
      session.runtimeStatus=event.status;session.status=event.status;session.detail=event.detail;
      if(event.status==="ready" && session.inFlight) {
        const message=this.message(binding,session.inFlight);
        if(message && !["completed","failed"].includes(message.state)) {
          message.state="unknown";message.detail="Agent reported ready without a correlated completion. Inspect its original session before releasing the queue.";
          this.saveMessage(binding,message);
        }
        session.status="unknown";session.detail="A previous prompt has an uncertain result. Inspect the original Agent, then explicitly resume the queue.";
      }
    }
    if (event.type === "receipt") {
      const row = this.db.prepare("SELECT data FROM commands WHERE id=? AND binding=?").get(event.commandId,binding);
      if (row) {
        const command = JSON.parse(String(row.data)) as Command;
        this.db.prepare("UPDATE commands SET state=? WHERE id=?").run(event.state,event.commandId);
        if (command.type === "send") {
          const message = this.message(binding,command.messageId);
          if (message && !["completed","unknown"].includes(message.state)) { message.state=event.state; message.detail=event.detail; this.saveMessage(binding,message); }
          if (["unknown","failed"].includes(event.state)) session.status=event.state === "unknown" ? "unknown" : "error";
        }
      }
    }
    if (event.type === "message") {
      const old = this.message(binding,event.messageId);
      if (old?.role === "user") throw new Error("Cannot overwrite a user message");
      const message:Message = {id:event.messageId,role:"assistant",text:event.text,state:event.final?"completed":"accepted",createdAt:old?.createdAt ?? this.nextMessageTime(binding),replyTo:event.replyTo,turnId:event.turnId};
      this.saveMessage(binding,message);
    }
    if (event.type === "completed") {
      if (event.messageId) {
        const message = this.message(binding,event.messageId);
        if (message?.role === "user") { message.state=event.error?"failed":"completed"; message.detail=event.error; message.turnId=event.turnId; this.saveMessage(binding,message); }
        if (session.inFlight === event.messageId) { session.inFlight=null; session.status=event.error?"error":"ready"; }
      }
    }
    if (event.type === "interaction") {
      const old = this.db.prepare("SELECT data FROM interactions WHERE binding=? AND id=?").get(binding,event.interaction.requestId);
      // Never reopen a resolved request, even if a connector repeats a notification.
      if (!old) this.saveInteraction(binding,{...event.interaction,state:"pending"});
    }
    if (event.type === "interactionResolved") {
      const row = this.db.prepare("SELECT data FROM interactions WHERE binding=? AND id=?").get(binding,event.requestId);
      if (row) this.saveInteraction(binding,{...JSON.parse(String(row.data)),state:"resolved"});
    }
    session.updatedAt=Date.now(); this.saveSession(session);
  }
  private saveInteraction(binding:string, interaction:Interaction) { this.db.prepare("INSERT OR REPLACE INTO interactions VALUES (?,?,?)").run(binding,interaction.requestId,JSON.stringify(interaction)); }
  private nextMessageTime(binding:string):number { return Math.max(Date.now(),Number(this.db.prepare("SELECT COALESCE(max(created),0)+1 AS next FROM messages WHERE binding=?").get(binding)?.next)); }
  private saveMessage(binding:string,message:Message) { this.db.prepare("INSERT OR REPLACE INTO messages VALUES (?,?,?,?)").run(binding,message.id,JSON.stringify(message),message.createdAt); }
  message(binding:string,id:string):Message|undefined { const row=this.db.prepare("SELECT data FROM messages WHERE binding=? AND id=?").get(binding,id); return row?JSON.parse(String(row.data)) as Message:undefined; }
  snapshot(binding:string,before=Number.MAX_SAFE_INTEGER):Snapshot {
    const session=this.get(binding); if(session.revoked) throw new Error("Binding revoked");
    const rows=this.db.prepare("SELECT data FROM messages WHERE binding=? AND created<? ORDER BY created DESC,rowid DESC LIMIT 201").all(binding,before);
    const messages=rows.slice(0,200).map(r=>JSON.parse(String(r.data)) as Message).reverse();
    const interactions=this.db.prepare("SELECT data FROM interactions WHERE binding=?").all(binding).map(r=>JSON.parse(String(r.data)) as Interaction).map(i=>i.state==="pending"&&i.expiresAt<=Date.now()?{...i,state:"expired" as const}:i);
    return {session:this.publicSession(session),messages,interactions,cursor:this.cursor(),hasMore:rows.length>200};
  }
  cursor():number { return Number(this.db.prepare("SELECT COALESCE(max(cursor),0) as n FROM events").get()?.n); }
  events(after:number):BridgeEvent[] { return this.db.prepare("SELECT cursor,binding AS bindingId,type,created AS createdAt FROM events WHERE cursor>? ORDER BY cursor LIMIT 1001").all(after) as unknown as BridgeEvent[]; }
  private publish(bindingId:string,type:string) {
    const createdAt=Date.now(); const result=this.db.prepare("INSERT INTO events(binding,type,created) VALUES (?,?,?)").run(bindingId,type,createdAt);
    this.onEvent({cursor:Number(result.lastInsertRowid),bindingId,type,createdAt});
  }
  close() { this.db.close(); }
}
