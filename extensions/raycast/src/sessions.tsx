import {
  Action, ActionPanel, Alert, Color, confirmAlert, Detail, Form, Icon, List,
  LocalStorage, openExtensionPreferences, showToast, Toast, useNavigation,
} from "@raycast/api";
import type { LaunchProps } from "@raycast/api";
import { randomUUID } from "node:crypto";
import { Fragment, useEffect, useRef, useState } from "react";
import type { Interaction, Message, Pairing, Session } from "../../../packages/shared/src/protocol.js";
import { Hub, HubError, remotePrompt, safeMarkdown } from "./core.js";
import { errorText, RECENT_KEY, useDraft, useHub } from "./hooks.js";

export type Context = { bindingId?: string; recent?: boolean };
const project = (session: Session) => session.cwd.split(/[\\/]/).filter(Boolean).pop() || session.cwd || "No project";
const title = (session: Session) => `${session.machine} · ${session.adapter === "claude" ? "Claude" : "Codex"} · ${project(session)} · ${session.name}`;
const status = (session: Session) => session.revoked ? "Unbound" : !session.online ? "offline" : session.status;
const statusColor = (session: Session) => !session.online || session.revoked ? Color.SecondaryText
  : session.status === "ready" ? Color.Green : session.status === "error" ? Color.Red : Color.Orange;
const knownOnline = (session: Session) => session.online && !session.revoked && ["ready", "busy", "waiting"].includes(session.status);

function PreferencesAction() {
  return <Action title="Open Argo Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />;
}

function PairRemote({hub}:{hub:Hub}) {
  const [name,setName]=useState("remote-backend");
  const [url,setUrl]=useState("http://127.0.0.1:49123");
  const [pairing,setPairing]=useState<Pairing>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string>();
  const {pop}=useNavigation();
  if(pairing) {
    const prompt=remotePrompt(name.trim(),url.trim(),pairing.code);
    return <Detail navigationTitle="Connect Remote Claude" markdown={`# Give this prompt to your remote Claude\n\nThe SSH tunnel must already forward the remote loopback port to this Mac. GitHub distributes code only.\n\nThis is a handoff, not a background listener: waiting occupies the current Agent turn. Tool approvals remain in its terminal.\n\n**Single-use code expires at ${new Date(pairing.expiresAt).toLocaleTimeString()}.** Copy only to the intended Agent. It grants control of one binding, never all sessions. Closing this view does not cancel the code.\n\n${safeMarkdown(prompt)}`}
      actions={<ActionPanel>
        <Action.CopyToClipboard title="Copy Agent Setup Prompt" content={prompt} concealed />
        <Action title="Cancel Unused Pairing Code" icon={Icon.XMarkCircle} onAction={async()=>{
          try{await hub.cancelPairing(pairing.code);pop();}catch(cause){await showToast({style:Toast.Style.Failure,title:"Could Not Cancel Code",message:errorText(cause)});}
        }} />
      </ActionPanel>} />;
  }
  return <Form navigationTitle="Connect Remote Claude" isLoading={busy} enableDrafts={false} actions={<ActionPanel>
    <Action.SubmitForm title="Create Pairing Prompt" onSubmit={async()=>{
      if(busy)return;
      try {
        if(!name.trim()||name.trim().length>100)throw new Error("Enter a name of 1–100 characters");
        remotePrompt(name.trim(),url.trim(),"ARGO-"+"0".repeat(32));
      }catch{setError("Enter a name of 1–100 characters and a loopback HTTP address without a path.");return;}
      setBusy(true);setError(undefined);
      try{setPairing(await hub.createPairing(name.trim()));}catch(cause){setError(errorText(cause));}finally{setBusy(false);}
    }} />
  </ActionPanel>}>
    <Form.Description text="Your remote Agent downloads Argo from GitHub and exchanges a single-use code. No files or admin credentials need copying. Prepare your SSH reverse tunnel first." />
    <Form.TextField id="name" title="Session Name" value={name} onChange={setName} />
    <Form.TextField id="url" title="Remote Loopback URL" value={url} onChange={setUrl} />
    {error?<Form.Description title="Cannot Pair" text={error}/>:null}
  </Form>;
}

function SessionList() {
  const feed = useHub();
  const { push } = useNavigation();
  async function open(session: Session) {
    push(<Conversation bindingId={session.id} />);
  }
  const pairAction=feed.hub.current && feed.connection==="live" ? <Action.Push title="Connect Remote Claude" icon={Icon.Plus} shortcut={{modifiers:["cmd"],key:"n"}} target={<PairRemote hub={feed.hub.current} />} /> : null;
  const actions = <ActionPanel>
    {pairAction}
    <Action title="Refresh Sessions" icon={Icon.ArrowClockwise} onAction={feed.reconnect} />
    <PreferencesAction />
  </ActionPanel>;
  return <List isLoading={feed.loading} navigationTitle={`Argo · ${feed.connection}`} searchBarPlaceholder="Find a machine, agent, or project" actions={actions}>
    <List.EmptyView title={feed.error ? "Hub unavailable" : "No bound sessions"}
      description={feed.error || "Choose Connect Remote Claude to create a setup prompt, or bind a local session with Argo."} icon={Icon.Terminal} />
    {feed.error && feed.sessions.length > 0 ? <List.Item title="Hub unavailable — cached sessions" subtitle={feed.error} icon={Icon.Warning} actions={actions} /> : null}
    {feed.sessions.map((session) => <List.Item key={session.id} id={session.id} title={title(session)}
      subtitle={session.cwd} keywords={[session.machine, session.adapter, session.name, session.cwd]}
      icon={{ source: Icon.Terminal, tintColor: statusColor(session) }}
      accessories={[{ tag: { value: status(session), color: statusColor(session) } }]}
      actions={<ActionPanel>
        <Action title="Open Conversation" icon={Icon.Message} onAction={() => open(session)} />
        {pairAction}
        <Action title="Refresh Sessions" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={feed.reconnect} />
        <PreferencesAction />
      </ActionPanel>} />)}
  </List>;
}

function Compose({ text, change, send }: { text: string; change: (text: string) => void; send: (text: string) => Promise<boolean> }) {
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const { pop } = useNavigation();
  return <Form navigationTitle="Compose Message" isLoading={busy} enableDrafts={false} actions={<ActionPanel>
    <Action.SubmitForm title="Send Message" icon={Icon.ArrowUp} onSubmit={async () => {
      if (busy) return;
      setBusy(true);
      try { if (await send(value)) pop(); } finally { setBusy(false); }
    }} />
  </ActionPanel>}>
    <Form.Description text="Explicitly send this message to the bound terminal agent. Sending does not mean the agent has completed it." />
    <Form.TextArea id="text" title="Message" value={value} onChange={(next) => { setValue(next); change(next); }}
      error={value.length > 100_000 ? "Maximum 100,000 characters" : undefined} autoFocus />
  </Form>;
}

type Respond = (request: Interaction, answer: { decision: "allow" | "deny" } | { answers: Record<string, string[]> }) => Promise<boolean>;

function Approval({ request, respond }: { request: Interaction; respond: Respond }) {
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const pending = request.state === "pending" && request.expiresAt > Date.now();
  async function decide(decision: "allow" | "deny") {
    if (busy || !pending) return;
    if (decision === "allow" && !await confirmAlert({
      title: "Allow this agent request?",
      message: `${request.title}\n\n${request.detail.slice(0, 2400)}${request.detail.length > 2400 ? "\n… Review the full preview first." : ""}`,
      primaryAction: { title: "Allow Request", style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "Cancel" },
    })) return;
    setBusy(true);
    try { if (await respond(request, { decision })) pop(); } finally { setBusy(false); }
  }
  return <Detail navigationTitle="Review Approval" isLoading={busy}
    markdown={`# ${safeMarkdown(request.title)}\n\n**${pending ? "Pending approval — review all parameters before allowing." : "This request is no longer pending."}**\n\n${safeMarkdown(request.detail)}\n\nExpires: ${new Date(request.expiresAt).toLocaleString()}`}
    actions={<ActionPanel>{pending ? <>
      <Action title="Deny Request" icon={Icon.XMarkCircle} onAction={() => decide("deny")} />
      <Action title="Allow Request…" icon={Icon.Checkmark} style={Action.Style.Destructive} onAction={() => decide("allow")} />
    </> : null}</ActionPanel>} />;
}

function Questions({ request, respond }: { request: Interaction; respond: Respond }) {
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const questions = request.questions || [];
  return <Form navigationTitle="Answer Agent Questions" isLoading={busy} enableDrafts={false} actions={<ActionPanel>
    <Action.SubmitForm title="Submit Answers" icon={Icon.ArrowUp} onSubmit={async (values: Record<string, string[] | string>) => {
      if (busy) return;
      if (request.state !== "pending" || request.expiresAt <= Date.now()) { setError("This request has expired. Refresh the conversation."); return; }
      const answers: Record<string, string[]> = Object.create(null);
      for (const [index, question] of questions.entries()) {
        const selected = values[`options-${index}`];
        const custom = values[`custom-${index}`];
        answers[question.id] = [...(Array.isArray(selected) ? selected : []), ...(typeof custom === "string" && custom.trim() ? [custom.trim()] : [])];
        if (!answers[question.id]!.length) { setError("Answer every question before submitting."); return; }
        if (answers[question.id]!.length > 50 || answers[question.id]!.some((answer) => answer.length > 10_000)) { setError("Maximum 50 answers per question and 10,000 characters per answer."); return; }
      }
      if (!questions.length) { setError("No questions were provided. Refresh the conversation."); return; }
      setBusy(true);
      try { if (await respond(request, { answers })) pop(); } finally { setBusy(false); }
    }} />
  </ActionPanel>}>
    <Form.Description title={request.title} text={request.detail || "Select options and/or enter your own answer for each question."} />
    {error ? <Form.Description title="Cannot Submit" text={error} /> : null}
    {questions.map((question, index) => <Fragment key={question.id}>
      <Form.Description text={question.question} />
      {question.options.length ? <Form.TagPicker id={`options-${index}`} title="Select Answers">
        {question.options.map((option, optionIndex) => <Form.TagPicker.Item key={optionIndex} value={option} title={option} />)}
      </Form.TagPicker> : null}
      <Form.TextArea id={`custom-${index}`} title="Your Answer" placeholder="Optional when options are selected" />
    </Fragment>)}
  </Form>;
}

type ConversationSelection = { generation?: string; selectedItemId?: string; replyTo?: string };
type SelectionEvent = { type: "snapshot"; generation: string; messages: readonly Message[] }
  | { type: "send"; messageId: string }
  | { type: "select"; id: string | null };

export function conversationSelection(state: ConversationSelection, event: SelectionEvent): ConversationSelection {
  if (event.type === "send") return { ...state, replyTo: event.messageId };
  if (event.type === "select") {
    // Loading defaults and callbacks acknowledging our own selection aren't user navigation.
    if (!state.generation || event.id === null || event.id === state.selectedItemId) return state;
    return { ...state, selectedItemId: event.id, replyTo: undefined };
  }
  const initial = state.generation !== event.generation;
  const candidates = event.messages.filter((message) => message.role === "assistant"
    && (initial || Boolean(state.replyTo && message.replyTo === state.replyTo)));
  const latest = (messages: readonly Message[]) => messages.reduce<Message | undefined>((newest, message) =>
    !newest || message.createdAt > newest.createdAt ? message : newest, undefined);
  const selectedItemId = latest(candidates)?.id ?? (initial ? latest(event.messages)?.id ?? "status" : state.selectedItemId);
  if (initial) return { generation: event.generation, selectedItemId };
  return selectedItemId === state.selectedItemId ? state : { ...state, selectedItemId };
}

function Conversation({ bindingId }: { bindingId: string }) {
  const feed = useHub(bindingId);
  const draft = useDraft(bindingId);
  const [busy, setBusy] = useState(false);
  const [detached, setDetached] = useState(false);
  const lock = useRef(false);
  const sendAttempt = useRef<{ id: string; text: string; generation: string } | undefined>(undefined);
  const [older, setOlder] = useState<Message[]>([]);
  const [more, setMore] = useState<boolean>();
  const [selection, setSelection] = useState<ConversationSelection>({});
  const snapshot = feed.snapshot;
  const session = snapshot?.session;
  const generation = session?.generation;
  const currentSelection = snapshot ? conversationSelection(selection, {
    type: "snapshot", generation: snapshot.session.generation, messages: snapshot.messages,
  }) : selection;
  // Resolve before rendering List so its first selected item isn't the status row.
  if (currentSelection !== selection) setSelection(currentSelection);
  useEffect(() => { setOlder([]); setMore(undefined); sendAttempt.current = undefined; }, [generation]);
  useEffect(() => {
    void LocalStorage.setItem(RECENT_KEY, bindingId).catch(() => showToast({ style: Toast.Style.Failure, title: "Could not save the recent binding" }));
  }, [bindingId]);

  async function run(operation: () => Promise<void>, success: string): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    try {
      await operation();
      await showToast({ style: Toast.Style.Success, title: success, message: "Submitted to the hub; agent completion is reported separately." });
      await feed.refresh();
      return true;
    } catch (cause) {
      await showToast({ style: Toast.Style.Failure, title: cause instanceof HubError ? "Request rejected" : "Delivery unknown",
        message: cause instanceof HubError ? cause.message : "Refresh before retrying. A retry of the same message uses its original ID." });
      await feed.refresh();
      return false;
    } finally { lock.current = false; setBusy(false); }
  }
  async function send(text: string): Promise<boolean> {
    if (!session || !feed.hub.current || !knownOnline(session) || feed.connection !== "live" || !session.capabilities.send) return false;
    if (!text.trim() || text.length > 100_000) {
      await showToast({ style: Toast.Style.Failure, title: "Enter a message of 1–100,000 characters" });
      return false;
    }
    if (sendAttempt.current?.text !== text || sendAttempt.current.generation !== session.generation) {
      sendAttempt.current = { id: randomUUID(), text, generation: session.generation };
    }
    const attempt = sendAttempt.current;
    const sent = await run(() => {
      // Arm before I/O: a reply can arrive through the subscription before POST resolves.
      setSelection((previous) => conversationSelection(previous, { type: "send", messageId: attempt.id }));
      return feed.hub.current!.mutate(bindingId, "/messages", {
        messageId: attempt.id, generation: attempt.generation, text,
      });
    }, "Message submitted");
    if (sent) { draft.clearIf(text); sendAttempt.current = undefined; }
    return sent;
  }
  const respond: Respond = async (request, answer) => {
    if (!session || !feed.hub.current) return false;
    // Re-read before approval/question submission; a Detail/Form may have remained open across a rebind.
    return run(async () => {
      const current = await feed.hub.current!.snapshot(bindingId);
      const fresh = current.interactions.find((item) => item.requestId === request.requestId);
      if (current.session.generation !== session.generation || !knownOnline(current.session)
        || !fresh || fresh.state !== "pending" || fresh.expiresAt <= Date.now()
        || fresh.kind !== request.kind || fresh.title !== request.title || fresh.detail !== request.detail
        || JSON.stringify(fresh.questions) !== JSON.stringify(request.questions)) throw new HubError(409);
      await feed.hub.current!.mutate(bindingId, `/interactions/${encodeURIComponent(request.requestId)}`, {
        generation: session.generation, ...answer,
      });
    }, "Response submitted");
  };

  const canAct = Boolean(!detached && session && knownOnline(session) && feed.connection === "live" && !feed.error && !busy);
  const canSend = canAct && session?.capabilities.send && draft.ready;
  const allMessages = [...new Map([...older, ...(snapshot?.messages || [])].map((message) => [message.id, message])).values()]
    .sort((a, b) => b.createdAt - a.createdAt);
  async function loadOlder() {
    if (!feed.hub.current || lock.current || !allMessages.length) return;
    lock.current = true;
    setBusy(true);
    try {
      const page = await feed.hub.current.snapshot(bindingId, Math.min(...allMessages.map((message) => message.createdAt)));
      if (page.session.generation !== generation) { setOlder([]); await feed.refresh(); return; }
      setOlder((previous) => [...new Map([...previous, ...page.messages].map((message) => [message.id, message])).values()]);
      setMore(page.hasMore);
    } catch (cause) { await showToast({ style: Toast.Style.Failure, title: "Could not load older messages", message: errorText(cause) }); }
    finally { lock.current = false; setBusy(false); }
  }
  async function detach() {
    if (!session || !feed.hub.current || !await confirmAlert({
      title: "Unbind this terminal session?", message: `${title(session)}\nThis revokes the binding, not the terminal agent itself.`,
      primaryAction: { title: "Unbind Session", style: Alert.ActionStyle.Destructive }, dismissAction: { title: "Cancel" },
    })) return;
    if (await run(() => feed.hub.current!.mutate(bindingId, "", undefined, "DELETE"), "Session unbound")) {
      setDetached(true);
      draft.change("");
      try {
        if (await LocalStorage.getItem<string>(RECENT_KEY) === bindingId) await LocalStorage.removeItem(RECENT_KEY);
      } catch { await showToast({ style: Toast.Style.Failure, title: "Unbound, but could not clear the recent binding" }); }
    }
  }
  function commonActions() {
    return <>
      {canSend ? <>
        <Action title="Send Message" icon={Icon.ArrowUp} onAction={() => send(draft.text)} />
        <Action.Push title="Compose Multiline Message" icon={Icon.Pencil} shortcut={{ modifiers: ["cmd"], key: "n" }} target={<Compose text={draft.text} change={draft.change} send={send} />} />
      </> : null}
      {session?.online && session.uncertainMessageId && feed.connection==="live" && !busy ? <Action title="Resume Queue After Checking Agent…" icon={Icon.Play} onAction={async()=>{
        if(await confirmAlert({title:"Have you checked the original Agent?",message:"Confirm the Agent is idle and inspect the uncertain prompt's result. This releases queued prompts without replaying or completing the uncertain one.",primaryAction:{title:"I Checked, Resume Queue",style:Alert.ActionStyle.Destructive}})) {
          await run(()=>feed.hub.current!.mutate(bindingId,"/reconcile",{generation:session.generation,messageId:session.uncertainMessageId}),"Queue resumed");
        }
      }} /> : null}
      <Action title="Refresh Conversation" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={feed.reconnect} />
      <Action.Push title="All Sessions" icon={Icon.List} target={<SessionList />} />
      {canAct && session?.capabilities.interrupt ? <Action title="Interrupt Agent…" icon={Icon.Stop} onAction={async () => {
        if (await confirmAlert({ title: "Interrupt this agent?", message: title(session), primaryAction: { title: "Interrupt", style: Alert.ActionStyle.Destructive } })) {
          await run(() => feed.hub.current!.mutate(bindingId, "/interrupt", { generation: session.generation }), "Interrupt submitted");
        }
      }} /> : null}
      {session && !session.revoked && !detached && !busy ? <Action title="Unbind Session…" style={Action.Style.Destructive} icon={Icon.Trash} onAction={detach} /> : null}
      <PreferencesAction />
    </>;
  }
  const stateText = detached ? "Unbound" : session ? `${status(session)} · Hub ${feed.connection}` : `Hub ${feed.connection}`;
  return <List navigationTitle={session ? title(session) : "Argo Conversation"} isLoading={feed.loading || busy}
    selectedItemId={currentSelection.selectedItemId}
    onSelectionChange={(id) => setSelection((previous) => conversationSelection(previous, { type: "select", id }))}
    filtering={false} isShowingDetail searchText={draft.text} onSearchTextChange={(text) => { if (draft.ready) draft.change(text); }}
    searchBarPlaceholder={canSend ? "Type a short message, then choose Send Message" : "Draft only — sending unavailable until the agent is ready"}
    actions={<ActionPanel>{commonActions()}</ActionPanel>}>
    <List.Item id="status" title={stateText} icon={{ source: feed.error ? Icon.Warning : Icon.Info, tintColor: session ? statusColor(session) : Color.SecondaryText }}
      detail={<List.Item.Detail markdown={`# ${safeMarkdown(stateText)}\n\n${safeMarkdown(feed.error || session?.detail || "Select a message or request to inspect it. Sending is always an explicit action.")}\n\n${session ? safeMarkdown(`${session.machine} · ${session.adapter}\n\n${session.cwd}`) : ""}\n\nImages and links in agent content are inert. Local drafts are stored only on this Mac.`} />}
      actions={<ActionPanel>{commonActions()}</ActionPanel>} />
    {(snapshot?.interactions || []).map((request) => {
      const pending = request.state === "pending" && request.expiresAt > Date.now();
      const supported = request.kind === "approval" ? session?.capabilities.approvals : session?.capabilities.questions;
      return <List.Item key={request.requestId} id={`request:${request.requestId}`}
        title={`${request.kind === "approval" ? "Approval" : "Question"}: ${request.title}`}
        subtitle={pending ? "Pending" : request.state === "pending" ? "expired" : request.state}
        icon={request.kind === "approval" ? Icon.Shield : Icon.QuestionMarkCircle}
        detail={<List.Item.Detail markdown={`# ${safeMarkdown(request.title)}\n\n${safeMarkdown(request.detail)}\n\nState: ${pending ? "pending" : request.state === "pending" ? "expired" : request.state}`} />}
        actions={<ActionPanel>
          {canAct && pending && supported ? <Action.Push title={request.kind === "approval" ? "Review Approval" : "Answer Questions"}
            target={request.kind === "approval" ? <Approval request={request} respond={respond} /> : <Questions request={request} respond={respond} />} /> : null}
          {commonActions()}
        </ActionPanel>} />;
    })}
    {allMessages.map((message) => <List.Item key={message.id} id={message.id}
      title={`${message.role === "user" ? "You" : "Agent"} · ${message.state}`} subtitle={message.text.replace(/\s+/g, " ").slice(0, 140)}
      icon={message.role === "user" ? Icon.Person : Icon.Terminal}
      detail={<List.Item.Detail markdown={`${safeMarkdown(message.text)}\n\n---\n\n**${message.state}** · ${new Date(message.createdAt).toLocaleString()}${message.detail ? `\n\n${safeMarkdown(message.detail)}` : ""}`} />}
      actions={<ActionPanel>{commonActions()}</ActionPanel>} />)}
    {(more ?? snapshot?.hasMore) && allMessages.length ? <List.Item id="older" title="Load Earlier Messages" icon={Icon.Clock}
      detail={<List.Item.Detail markdown="The hub returns the latest 200 messages by default. Load an earlier page explicitly." />}
      actions={<ActionPanel><Action title="Load Earlier Messages" icon={Icon.Clock} onAction={loadOlder} />{commonActions()}</ActionPanel>} /> : null}
  </List>;
}

export function SessionCommand({ bindingId, recent }: Context) {
  const [target, setTarget] = useState<string | undefined>(bindingId);
  const [loading, setLoading] = useState(Boolean(recent && !bindingId));
  useEffect(() => {
    if (!recent || bindingId) return;
    let active = true;
    void LocalStorage.getItem<string>(RECENT_KEY).then((value) => { if (active) setTarget(value || undefined); })
      .catch(() => showToast({ style: Toast.Style.Failure, title: "Could not read the recent binding" }))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bindingId, recent]);
  if (loading) return <List isLoading navigationTitle="Argo · Recent Session" />;
  return target ? <Conversation key={target} bindingId={target} /> : <SessionList />;
}

export default function Sessions(props: LaunchProps<{ launchContext: Context }>) {
  return <SessionCommand {...props.launchContext} />;
}
