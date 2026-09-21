import { describe, expect, it } from "vite-plus/test";

import { extractHermesAcpSubagentUpdate } from "./HermesAcpExtension.ts";

describe("extractHermesAcpSubagentUpdate", () => {
  it("maps a running Hermes child into the V2 subagent envelope", () => {
    expect(
      extractHermesAcpSubagentUpdate({
        toolCallId: "tc-child",
        title: "[subagent] Inspect orchestration",
        kind: "think",
        status: "inProgress",
        data: {
          rawInput: {
            hermesSubagent: true,
            subagentId: "child-1",
            goal: "Inspect orchestration",
            model: "openai-codex:gpt-5.6-sol",
            childSessionId: "session-child-1",
          },
          rawOutput: {
            event: "subagent.tool",
            status: "running",
            progress: "read_file",
          },
        },
      }),
    ).toEqual({
      nativeTaskId: "child-1",
      prompt: "Inspect orchestration",
      title: "Inspect orchestration",
      model: "openai-codex:gpt-5.6-sol",
      status: "running",
      childSessionId: "session-child-1",
      result: "read_file",
    });
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["timeout", "failed"],
    ["interrupted", "interrupted"],
    ["cancelled", "cancelled"],
  ] as const)("maps terminal status %s to %s", (nativeStatus, expected) => {
    const update = extractHermesAcpSubagentUpdate({
      toolCallId: "tc-child",
      title: "[subagent] Child",
      kind: "think",
      status: nativeStatus === "failed" ? "failed" : "completed",
      data: {
        rawInput: { hermesSubagent: true, subagentId: "child-1", goal: "Child" },
        rawOutput: { status: nativeStatus, summary: "done" },
      },
    });
    expect(update?.status).toBe(expected);
    expect(update?.result).toBe("done");
  });

  it("ignores ordinary ACP tool calls", () => {
    expect(
      extractHermesAcpSubagentUpdate({
        toolCallId: "tc-read",
        title: "read_file",
        kind: "read",
        status: "completed",
        data: { rawInput: { path: "README.md" } },
      }),
    ).toBeUndefined();
  });
});
