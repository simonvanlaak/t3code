// @effect-diagnostics nodeBuiltinImport:off - bounded read-only discovery maps
// Hermes CLI skill names back to their SKILL.md files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  HermesSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderState,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { HERMES_DEFAULT_MODEL_SLUG, makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
} as const;
const HERMES_REASONING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: "medium",
      options: [
        { id: "none", label: "None" },
        { id: "minimal", label: "Minimal" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra high" },
        { id: "max", label: "Max" },
      ],
    },
  ],
});

const HERMES_VERSION_PROBE_TIMEOUT_MS = 4_000;
const HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const HERMES_SKILLS_DISCOVERY_TIMEOUT_MS = 10_000;
const HERMES_USAGE_DISCOVERY_TIMEOUT_MS = 10_000;
const HERMES_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Hermes ACP model discovery failed.",
  "Hermes may not be configured on this machine yet; run `hermes setup` (or `hermes acp --setup`), then retry.",
  "Check server logs for ACP details.",
].join(" ");
const HERMES_CHATGPT_SUBSCRIPTION_LABEL = "ChatGPT or Codex Subscription";
const HERMES_CHATGPT_SUBSCRIPTION_SHORT_LABEL = "ChatGPT Sub";

const HERMES_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: HERMES_DEFAULT_MODEL_SLUG,
    name: "Hermes (configured default)",
    isCustom: false,
    isDefault: true,
    capabilities: HERMES_REASONING_CAPABILITIES,
  },
];

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getHermesFallbackModels(hermesSettings);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes Agent availability...",
      },
    });
  });
}

export function formatHermesModelName(name: string, slug: string): string {
  const trimmedName = name.trim() || slug;
  if (trimmedName === HERMES_CHATGPT_SUBSCRIPTION_LABEL) {
    return HERMES_CHATGPT_SUBSCRIPTION_SHORT_LABEL;
  }
  if (trimmedName.startsWith(`${HERMES_CHATGPT_SUBSCRIPTION_LABEL} ·`)) {
    return `${HERMES_CHATGPT_SUBSCRIPTION_SHORT_LABEL}${trimmedName.slice(HERMES_CHATGPT_SUBSCRIPTION_LABEL.length)}`;
  }
  return trimmedName;
}

function buildHermesDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  // Mark the session's current model as the default so the model resolver
  // binds new sessions to it instead of the catalog's first entry — without
  // this a session/set_model fires on every start, switching the agent away
  // from its own configured model.
  const currentModelId = modelState.currentModelId?.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: formatHermesModelName(model.name, slug),
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities: HERMES_REASONING_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

export const discoverHermesModelsViaAcp = (
  hermesSettings: HermesSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      ...(environment ? { environment } : {}),
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildHermesDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

export function parseHermesEnabledSkillNames(stdout: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const rawLine of stdout.replaceAll(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const match = /^│\s*([^│]+?)\s*│/.exec(rawLine);
    const name = match?.[1]?.trim();
    if (name && name !== "Name") names.add(name);
  }
  return names;
}

function findHermesSkillFiles(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  if (!NodeFS.existsSync(root)) return files;
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < 10_000) {
    const directory = pending.pop()!;
    visited += 1;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const skillPath = NodePath.join(directory, "SKILL.md");
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const directoryName = NodePath.basename(directory);
      files.set(directoryName, skillPath);
      try {
        const frontmatter = NodeFS.readFileSync(skillPath, "utf8").slice(0, 16_384);
        const declaredName = /^---\r?\n[\s\S]*?^name:\s*["']?([^\r\n"']+)/m
          .exec(frontmatter)?.[1]
          ?.trim();
        if (declaredName) files.set(declaredName, skillPath);
      } catch {
        // The directory name remains usable when optional metadata is unreadable.
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        pending.push(NodePath.join(directory, entry.name));
      }
    }
  }
  return files;
}

export const discoverHermesSkills = (
  hermesSettings: Pick<HermesSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const skillEnvironment: NodeJS.ProcessEnv = { ...environment, COLUMNS: "500" };
    const spawnCommand = yield* resolveSpawnCommand(command, ["skills", "list", "--enabled-only"], {
      env: skillEnvironment,
    });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: skillEnvironment,
        shell: spawnCommand.shell,
      }),
    );
    if (result.code !== 0) return [];
    const enabledNames = parseHermesEnabledSkillNames(result.stdout);
    const home = skillEnvironment.HOME?.trim();
    if (!home) return [];
    const files = findHermesSkillFiles(NodePath.join(home, ".hermes", "skills"));
    const fallbackNames = [...files.keys()].sort((left, right) => right.length - left.length);
    return [...enabledNames].flatMap((name): ReadonlyArray<ServerProviderSkill> => {
      const path =
        files.get(name) ??
        files.get(fallbackNames.find((candidate) => name.startsWith(`${candidate}-`)) ?? "");
      return path ? [{ name, path, scope: "user", enabled: true }] : [];
    });
  });

export function parseHermesUsageLimits(
  stdout: string,
  fallbackCheckedAt: string,
): ServerProviderUsageLimits | undefined {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stdout.slice(jsonStart));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.windows)) return undefined;
  const windows = record.windows.flatMap((entry, index) => {
    if (typeof entry !== "object" || entry === null) return [];
    const window = entry as Record<string, unknown>;
    const label = typeof window.label === "string" ? window.label.trim() : "";
    const usedPercent = typeof window.used_percent === "number" ? window.used_percent : Number.NaN;
    if (!label || !Number.isFinite(usedPercent)) return [];
    const normalized = label.toLowerCase();
    const kind = normalized.includes("week")
      ? ("weekly" as const)
      : normalized.includes("month")
        ? ("monthly" as const)
        : normalized.includes("hour") || normalized.includes("session")
          ? ("session" as const)
          : ("other" as const);
    const resetsAt = typeof window.resets_at === "string" ? window.resets_at.trim() : "";
    return [
      {
        id: normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `window_${index}`,
        kind,
        label,
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
  const fetchedAt = typeof record.fetched_at === "string" ? record.fetched_at.trim() : "";
  const details = Array.isArray(record.details)
    ? record.details.filter((detail): detail is string => typeof detail === "string")
    : [];
  const resetMatch = details.join(" ").match(/\b(\d+)\s+resets?\s+banked\b/i);
  return {
    checkedAt: fetchedAt || fallbackCheckedAt,
    windows,
    ...(resetMatch ? { resetCredits: { availableCount: Number(resetMatch[1]) } } : {}),
  };
}

const discoverHermesUsageLimits = (
  hermesSettings: Pick<HermesSettings, "binaryPath">,
  checkedAt: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(command, ["usage", "--json"], {
      env: environment,
    });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    return result.code === 0 ? parseHermesUsageLimits(result.stdout, checkedAt) : undefined;
  });

export function getHermesFallbackModels(
  hermesSettings: Pick<HermesSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    HERMES_BUILT_IN_MODELS,
    hermesSettings.customModels,
    HERMES_REASONING_CAPABILITIES,
  );
}

/**
 * Extract the Hermes Agent version from `hermes --version` output.
 *
 * The first line looks like:
 * `Hermes Agent v0.21.0 (2026.8.31) · upstream f98f5e74`
 *
 * The generic parser would grab the parenthesised build date first, so we
 * prefer the `v`-prefixed semver token and fall back to the generic parser.
 */
export function parseHermesCliVersion(output: string): string | null {
  const match = output.match(/\bv(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? parseGenericCliVersion(output);
}

export interface HermesVersionResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildHermesCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Hermes Agent command \`${binaryPath}\` was not found.`,
    `Install the Hermes Agent CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
  ].join(" ");
}

export function buildHermesProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly hermesSettings: HermesSettings;
  readonly parsed: HermesVersionResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveredSkills?: ReadonlyArray<ServerProviderSkill>;
  readonly usageLimits?: ServerProviderUsageLimits;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: input.hermesSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels && input.discoveredModels.length > 0
        ? input.discoveredModels
        : HERMES_BUILT_IN_MODELS,
      input.hermesSettings.customModels,
      HERMES_REASONING_CAPABILITIES,
    ),
    skills: input.discoveredSkills ?? [],
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
      ...(message ? { message } : {}),
    },
  });
}

/** Interpret `hermes --version` output as a probe result. */
export function parseHermesVersionOutput(result: CommandResult): HermesVersionResult {
  const version = parseHermesCliVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    return {
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes Agent CLI is installed but failed to run.",
    };
  }
  return { version, status: "ready", auth: { status: "unknown" } };
}

const runHermesVersionCommand = (hermesSettings: HermesSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["--version"],
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getHermesFallbackModels(hermesSettings);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Hermes Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? buildHermesCliCommandMissingMessage(hermesSettings.binaryPath || "hermes")
          : "Failed to execute Hermes Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const parsed = parseHermesVersionOutput(versionProbe.success.value);
  // Hermes has no standalone auth probe: `hermes acp` authenticates through the
  // "custom" method during startup, so a successful ACP discovery doubles as
  // proof of authentication.
  let auth: ServerProviderAuth = parsed.auth;
  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveredSkills: ReadonlyArray<ServerProviderSkill> = [];
  let usageLimits: ServerProviderUsageLimits | undefined;
  let discoveryWarning: string | undefined;
  if (parsed.status === "ready") {
    const discoveryExit = yield* Effect.exit(
      discoverHermesModelsViaAcp(hermesSettings, environment).pipe(
        Effect.timeoutOption(HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Hermes ACP model discovery failed", {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
      discoveryWarning = HERMES_ACP_MODEL_DISCOVERY_FAILED_MESSAGE;
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Hermes ACP model discovery timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Hermes ACP model discovery returned no built-in models.";
      auth = { status: "authenticated" };
    } else {
      discoveredModels = discoveryExit.value;
      auth = { status: "authenticated" };
    }
    discoveredSkills = yield* discoverHermesSkills(hermesSettings, environment ?? process.env).pipe(
      Effect.timeoutOption(HERMES_SKILLS_DISCOVERY_TIMEOUT_MS),
      Effect.map(Option.getOrElse(() => [] as const)),
      Effect.catch(() => Effect.succeed([] as const)),
    );
    usageLimits = yield* discoverHermesUsageLimits(
      hermesSettings,
      checkedAt,
      environment ?? process.env,
    ).pipe(
      Effect.timeoutOption(HERMES_USAGE_DISCOVERY_TIMEOUT_MS),
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  }
  return buildHermesProviderSnapshot({
    checkedAt,
    hermesSettings,
    parsed: { ...parsed, auth },
    discoveredModels: Option.getOrElse(
      Option.filter(discoveredModels, (models) => models.length > 0),
      () => [] as const,
    ),
    discoveredSkills,
    ...(usageLimits ? { usageLimits } : {}),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

/**
 * Background maintenance enrichment for a Hermes snapshot.
 *
 * Used by `HermesDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery. Hermes model data comes exclusively from ACP
 * session setup during provider status checks.
 */
export const enrichHermesSnapshot = (input: {
  readonly settings: HermesSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};
