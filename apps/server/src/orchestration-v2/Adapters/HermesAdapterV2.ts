import {
  defaultInstanceIdForDriver,
  HermesSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import { extractHermesAcpSubagentUpdate } from "../../provider/acp/HermesAcpExtension.ts";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
} from "../../provider/acp/HermesAcpSupport.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { IdAllocatorV2 } from "../IdAllocator.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
export const HERMES_DRIVER_KIND = HERMES_PROVIDER;
export const HERMES_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(HERMES_DRIVER_KIND);
const DEFAULT_HERMES_SETTINGS = Schema.decodeSync(HermesSettings)({});

export const HermesProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface HermesAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export function makeHermesAcpAdapterFlavor(options: HermesAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: HERMES_PROVIDER,
    runtimeHarness: "Hermes",
    capabilities: HermesProviderCapabilitiesV2,
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeHermesAcpRuntime({
          ...input,
          hermesSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        })),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      applyHermesAcpModelSelection({
        runtime,
        currentModelId: currentHermesModelIdFromSessionSetup(startResult.sessionSetupResult),
        model: modelSelection.model,
        reasoningEffort: getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
        mapError: ({ cause }) => cause,
      }).pipe(Effect.as(modelSelection.model)),
    extractSubagentUpdate: extractHermesAcpSubagentUpdate,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export function makeHermesAdapterV2(options: HermesAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeHermesAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
}

export type HermesAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ProviderEventLoggers
  | ServerConfig;

export const HermesAdapterV2Driver: ProviderAdapterDriver<
  HermesSettings,
  HermesAdapterV2DriverEnv
> = {
  driverKind: HERMES_DRIVER_KIND,
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeHermesAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: HERMES_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes ACP V2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
