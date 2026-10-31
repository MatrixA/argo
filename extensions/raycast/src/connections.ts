import { createHash, randomUUID } from "node:crypto";
import { Hub, parseConfig, readConfig, type ClientConfig } from "./core.js";
import { localUrl } from "../../../packages/shared/src/protocol.js";
export const CONNECTIONS_KEY = "bridge-connections-v1";
export const ACTIVE_CONNECTION_KEY = "active-bridge-v1";
const listeners = new Set<() => void>();
export function onConnectionChange(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function connectionChanged() { for (const listener of listeners)
    listener(); }
export interface BridgeProfile {
    id: string;
    name: string;
    configPath: string;
    url?: string;
}
export interface SettingsStorage {
    getItem<T extends string>(key: string): Promise<T | undefined>;
    setItem(key: string, value: string): Promise<unknown>;
    removeItem(key: string): Promise<unknown>;
}
export function connectionIdentity(config: ClientConfig): string {
    return createHash("sha256").update(config.url + "\0" + config.token).digest("hex").slice(0, 24);
}
export const recentKey = (identity: string) => `recent-binding:${identity}`;
export function parseProfiles(raw: string | undefined): BridgeProfile[] {
    if (!raw)
        return [];
    try {
        const value = JSON.parse(raw);
        if (!Array.isArray(value) || value.length > 30)
            throw new Error();
        const seen = new Set<string>();
        return value.map(item => {
            if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || seen.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || typeof item.configPath !== "string" || !item.configPath.trim() || item.configPath.length > 4096 || item.url !== undefined && typeof item.url !== "string")
                throw new Error();
            seen.add(item.id);
            if (item.url)
                localUrl(item.url);
            return { id: item.id, name: item.name, configPath: item.configPath, ...(item.url ? { url: item.url } : {}) };
        });
    }
    catch {
        throw new Error("Saved bridge settings are invalid. Reset saved connections to use the default configuration.");
    }
}
export async function profiles(storage: SettingsStorage) { return parseProfiles(await storage.getItem(CONNECTIONS_KEY)); }
export async function loadConnection(storage: SettingsStorage, preferencePath?: string) {
    const entries = await profiles(storage), active = await storage.getItem(ACTIVE_CONNECTION_KEY);
    const profile = entries.find(item => item.id === active) ?? { id: "default", name: "Default bridge", configPath: preferencePath?.trim() || "~/.argo/client.json" };
    const original = await readConfig(profile.configPath);
    const config = parseConfig({ ...original, ...(profile.url ? { url: profile.url } : {}) });
    return { config, profile, connectionKey: connectionIdentity(config) };
}
export async function saveProfile(storage: SettingsStorage, input: Omit<BridgeProfile, "id">) {
    const name = input.name.trim(), configPath = input.configPath.trim(), url = input.url?.trim();
    if (!name || name.length > 100 || !configPath || configPath.length > 4096)
        throw new Error("Enter a connection name and private configuration file path.");
    const config = parseConfig({ ...await readConfig(configPath), ...(url ? { url: localUrl(url).origin } : {}) });
    const hub = new Hub(config);
    try {
        await hub.sessions();
    }
    finally {
        hub.close();
    }
    const previous = await profiles(storage);
    if (previous.length >= 30)
        throw new Error("Remove an unused connection before adding another.");
    const profile: BridgeProfile = { id: randomUUID(), name, configPath, ...(url ? { url: config.url } : {}) };
    // Store references only. Secrets remain in the user's private file.
    await storage.setItem(CONNECTIONS_KEY, JSON.stringify([...previous, profile]));
    await storage.setItem(ACTIVE_CONNECTION_KEY, profile.id);
    connectionChanged();
    return profile;
}
export async function activateProfile(storage: SettingsStorage, id: string, preferencePath?: string) {
    const entry = (await profiles(storage)).find(item => item.id === id);
    if (id !== "default" && !entry)
        throw new Error("This connection was removed. Refresh before selecting it.");
    const original = await readConfig(entry?.configPath ?? preferencePath);
    const hub = new Hub(parseConfig({ ...original, ...(entry?.url ? { url: entry.url } : {}) }));
    try {
        await hub.sessions();
    }
    finally {
        hub.close();
    }
    if (id === "default")
        await storage.removeItem(ACTIVE_CONNECTION_KEY);
    else
        await storage.setItem(ACTIVE_CONNECTION_KEY, id);
    connectionChanged();
}
export async function removeProfile(storage: SettingsStorage, id: string) {
    const entries = await profiles(storage);
    await storage.setItem(CONNECTIONS_KEY, JSON.stringify(entries.filter(item => item.id !== id)));
    if (await storage.getItem(ACTIVE_CONNECTION_KEY) === id) {
        await storage.removeItem(ACTIVE_CONNECTION_KEY);
        connectionChanged();
    }
}
