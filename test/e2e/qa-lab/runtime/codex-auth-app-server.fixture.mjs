// Minimal Codex app-server fixture for the QA auth product proof.
import fs from "node:fs";
import readline from "node:readline";

const requestLog = process.env.OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG;
if (!requestLog) {
  throw new Error("missing OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG");
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const request = JSON.parse(line);
  fs.appendFileSync(requestLog, `${JSON.stringify(request)}\n`);

  const { id, method, params } = request;
  if (id === undefined) {
    return;
  }
  if (method === "initialize") {
    send(id, {
      protocolVersion: "2",
      serverInfo: { name: "openclaw-qa-codex-auth", version: "0.143.0" },
      userAgent: "openclaw/0.143.0 (test)",
    });
    return;
  }
  if (method === "account/login/start") {
    send(id, { type: params?.type });
    return;
  }
  if (method === "account/rateLimits/read") {
    send(id, {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: "pro",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    });
    return;
  }
  if (method === "account/read") {
    send(id, {
      account: {
        type: "chatgpt",
        email: "qa-codex-account@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: true,
    });
    return;
  }
  if (method === "thread/start") {
    const now = Date.now();
    send(id, {
      thread: {
        id: "thread-qa-codex-auth",
        sessionId: "session-qa-codex-auth",
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: now,
        updatedAt: now,
        status: { type: "idle" },
        path: null,
        cwd: params?.cwd ?? process.cwd(),
        cliVersion: "0.143.0",
        source: "unknown",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: params?.model ?? "gpt-5.6-luna",
      modelProvider: "openai",
      serviceTier: null,
      cwd: params?.cwd ?? process.cwd(),
      instructionSources: [],
      approvalPolicy: params?.approvalPolicy ?? "never",
      approvalsReviewer: params?.approvalsReviewer ?? "user",
      sandbox: { type: "dangerFullAccess" },
      permissionProfile: null,
      reasoningEffort: null,
    });
    return;
  }
  if (method === "turn/start") {
    const threadId = params?.threadId ?? "thread-qa-codex-auth";
    const turnId = "turn-qa-codex-auth";
    const message = {
      type: "agentMessage",
      id: "message-qa-codex-auth",
      text: "QA_CODEX_AUTH_PRODUCT_PROOF_OK",
    };
    send(id, {
      turn: {
        id: turnId,
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    });
    setImmediate(() => {
      const completedAtMs = Date.now();
      notify("item/completed", {
        item: message,
        threadId,
        turnId,
        completedAtMs,
      });
      notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          items: [message],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: Math.floor(completedAtMs / 1000),
          completedAt: Math.floor(completedAtMs / 1000),
          durationMs: 0,
        },
      });
    });
    return;
  }
  send(id, {});
});
