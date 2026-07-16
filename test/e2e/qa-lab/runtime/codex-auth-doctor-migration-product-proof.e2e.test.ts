// QA Lab product proof for the legacy Codex auth doctor migration matrix.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../../../../src/agents/auth-profiles/persisted.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

const OAUTH_PROFILE_ID = "openai:qa-oauth";
const LEGACY_OAUTH_PROFILE_ID = "openai-codex:qa-oauth";
const API_KEY_PROFILE_ID = "openai:media-api";

type MigrationCell = {
  name: string;
  includeApiKey: boolean;
  expectedOrder: string[];
};

const cells: MigrationCell[] = [
  {
    name: "oauth-only",
    includeApiKey: false,
    expectedOrder: [OAUTH_PROFILE_ID],
  },
  {
    name: "mixed-no-pin",
    includeApiKey: true,
    expectedOrder: [OAUTH_PROFILE_ID, API_KEY_PROFILE_ID],
  },
];

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

describe("Codex doctor migration product proof", () => {
  it.each(cells)(
    "repairs the $name legacy store into canonical per-agent SQLite",
    { timeout: 180_000 },
    async ({ name, includeApiKey, expectedOrder }) => {
      instance = await createOpenClawTestInstance({
        name: `qa-codex-doctor-${name}`,
      });

      const profiles: Record<string, Record<string, unknown>> = {
        [LEGACY_OAUTH_PROFILE_ID]: {
          type: "oauth",
          provider: "openai-codex",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.UTC(2036, 0, 1),
          accountId: `qa-codex-${name}-account`,
        },
      };
      if (includeApiKey) {
        profiles[API_KEY_PROFILE_ID] = {
          type: "api_key",
          provider: "openai",
          key: "test-api-key",
        };
      }

      const order: Record<string, string[]> = {
        "openai-codex": [LEGACY_OAUTH_PROFILE_ID],
      };
      if (includeApiKey) {
        order.openai = [API_KEY_PROFILE_ID];
      }

      const legacyAuthPath = await instance.state.writeText(
        "agents/main/agent/auth-profiles.json",
        `${JSON.stringify({ version: 1, profiles, order }, null, 2)}\n`,
      );
      const doctor = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
        timeoutMs: 120_000,
      });
      expect(doctor.code, doctor.stderr).toBe(0);

      const canonicalStore = loadPersistedAuthProfileStore(instance.state.agentDir());
      expect(canonicalStore?.profiles[OAUTH_PROFILE_ID]).toMatchObject({
        type: "oauth",
        provider: "openai",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.UTC(2036, 0, 1),
        accountId: `qa-codex-${name}-account`,
      });
      expect(canonicalStore?.profiles[LEGACY_OAUTH_PROFILE_ID]).toBeUndefined();
      expect(canonicalStore?.order?.openai).toEqual(expectedOrder);
      if (includeApiKey) {
        expect(canonicalStore?.profiles[API_KEY_PROFILE_ID]).toMatchObject({
          type: "api_key",
          provider: "openai",
        });
      }
      await expect(fs.access(legacyAuthPath)).rejects.toMatchObject({ code: "ENOENT" });

      console.log(
        `[qa-codex-doctor-migration-product-proof] ${JSON.stringify({
          cell: name,
          canonicalProfileIds: Object.keys(canonicalStore?.profiles ?? {}).toSorted(),
          openaiOrder: canonicalStore?.order?.openai,
          legacyJsonRemoved: true,
        })}`,
      );
    },
  );
});
