import { logError } from "openclaw/plugin-sdk/logging-core";
import {
  buildDiscordActivityCustomId,
  parseDiscordActivityCustomIdForInteraction,
} from "../component-custom-id.js";
import type { ButtonInteraction, ComponentData } from "../internal/discord.js";
import { Button } from "../internal/discord.js";
import { resolveAuthorizedComponentInteraction } from "../monitor/agent-components-auth.js";
import { replySilently } from "../monitor/agent-components-reply.js";
import type { AgentComponentContext } from "../monitor/agent-components.types.js";
import { getDiscordActivitiesRuntime } from "./runtime.js";

const REGISTRATION_WIDGET_ID = "AAAAAAAAAAAAAAAAAAAAAA";

class DiscordActivityButton extends Button {
  label = "Open widget";
  customId = buildDiscordActivityCustomId(REGISTRATION_WIDGET_ID);
  override customIdParser = parseDiscordActivityCustomIdForInteraction;

  constructor(
    private readonly ctx: AgentComponentContext,
    private readonly deps: {
      authorize: typeof resolveAuthorizedComponentInteraction;
      reply: typeof replySilently;
      logError: (message: string) => void;
    },
  ) {
    super();
  }

  private pendingLaunchFailureLogged = false;

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    if (typeof data.widgetId !== "string") {
      await this.deps.reply(interaction, {
        content: "This widget is no longer valid.",
        ephemeral: true,
      });
      return;
    }
    const authorized = await this.deps.authorize({
      ctx: this.ctx,
      interaction,
      label: "discord activity",
      componentLabel: "widget button",
      unauthorizedReply: "not allowed",
      defer: false,
    });
    if (!authorized) {
      return;
    }
    if (!authorized.commandAuthorized) {
      await this.deps.reply(interaction, { content: "not allowed", ephemeral: true });
      return;
    }
    const runtime = getDiscordActivitiesRuntime();
    const channelId = interaction.rawData.channel_id;
    const discordUserId = interaction.userId;
    try {
      if (!runtime || !channelId || !discordUserId) {
        throw new Error("missing activity runtime or interaction identity");
      }
      await runtime.store.recordPendingLaunch({
        channelId,
        discordUserId,
        widgetId: data.widgetId,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (!this.pendingLaunchFailureLogged) {
        this.pendingLaunchFailureLogged = true;
        this.deps.logError(`discord activity: failed to record pending launch: ${String(error)}`);
      }
    }
    await interaction.launchActivity();
  }
}

export function createDiscordActivityButton(
  ctx: AgentComponentContext,
  applicationId?: string,
  deps: {
    authorize?: typeof resolveAuthorizedComponentInteraction;
    reply?: typeof replySilently;
    logError?: (message: string) => void;
  } = {},
): DiscordActivityButton | null {
  const runtime = getDiscordActivitiesRuntime();
  if (!runtime || !runtime.isAccountEnabled(ctx.accountId, ctx.cfg)) {
    return null;
  }
  if (applicationId) {
    runtime.registerApplicationId(ctx.accountId, applicationId);
  }
  if (!runtime.resolveAccount(ctx.accountId, ctx.cfg)) {
    return null;
  }
  return new DiscordActivityButton(ctx, {
    authorize: deps.authorize ?? resolveAuthorizedComponentInteraction,
    reply: deps.reply ?? replySilently,
    logError: deps.logError ?? logError,
  });
}
