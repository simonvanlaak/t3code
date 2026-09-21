# Private Hermes-enabled build

This branch adds Hermes Agent to T3 Code through `hermes acp` on top of the complete experimental Orchestration V2 stack, including durable run lifecycle, replay/recovery, and native web/mobile subagent projections.

## Build

Install Vite+ and dependencies, then run the focused checks and package the Linux desktop app:

```bash
curl -fsSL https://vite.plus | VP_NODE_MANAGER=no bash
. ~/.config/vite-plus/env
vp i
vp test run \
  apps/server/src/orchestration-v2/Adapters/HermesAdapterV2.test.ts \
  apps/server/src/provider/acp/HermesAcpExtension.test.ts \
  apps/server/src/provider/Layers/HermesProvider.test.ts \
  apps/server/src/provider/acp/HermesAcpSupport.test.ts \
  apps/server/src/textGeneration/HermesTextGeneration.test.ts \
  apps/server/src/serverSettings.test.ts \
  packages/contracts/src/settings.test.ts
T3_HERMES_ACP_PROBE=1 vp test run apps/server/src/provider/acp/HermesAcpCliProbe.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run build:desktop
scripts/seed-t3code-hermes-linux-helpers.sh
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS=true \
node scripts/build-desktop-artifact.ts \
  --platform linux --target AppImage --arch x64 \
  --build-version 0.0.38-hermes-v2.1 --skip-build
```

The AppImage is written under `release/`.

## Side-by-side user installation

The installer extracts the AppImage under `~/.local/opt/t3code-hermes` and creates `~/.local/bin/t3code-hermes` without touching the official package:

```bash
scripts/install-t3code-hermes-user.sh release/T3-Code-0.0.38-hermes-v2.1-x86_64.AppImage
```

The launcher always sets:

```text
T3CODE_HOME=~/.t3-hermes
T3CODE_PORT=3774
T3CODE_DISABLE_AUTO_UPDATE=true
XDG_CONFIG_HOME=~/.config/t3code-hermes
```

Override the state location with `T3CODE_HERMES_HOME`. Never point it at `~/.t3` while testing this fork.

Enable Hermes in **Settings → Providers → Hermes**. The binary defaults to `hermes`; set an absolute path if the desktop environment cannot resolve the login-shell PATH.

## Remote-only desktop with agents on clanker

The x1 installation is configured as a remote-only control surface. Its local environment is off. A user service forwards `127.0.0.1:36096` on x1 to the private server at `127.0.0.1:3774` on clanker, and the desktop saves that endpoint as the `clanker` environment.

The clanker server is installed separately under `~/.local/opt/t3code-hermes-server`, launched by `~/.local/bin/t3-hermes`, and stores all private-fork state under `~/.t3-hermes`. It does not replace the existing server on port 3773 or write to `~/.t3`.

Build its archive after `build:desktop` and `build:exe`:

```bash
vp run --filter t3 build:exe
node scripts/build-cli-archive.ts \
  --platform linux --arch x64 \
  --version 0.0.38-hermes-v2.1 \
  --output-dir release \
  --resource-monitor-dir /usr/lib/t3code/resources/resource-monitor
```

Native addons must match the remote libc. The Arch-built `node-pty` binary requires a newer glibc than clanker, so deployment replaces it with clanker's existing T3 `pty.node` before starting the private service.

Hermes on clanker intentionally runs with `approvals.mode: off`; T3's Supervised setting does not override that global Hermes policy. This is the expected yolo workflow.

## Arch package

Copy the built AppImage into the package directory and build it:

```bash
cp release/T3-Code-0.0.38-hermes-v2.1-x86_64.AppImage packaging/t3code-hermes/T3-Code-Hermes.AppImage
cd packaging/t3code-hermes
makepkg -f
```

The resulting `t3code-hermes-*.pkg.tar.zst` installs beside `t3code-bin` and uses the same isolated launcher environment.

## Updating

Fetch an upstream release tag, create a branch from it, merge or cherry-pick the Hermes provider commits, and rerun every check above. Do not let the private build track upstream automatically: T3's provider and orchestration boundaries change frequently.

## Rollback

The official `t3code` and `t3` commands are never replaced. To revert a user-local update or remove the private launcher:

```bash
scripts/rollback-t3code-hermes-user.sh
```

The script restores the previous private installation when one exists. Otherwise it removes only the private app and launcher. It intentionally retains `~/.t3-hermes`.
