// @effect-diagnostics nodeBuiltinImport:off - Hermes persists usage in its SQLite state store.
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

interface HermesUsageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly model: unknown;
  readonly billing_provider: unknown;
  readonly billing_base_url: unknown;
  readonly billing_mode: unknown;
  readonly task: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_read_tokens: unknown;
  readonly cache_write_tokens: unknown;
  readonly reasoning_tokens: unknown;
  readonly occurred_at: unknown;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reads Hermes's canonical token ledger without mutating or checkpointing it. */
export function readHermesUsageRecords(
  stateDbPath: string,
  sinceMs: number,
  sourceFingerprint: string = stateDbPath,
): readonly UsageRecord[] {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(stateDbPath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT
           id,
           session_id,
           model,
           billing_provider,
           billing_base_url,
           billing_mode,
           task,
           input_tokens,
           output_tokens,
           cache_read_tokens,
           cache_write_tokens,
           reasoning_tokens,
           occurred_at
         FROM usage_events
         WHERE occurred_at >= ?
         ORDER BY occurred_at, id`,
      )
      .all(sinceMs / 1000) as unknown as readonly HermesUsageRow[];

    return rows.flatMap((row): readonly UsageRecord[] => {
      const sessionId = stringValue(row.session_id);
      const model = stringValue(row.model);
      const eventId = typeof row.id === "number" && Number.isSafeInteger(row.id) ? row.id : null;
      const timestampSeconds =
        typeof row.occurred_at === "number" && Number.isFinite(row.occurred_at)
          ? row.occurred_at
          : null;
      if (!sessionId || !model || eventId === null || timestampSeconds === null) return [];

      const totals = {
        uncachedInputTokens: nonNegativeInt(row.input_tokens),
        cachedInputTokens: nonNegativeInt(row.cache_read_tokens),
        cacheCreationTokens: nonNegativeInt(row.cache_write_tokens),
        outputTokens: nonNegativeInt(row.output_tokens),
        reasoningTokens: nonNegativeInt(row.reasoning_tokens),
      };
      if (totalTokens(totals) === 0) return [];

      return [
        {
          provider: "hermes" as UsageProviderKind,
          timestampMs: timestampSeconds * 1000,
          model,
          sessionId,
          totals,
          reportedCostUsd: null,
          dedupeKey: `hermes:${sourceFingerprint}:${eventId}`,
        },
      ];
    });
  } catch {
    return [];
  } finally {
    database?.close();
  }
}
