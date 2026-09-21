import type { HermesSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Auth method advertised by `hermes acp` for pre-configured runtime credentials. */
export const HERMES_AUTH_METHOD_ID = "custom";

/** Product slug meaning "keep Hermes' configured model". */
export const HERMES_DEFAULT_MODEL_SLUG = "default";

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

type HermesAcpModelSelectionRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "setSessionModel"
>;

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: HermesAcpModelSelectionRuntime;
  readonly currentModelId?: string | undefined;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly mapError: (context: { readonly cause: EffectAcpErrors.AcpError }) => E;
}): Effect.Effect<void, E> {
  const requestedModelId = input.model.trim();
  if (requestedModelId.length === 0 || requestedModelId === HERMES_DEFAULT_MODEL_SLUG) {
    return Effect.void;
  }
  if (requestedModelId === input.currentModelId && input.reasoningEffort === undefined) {
    return Effect.void;
  }
  return input.runtime
    .setSessionModel(
      requestedModelId,
      input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : undefined,
    )
    .pipe(
      Effect.asVoid,
      Effect.mapError((cause) => input.mapError({ cause })),
    );
}
