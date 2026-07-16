import { randomBytes } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const DAY_MS = 24 * 60 * 60 * 1000;
const WIDGET_TTL_MS = 7 * DAY_MS;
const SESSION_TTL_MS = 15 * 60 * 1000;
const DOC_TOKEN_TTL_MS = 60 * 1000;
const PENDING_LAUNCH_TTL_MS = 2 * 60 * 1000;

type DiscordActivityWidget = {
  html: string;
  title: string;
  channelId: string;
  accountId: string;
  createdAt: number;
};

type DiscordActivitySession = {
  discordUserId: string;
  accountId: string;
};

type DiscordActivityDocToken = {
  widgetId: string;
  accountId: string;
};

type DiscordActivityPendingLaunch =
  | { state: "single"; widgetId: string; createdAt: number }
  | { state: "ambiguous"; createdAt: number };

type DiscordActivityStores = {
  widgets: PluginStateKeyedStore<DiscordActivityWidget>;
  sessions: PluginStateKeyedStore<DiscordActivitySession>;
  docTokens: PluginStateKeyedStore<DiscordActivityDocToken>;
  launches: PluginStateKeyedStore<DiscordActivityPendingLaunch>;
};

type OpenKeyedStore = <T>(options: {
  namespace: string;
  maxEntries: number;
  overflowPolicy: "evict-oldest";
  defaultTtlMs: number;
}) => PluginStateKeyedStore<T>;

export function openDiscordActivityStores(openKeyedStore: OpenKeyedStore): DiscordActivityStores {
  return {
    widgets: openKeyedStore<DiscordActivityWidget>({
      namespace: "activities-widgets",
      maxEntries: 64,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: WIDGET_TTL_MS,
    }),
    sessions: openKeyedStore<DiscordActivitySession>({
      namespace: "activities-sessions",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: SESSION_TTL_MS,
    }),
    docTokens: openKeyedStore<DiscordActivityDocToken>({
      namespace: "activities-doc-tokens",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: DOC_TOKEN_TTL_MS,
    }),
    launches: openKeyedStore<DiscordActivityPendingLaunch>({
      namespace: "activities-launches",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: PENDING_LAUNCH_TTL_MS,
    }),
  };
}

function pendingLaunchKey(accountId: string, channelId: string, discordUserId: string): string {
  return `${accountId}:${channelId}:${discordUserId}`;
}

export class DiscordActivityStore {
  private lastWidgetCreatedAt = 0;

  constructor(private readonly stores: DiscordActivityStores) {}

  async createWidget(value: DiscordActivityWidget): Promise<string> {
    const id = randomBytes(16).toString("base64url");
    const createdAt = Math.max(value.createdAt, this.lastWidgetCreatedAt + 1);
    this.lastWidgetCreatedAt = createdAt;
    await this.stores.widgets.register(id, { ...value, createdAt });
    return id;
  }

  async deleteWidget(id: string): Promise<void> {
    await this.stores.widgets.delete(id);
  }

  async lookupWidget(id: string): Promise<DiscordActivityWidget | undefined> {
    return await this.stores.widgets.lookup(id);
  }

  async singleWidgetForChannel(
    accountId: string,
    channelId: string,
  ): Promise<{
    id: string;
    widget: DiscordActivityWidget;
  } | null> {
    const entries = await this.stores.widgets.entries();
    let match: (typeof entries)[number] | undefined;
    for (const entry of entries) {
      if (entry.value.accountId !== accountId || entry.value.channelId !== channelId) {
        continue;
      }
      if (match) {
        return null;
      }
      match = entry;
    }
    return match ? { id: match.key, widget: match.value } : null;
  }

  async createSession(value: DiscordActivitySession): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.stores.sessions.register(token, value);
    return token;
  }

  async lookupSession(token: string): Promise<DiscordActivitySession | undefined> {
    return await this.stores.sessions.lookup(token);
  }

  async createDocToken(value: DiscordActivityDocToken): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.stores.docTokens.register(token, value);
    return token;
  }

  async consumeDocToken(token: string): Promise<DiscordActivityDocToken | undefined> {
    return await this.stores.docTokens.consume(token);
  }

  async recordPendingLaunch(params: {
    accountId: string;
    channelId: string;
    discordUserId: string;
    widgetId: string;
    createdAt: number;
  }): Promise<void> {
    const key = pendingLaunchKey(params.accountId, params.channelId, params.discordUserId);
    // Overlapping clicks on different widgets are ambiguous: which Activity queries first is
    // unordered, so a single slot could hand widget B's record to widget A's shell. Poison the
    // slot instead; consume then fails closed and both launches fall to the single-widget rung.
    const existing = await this.stores.launches.lookup(key);
    const overlapsDifferentWidget =
      existing && (existing.state === "ambiguous" || existing.widgetId !== params.widgetId);
    await this.stores.launches.register(
      key,
      overlapsDifferentWidget
        ? { state: "ambiguous", createdAt: params.createdAt }
        : { state: "single", widgetId: params.widgetId, createdAt: params.createdAt },
    );
  }

  async consumePendingLaunch(
    accountId: string,
    channelId: string,
    discordUserId: string,
  ): Promise<Extract<DiscordActivityPendingLaunch, { state: "single" }> | undefined> {
    const launch = await this.stores.launches.consume(
      pendingLaunchKey(accountId, channelId, discordUserId),
    );
    return launch?.state === "single" ? launch : undefined;
  }
}
