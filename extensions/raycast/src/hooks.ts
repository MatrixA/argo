import { getPreferenceValues, LocalStorage, showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session, Snapshot } from "../../../packages/shared/src/protocol.js";
import { Hub, HubError, readConfig } from "./core.js";
import type { Connection } from "./core.js";

export const RECENT_KEY = "recent-binding";
export const draftKey = (bindingId: string) => `draft:${bindingId}`;
export const errorText = (error: unknown) => error instanceof HubError ? error.message : "Cannot reach the local hub. Check Argo, the configuration path, and private file permissions (chmod 600).";

export function useHub(bindingId?: string) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const hub = useRef<Hub | undefined>(undefined);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [attempt, setAttempt] = useState(0);
  const { configPath } = getPreferenceValues<{ configPath?: string }>();

  useEffect(() => {
    const controller = new AbortController();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let client: Hub | undefined;
    let pending: Promise<number> | undefined;
    let again = false;
    let lastCursor = 0;
    setLoading(true);
    setConnection("connecting");
    setError(undefined);
    async function load(): Promise<number> {
      if (pending) { again = true; return pending; }
      pending = (async () => {
        do {
          again = false;
          if (!client || controller.signal.aborted) return lastCursor;
          if (bindingId) {
            const next = await client.snapshot(bindingId);
            if (controller.signal.aborted) return lastCursor;
            lastCursor = next.cursor;
            setSnapshot(next);
          } else {
            const next = await client.sessions();
            if (controller.signal.aborted) return lastCursor;
            lastCursor = next.cursor;
            setSessions(next.sessions);
          }
          setError(undefined);
        } while (again && !controller.signal.aborted);
        return lastCursor;
      })();
      try { return await pending; } finally { pending = undefined; }
    }
    const refresh = async () => {
      try { await load(); }
      catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    refreshRef.current = refresh;
    async function start() {
      try {
        const config = await readConfig(configPath);
        if (controller.signal.aborted) return;
        client = new Hub(config);
        hub.current = client;
        // The subscription starts at the snapshot's cursor, closing the fetch/subscribe race.
        const cursor = await load();
        if (controller.signal.aborted) return;
        setLoading(false);
        await client.watch(cursor, controller.signal, (event) => {
          if (bindingId && event.bindingId !== bindingId) return;
          if (debounce) return;
          debounce = setTimeout(() => { debounce = undefined; void refresh(); }, 200);
        }, load, (value) => { if (!controller.signal.aborted) setConnection(value); });
      } catch (cause) {
        if (!controller.signal.aborted) { setError(errorText(cause)); setConnection("offline"); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void start();
    return () => {
      controller.abort();
      client?.close();
      if (debounce) clearTimeout(debounce);
      hub.current = undefined;
    };
  }, [bindingId, configPath, attempt]);

  const refresh = useCallback(async () => { await refreshRef.current(); }, []);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  return { sessions, snapshot, connection, loading, error, hub, refresh, reconnect };
}

export function useDraft(bindingId: string) {
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef("");
  useEffect(() => {
    let active = true;
    setReady(false);
    void LocalStorage.getItem<string>(draftKey(bindingId)).then((value) => {
      if (active) { current.current = value || ""; setText(current.current); setReady(true); }
    }).catch(() => {
      if (active) {
        setReady(true);
        void showToast({ style: Toast.Style.Failure, title: "Could not restore the local draft" });
      }
    });
    return () => { active = false; };
  }, [bindingId]);
  const change = (value: string) => {
    current.current = value;
    setText(value);
    writes.current = writes.current.then(() => value
      ? LocalStorage.setItem(draftKey(bindingId), value)
      : LocalStorage.removeItem(draftKey(bindingId)))
      .catch(() => showToast({ style: Toast.Style.Failure, title: "Could not save the local draft" }));
  };
  const clearIf = (sent: string) => { if (current.current === sent) change(""); };
  return { text, change, clearIf, ready };
}
