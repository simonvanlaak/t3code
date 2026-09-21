import * as NodeServices from "@effect/platform-node/NodeServices";
import { HermesSettings } from "@t3tools/contracts";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { makeLayerEffect as makeProviderAdapterRegistryLayerEffect } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { makeReplayServerConfig } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  HERMES_DEFAULT_INSTANCE_ID,
  HERMES_PROVIDER,
  makeHermesAdapterV2,
} from "./HermesAdapterV2.ts";

const DEFAULT_HERMES_SETTINGS = Schema.decodeUnknownSync(HermesSettings)({});

export function makeHermesProviderAdapterRegistryReplayLayer(transcript: AcpReplayTranscript) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(`hermes-${transcript.scenario}`).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));

  return makeProviderAdapterRegistryLayerEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      const replayDir = yield* fileSystem
        .makeTempDirectory({ prefix: `t3-orchestration-v2-hermes-replay-${transcript.scenario}-` })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = makeHermesAdapterV2({
        instanceId: HERMES_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_HERMES_SETTINGS,
        environment: {},
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
        }),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(Layer.provide(Layer.mergeAll(serverConfigLayer, NodeServices.layer, idAllocatorLayer)));
}

export const HermesOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: HERMES_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeAcpReplayTranscript(transcript, HERMES_PROVIDER, { retargetProvider: true }),
  makeProviderAdapterRegistryLayer: makeHermesProviderAdapterRegistryReplayLayer,
};
