// @effect-diagnostics nodeBuiltinImport:off - exercises Hermes's real SQLite store shape.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { readHermesUsageRecords } from "./hermesUsageDatabase.ts";

function createUsageDatabase(stateDbPath: string): NodeSqlite.DatabaseSync {
  const db = new NodeSqlite.DatabaseSync(stateDbPath);
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, model TEXT NOT NULL,
      billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '',
      billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
      api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0,
      cost_status TEXT, cost_source TEXT, occurred_at REAL NOT NULL
    );
  `);
  return db;
}

describe("readHermesUsageRecords", () => {
  it("reads timestamped usage deltas across hours and days without reallocating cumulative totals", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-usage-"));
    try {
      const stateDbPath = NodePath.join(dir, "state.db");
      const db = createUsageDatabase(stateDbPath);
      db.exec(`
        INSERT INTO usage_events VALUES (
          1, 'session-1', 'gpt-5.6-sol', 'openai-codex', '', 'subscription_included', '',
          1, 120, 30, 80, 10, 12, 0, 0, NULL, NULL, 1788256805
        );
        INSERT INTO usage_events VALUES (
          2, 'session-1', 'gpt-5.6-sol', 'openai-codex', '', 'subscription_included', '',
          1, 40, 8, 20, 0, 3, 0, 0, NULL, NULL, 1788343205
        );
      `);
      db.close();

      expect(readHermesUsageRecords(stateDbPath, 1788250000000, "store-a")).toEqual([
        {
          provider: "hermes",
          timestampMs: 1788256805000,
          model: "gpt-5.6-sol",
          sessionId: "session-1",
          totals: {
            uncachedInputTokens: 120,
            cachedInputTokens: 80,
            cacheCreationTokens: 10,
            outputTokens: 30,
            reasoningTokens: 12,
          },
          reportedCostUsd: null,
          dedupeKey: "hermes:store-a:1",
        },
        {
          provider: "hermes",
          timestampMs: 1788343205000,
          model: "gpt-5.6-sol",
          sessionId: "session-1",
          totals: {
            uncachedInputTokens: 40,
            cachedInputTokens: 20,
            cacheCreationTokens: 0,
            outputTokens: 8,
            reasoningTokens: 3,
          },
          reportedCostUsd: null,
          dedupeKey: "hermes:store-a:2",
        },
      ]);
      expect(readHermesUsageRecords(stateDbPath, 1788260000000)).toHaveLength(1);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no records for missing or locked databases", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-usage-"));
    try {
      const stateDbPath = NodePath.join(dir, "state.db");
      expect(readHermesUsageRecords(stateDbPath, 0)).toEqual([]);

      const db = createUsageDatabase(stateDbPath);
      db.exec("BEGIN EXCLUSIVE");
      expect(readHermesUsageRecords(stateDbPath, 0)).toEqual([]);
      db.exec("ROLLBACK");
      db.close();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
