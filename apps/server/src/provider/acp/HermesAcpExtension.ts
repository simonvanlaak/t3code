import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

export interface HermesAcpSubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status:
    | "pending"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly childSessionId: string | null;
  readonly result: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function status(
  value: unknown,
  fallback: AcpToolCallState["status"],
): HermesAcpSubagentUpdate["status"] {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "timeout":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    case "pending":
      return "pending";
    case "idle":
      return "idle";
    default:
      return fallback === "completed" ? "completed" : fallback === "failed" ? "failed" : "running";
  }
}

/** Map the standard ACP tool-call envelopes emitted by `hermes acp` into V2 subagents. */
export function extractHermesAcpSubagentUpdate(
  toolCall: AcpToolCallState,
): HermesAcpSubagentUpdate | undefined {
  const input = record(toolCall.data.rawInput);
  if (input?.hermesSubagent !== true) return undefined;
  const output = record(toolCall.data.rawOutput);
  const nativeTaskId = text(input.subagentId) ?? text(input.nativeTaskId);
  if (nativeTaskId === undefined) return undefined;
  return {
    nativeTaskId,
    prompt: text(input.goal) ?? toolCall.title ?? "Hermes subagent",
    title: text(input.role) ?? null,
    model: text(input.model) ?? null,
    status: status(output?.status, toolCall.status),
    childSessionId: text(output?.childSessionId) ?? text(input.childSessionId) ?? null,
    result: text(output?.summary) ?? text(output?.progress) ?? null,
  };
}
