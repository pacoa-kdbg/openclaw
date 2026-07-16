// QA Lab Codex auth product proof exercises doctor, SQLite, Gateway, and app-server together.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../../../../src/agents/auth-profiles/persisted.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { postJson } from "../../../helpers/gateway-e2e-harness.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

const OAUTH_PROFILE_ID = "openai:qa-oauth";
const LEGACY_OAUTH_PROFILE_ID = "openai-codex:qa-oauth";
const API_KEY_PROFILE_ID = "openai:media-api";
const oauthAccess = "test-oauth-access";
const ACCOUNT_ID = "qa-codex-account";
const MODEL = "openai/gpt-5.6-luna";
const PRODUCT_OUTPUT = "QA_CODEX_AUTH_PRODUCT_PROOF_OK";
const REQUEST_TIMEOUT_MS = 60_000;

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

async function readRequests(requestLog: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(requestLog, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForRequest(
  requestLog: string,
  method: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = (await readRequests(requestLog)).find((request) => request.method === method);
    if (match) {
      return match;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for Codex app-server method ${method}`);
}

async function waitForAssistantHistory(
  testInstance: OpenClawTestInstance,
  expected: string,
): Promise<{ history: Record<string, unknown>; sessionKey: string }> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sessions = await testInstance.cli(
      ["gateway", "call", "sessions.list", "--json", "--params", '{"limit":20}'],
      { timeoutMs: 10_000 },
    );
    if (sessions.code !== 0) {
      await delay(100);
      continue;
    }
    const sessionResult = JSON.parse(sessions.stdout) as {
      sessions?: Array<{ key?: unknown }>;
    };
    const sessionKeys = sessionResult.sessions
      ?.map((session) => session.key)
      .filter((key): key is string => typeof key === "string");
    if (!sessionKeys?.length) {
      await delay(100);
      continue;
    }
    for (const sessionKey of sessionKeys) {
      const history = await testInstance.cli(
        [
          "gateway",
          "call",
          "chat.history",
          "--json",
          "--params",
          JSON.stringify({ agentId: "main", sessionKey, limit: 50 }),
          "--timeout",
          "5000",
        ],
        { timeoutMs: 10_000 },
      );
      if (history.code === 0) {
        const parsed = JSON.parse(history.stdout) as Record<string, unknown>;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        if (
          messages.some(
            (message) =>
              message !== null &&
              typeof message === "object" &&
              (message as { role?: unknown }).role === "assistant" &&
              JSON.stringify(message).includes(expected),
          )
        ) {
          return { history: parsed, sessionKey };
        }
      }
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for assistant history text ${expected}`);
}

describe("Codex auth product proof", () => {
  it(
    "repairs mixed legacy auth into SQLite and sends the selected OAuth profile to app-server",
    { timeout: 180_000 },
    async () => {
      const appServerFixture = path.resolve(
        "test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs",
      );
      instance = await createOpenClawTestInstance({
        name: "qa-codex-auth-product-proof",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
        config: {
          plugins: {
            enabled: true,
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "yolo",
                    command: process.execPath,
                    args: [appServerFixture],
                    requestTimeoutMs: REQUEST_TIMEOUT_MS,
                    turnCompletionIdleTimeoutMs: REQUEST_TIMEOUT_MS,
                  },
                },
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: MODEL, fallbacks: [] },
              models: { [MODEL]: { agentRuntime: { id: "codex" } } },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
              sandbox: { mode: "off" },
            },
          },
        },
      });

      const requestLog = instance.state.path("codex-auth-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG = requestLog;
      const legacyAuthPath = await instance.state.writeText(
        "agents/main/agent/auth-profiles.json",
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              [API_KEY_PROFILE_ID]: {
                type: "api_key",
                provider: "openai",
                key: "test-api-key",
              },
              [LEGACY_OAUTH_PROFILE_ID]: {
                type: "oauth",
                provider: "openai-codex",
                access: oauthAccess,
                refresh: "test-refresh",
                expires: Date.UTC(2036, 0, 1),
                accountId: ACCOUNT_ID,
              },
            },
            order: {
              openai: [API_KEY_PROFILE_ID],
              "openai-codex": [LEGACY_OAUTH_PROFILE_ID],
            },
          },
          null,
          2,
        )}\n`,
      );

      const doctor = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
        timeoutMs: 120_000,
      });
      expect(doctor.code, doctor.stderr).toBe(0);

      const canonicalStore = loadPersistedAuthProfileStore(instance.state.agentDir());
      expect(canonicalStore?.profiles[OAUTH_PROFILE_ID]).toMatchObject({
        type: "oauth",
        provider: "openai",
        access: oauthAccess,
        refresh: "test-refresh",
        expires: Date.UTC(2036, 0, 1),
        accountId: ACCOUNT_ID,
      });
      expect(canonicalStore?.profiles[API_KEY_PROFILE_ID]).toMatchObject({
        type: "api_key",
        provider: "openai",
      });
      expect(canonicalStore?.profiles[LEGACY_OAUTH_PROFILE_ID]).toBeUndefined();
      expect(canonicalStore?.order?.openai).toEqual([OAUTH_PROFILE_ID, API_KEY_PROFILE_ID]);
      await expect(fs.access(legacyAuthPath)).rejects.toMatchObject({ code: "ENOENT" });

      await instance.startGateway();
      const hook = await postJson(
        `http://127.0.0.1:${instance.port}/hooks/agent`,
        {
          message: `Reply with ${PRODUCT_OUTPUT}.`,
          name: "Codex auth product proof",
          deliver: false,
        },
        { Authorization: `Bearer ${instance.hookToken}` },
      );
      expect(hook.status, JSON.stringify(hook.json)).toBe(200);

      const loginRequest = await waitForRequest(requestLog, "account/login/start");
      const loginParams = loginRequest.params as Record<string, unknown>;
      expect(loginParams.type).toBe("chatgptAuthTokens");
      expect(loginParams.accessToken === oauthAccess).toBe(true);
      expect(loginParams.chatgptAccountId).toBe(ACCOUNT_ID);
      expect(loginParams.chatgptPlanType).toBeNull();

      await waitForRequest(requestLog, "turn/start");
      const turnRequests = await readRequests(requestLog);
      const threadStartIndex = turnRequests.findIndex(
        (request) => request.method === "thread/start",
      );
      const turnStartIndex = turnRequests.findIndex((request) => request.method === "turn/start");
      expect(threadStartIndex).toBeGreaterThanOrEqual(0);
      expect(turnStartIndex).toBeGreaterThan(threadStartIndex);
      const completedTurn = await waitForAssistantHistory(instance, PRODUCT_OUTPUT);

      const beforeUsage = (await readRequests(requestLog)).length;
      const status = await instance.cli(["status", "--usage", "--json", "--timeout", "60000"], {
        timeoutMs: 120_000,
      });
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("qa-codex-account@example.com");

      const usageRequests = (await readRequests(requestLog)).slice(beforeUsage);
      const usageLoginIndex = usageRequests.findIndex(
        (request) => request.method === "account/login/start",
      );
      const accountReadIndex = usageRequests.findIndex(
        (request) => request.method === "account/read",
      );
      expect(usageLoginIndex).toBeGreaterThanOrEqual(0);
      expect(accountReadIndex).toBeGreaterThan(usageLoginIndex);

      const usageLoginRequest = usageRequests[usageLoginIndex];
      const usageLoginParams = usageLoginRequest?.params as Record<string, unknown>;
      expect(usageLoginParams).toEqual({
        type: "chatgptAuthTokens",
        accessToken: oauthAccess,
        chatgptAccountId: ACCOUNT_ID,
        chatgptPlanType: null,
      });

      const accountReadRequest = usageRequests[accountReadIndex];
      expect(accountReadRequest?.params).toEqual({});

      console.log(
        `[qa-codex-auth-product-proof] ${JSON.stringify({
          selectedProfileId: canonicalStore?.order?.openai?.[0],
          canonicalStore: {
            profileIds: Object.keys(canonicalStore?.profiles ?? {}).toSorted(),
            order: canonicalStore?.order?.openai,
            legacyJsonRemoved: true,
          },
          gatewayTurn: {
            threadStartOrder: threadStartIndex,
            turnStartOrder: turnStartIndex,
            assistantOutput: PRODUCT_OUTPUT,
            historySessionKey: completedTurn.sessionKey,
            historySessionId: completedTurn.history.sessionId,
          },
          appServer: [
            {
              order: usageLoginIndex,
              method: usageLoginRequest?.method,
              params: {
                type: usageLoginParams.type,
                accessToken: "redacted",
                chatgptAccountId: usageLoginParams.chatgptAccountId,
                chatgptPlanType: usageLoginParams.chatgptPlanType,
              },
            },
            {
              order: accountReadIndex,
              method: accountReadRequest?.method,
              params: accountReadRequest?.params,
              result: {
                account: {
                  type: "chatgpt",
                  email: "qa-codex-account@example.com",
                  planType: "pro",
                },
                requiresOpenaiAuth: true,
              },
            },
          ],
        })}`,
      );
    },
  );
});
