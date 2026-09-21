import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_SUBAGENT_PROMPT = "delegate one architecture audit";

export function hermesSubagentInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: HERMES_SUBAGENT_PROMPT }] };
}
