/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
import {
  type EnvironmentId,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Providers that belong on the Limits view: enabled, installed, and one whose
 * driver reports subscription usage at all. A driver with no notion of usage
 * never sets `usageLimits`, so it has no row rather than an empty one.
 */
export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      (provider.usageLimits !== undefined || (provider.usageAccounts?.length ?? 0) > 0),
  );
}

export interface LimitsGroup {
  readonly environmentId: EnvironmentId;
  /** Null while only one environment is connected; there is nothing to tell apart. */
  readonly environmentLabel: string | null;
  readonly providers: readonly ServerProvider[];
}

/**
 * One group per connected environment with a provider reporting limits.
 * Provider snapshots come from the config stream every client already holds,
 * so opening the view costs no extra request.
 */
export function collectLimitsGroups(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: { readonly providers: readonly ServerProvider[] } | null;
    }
  >,
): readonly LimitsGroup[] {
  const groups = new Map<EnvironmentId, LimitsGroup>();
  const accountOwners = new Map<
    string,
    { readonly environmentId: EnvironmentId; readonly provider: ServerProvider }
  >();

  for (const [environmentId, presentation] of presentations) {
    const providers: ServerProvider[] = [];
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageAccounts?.length) {
        providers.push(provider);
        continue;
      }
      for (const account of provider.usageAccounts) {
        const fallbackKey = `${environmentId}:${provider.instanceId}:${account.id}`;
        const identityKey = accountKey(
          provider.driver,
          account.email,
          account.plan,
          account.usageLimits,
        );
        const sameIdentity = identityKey ? accountOwners.get(identityKey) : undefined;
        const key =
          sameIdentity?.environmentId === environmentId
            ? fallbackKey
            : (identityKey ?? fallbackKey);
        const synthetic: ServerProvider = {
          ...provider,
          displayName: account.email ? provider.displayName : account.label,
          auth: {
            ...provider.auth,
            ...(account.plan ? { label: account.plan } : {}),
            email: account.email,
          },
          usageLimits: account.usageLimits,
          usageAccounts: [],
        };
        const owner = accountOwners.get(key);
        if (!owner) {
          providers.push(synthetic);
          accountOwners.set(key, { environmentId, provider: synthetic });
          continue;
        }
        const fresher =
          Date.parse(account.usageLimits.checkedAt) >
          Date.parse(owner.provider.usageLimits?.checkedAt ?? "");
        const merged: ServerProvider = {
          ...(fresher ? synthetic : owner.provider),
          displayName: owner.provider.displayName ?? synthetic.displayName,
          auth: {
            ...(fresher ? synthetic.auth : owner.provider.auth),
            email: owner.provider.auth.email ?? synthetic.auth.email,
            label: owner.provider.auth.label ?? synthetic.auth.label,
          },
        };
        const ownerGroup = groups.get(owner.environmentId);
        if (ownerGroup) {
          groups.set(owner.environmentId, {
            ...ownerGroup,
            providers: ownerGroup.providers.map((candidate) =>
              candidate === owner.provider ? merged : candidate,
            ),
          });
        }
        accountOwners.set(key, { environmentId: owner.environmentId, provider: merged });
      }
    }
    if (providers.length === 0) continue;
    groups.set(environmentId, {
      environmentId,
      environmentLabel: presentation.entry.target.label,
      providers,
    });
  }

  const result = [...groups.values()];
  return result.length > 1 ? result : result.map((group) => ({ ...group, environmentLabel: null }));
}

/**
 * Every usage-limit source across connected environments, keyed so two
 * environments pointing at the same hub still get their own rows. The label
 * carries the environment only when more than one environment has sources.
 * A native provider with usable limits takes precedence over the same account
 * in a source, even when it belongs to another connected environment.
 */
export function collectLimitSources(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: {
        readonly providers?: readonly ServerProvider[] | undefined;
        readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      } | null;
    }
  >,
): ReadonlyArray<
  UsageLimitSourceSnapshot & {
    readonly key: string;
    readonly environmentId: EnvironmentId;
    readonly hiddenAccountCount: number;
  }
> {
  const nativeAccounts = new Set<string>();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const key = accountKey(provider.driver, provider.auth.email);
      if (
        key !== null &&
        provider.usageLimits?.windows.length &&
        !provider.usageLimits.unavailable
      ) {
        nativeAccounts.add(key);
      }
    }
  }
  const perEnvironment: Array<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly sources: UsageLimitSourceSnapshots;
  }> = [];
  for (const [environmentId, presentation] of presentations) {
    const sources = presentation.serverConfig?.usageLimitSources ?? [];
    if (sources.length === 0) continue;
    perEnvironment.push({
      environmentId,
      environmentLabel: presentation.entry.target.label,
      sources,
    });
  }
  const labelEnvironment = perEnvironment.length > 1;
  return perEnvironment.flatMap(({ environmentId, environmentLabel, sources }) =>
    sources.map((source) => {
      const accounts = source.accounts.filter((account) => {
        const key = accountKey(account.driver, account.email);
        return key === null || !nativeAccounts.has(key);
      });
      return {
        ...source,
        accounts,
        hiddenAccountCount: source.accounts.length - accounts.length,
        environmentId,
        key: `${environmentId}:${source.id}`,
        label: labelEnvironment ? `${environmentLabel} · ${source.label}` : source.label,
      };
    }),
  );
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  plan?: string,
  limits?: ServerProviderUsageLimits,
): string | null {
  if (driver === "hermes" && limits) {
    const schedule = limits.windows.flatMap((window) => {
      if (!window.resetsAt) return [];
      const resetsAt = Date.parse(window.resetsAt);
      return Number.isFinite(resetsAt)
        ? [`${window.kind}:${window.windowDurationMins ?? ""}:${resetsAt}`]
        : [];
    });
    if (schedule.length > 0) {
      return `${driver}:schedule:${plan?.trim().toLowerCase() ?? ""}:${schedule.sort().join("|")}`;
    }
  }
  const normalizedEmail = email?.trim().toLowerCase();
  return normalizedEmail ? `${driver}:${normalizedEmail}` : null;
}

/** The instance's configured name, else the driver's, else its raw kind. */
export function providerLimitsLabel(
  provider: ServerProvider,
  driverLabel: (driver: ServerProvider["driver"]) => string | undefined,
): string {
  return provider.displayName?.trim() || driverLabel(provider.driver) || String(provider.driver);
}

/** The one-line status under a provider heading when there are no bars to draw. */
export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. The bar is the whole window, so the elapsed share
 * is also where even spending would have put the fill; within five points of
 * it counts as on pace.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  return resetsAt <= now ? "resets now" : `resets in ${formatDuration(resetsAt - now)}`;
}
