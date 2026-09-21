import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertNoExtraAppRunsForProviderChildren,
  assertTurnItemTypes,
  projectionFor,
} from "../shared.ts";

export function assertHermesSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const parent = projectionFor(result, transcript.scenario);
  assertTurnItemTypes(parent, ["user_message", "subagent", "assistant_message"]);
  assertExecutionNodeKinds(parent, ["root_turn", "subagent", "assistant_message"]);
  assertNoExtraAppRunsForProviderChildren({ projection: parent, expectedAppRuns: 1 });
  assert.lengthOf(parent.subagents, 1);

  const subagent = parent.subagents[0];
  assert.isDefined(subagent);
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.driver, "hermes");
  assert.equal(subagent.title, "Audit orchestration architecture");
  assert.isNotNull(subagent.providerThreadId);
  assert.include(subagent.result ?? "", "durable events and projections");
  assert.isNotNull(subagent.childThreadId);
  assert.lengthOf(result.shellSnapshot.threads, 2);
  assert.notInclude(
    parent.messages.map((message) => message.text).join("\n"),
    "durable events and projections",
    "child output must stay in the child timeline",
  );

  if (subagent.childThreadId === null) throw new Error("Hermes subagent child thread is missing");
  const child = result.projections.get(subagent.childThreadId);
  assert.isDefined(child);
  assert.equal(child.thread.lineage.parentThreadId, parent.thread.id);
  assert.equal(child.thread.lineage.relationshipToParent, "subagent");
  assert.lengthOf(child.runs, 0);
  assert.equal(child.providerThreads[0]?.nativeThreadRef?.nativeId, "hermes-child-session-1");
  assertTurnItemTypes(child, ["user_message", "assistant_message"]);
  assert.include(
    child.messages.find((message) => message.role === "assistant")?.text ?? "",
    "durable events and projections",
  );
}
