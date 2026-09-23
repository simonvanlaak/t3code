import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  HermesProviderCapabilitiesV2,
  HERMES_PROVIDER,
  makeHermesAcpAdapterFlavor,
  type HermesAdapterV2Options,
} from "./HermesAdapterV2.ts";
import { isBuiltInProviderAdapterDriverV2 } from "../builtInProviderAdapterDrivers.ts";

describe("HermesAdapterV2", () => {
  it("registers Hermes as a built-in V2 adapter driver", () => {
    assert.isTrue(isBuiltInProviderAdapterDriverV2(HERMES_PROVIDER));
  });

  it("advertises native subagent lifecycle and model switching", () => {
    assert.isTrue(HermesProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(HermesProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(HermesProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isTrue(HermesProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
  });

  it("installs the Hermes subagent extractor on AcpAdapterV2", () => {
    const flavor = makeHermesAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as HermesAdapterV2Options);
    const update = flavor.extractSubagentUpdate?.({
      toolCallId: "tc-child",
      title: "[subagent] Inspect",
      kind: "think",
      status: "completed",
      data: {
        rawInput: {
          hermesSubagent: true,
          subagentId: "child-1",
          goal: "Inspect",
          childSessionId: "session-child-1",
        },
        rawOutput: { status: "completed", summary: "done" },
      },
    });
    assert.equal(update?.nativeTaskId, "child-1");
    assert.equal(update?.childSessionId, "session-child-1");
    assert.equal(update?.status, "completed");
    assert.isTrue(flavor.modelSelectionOptionIdsHandledByFlavor?.has("reasoningEffort"));
  });
});
