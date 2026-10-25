# RN Devtools

A `pnpm` + Turborepo monorepo holding React Native diagnostics and a desktop inspector that version together.

## Workspaces

- `packages/core`: `@rndevtools/core` — panel runtime and diagnostic plugins
- `packages/react-native`: `@rndevtools/react-native` — host runtime, desktop client, Metro pruning
- `apps/desktop`: Electron inspector, local broker, and Go/Swift native helpers
- `examples/expo-demo`: runnable consumer that proves the published contract

## Instruction Model

- `AGENTS.md` is the shared Claude/Codex instruction source. Keep this file universal; put stack and workflow detail in the nearest nested `AGENTS.md`.
- Before editing a workspace from a repo-root session, read its nearest `AGENTS.md`.
- Nested `CLAUDE.md` files only import their local `AGENTS.md`.

## Core Commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm quality
```

Use the narrowest workspace command that proves a change, then run that workspace's `quality` gate. `packages/core` and `apps/desktop` share the wire contract in `desktop-protocol.ts`; verify both when it changes.

## Universal Rules

- **Nothing product-specific.** This toolkit is installed by teams whose app you have never seen. A product name, URL scheme, bundle identifier, app group, vendor header, or storage namespace belongs in an option with a neutral default, not in a source file. Test fixtures use `example.com` / `ExampleApp`. Third-party tools the toolkit integrates with (Expo, SimSlim, TanStack Query, Supabase) may be named in source; the consuming app's own identity and conventions, such as its environment variable names, may not.
- Match existing TypeScript and Biome conventions; avoid `any` unless a boundary is narrowed immediately.
- Keep changes scoped. Reuse established components, services, schemas, and helpers before adding a parallel abstraction.
- Both npm packages ship TypeScript source because Reanimated worklets must be compiled by the consuming app. Do not add a bundler without solving workletization first.
- Devtools code must never be reachable from a release bundle. `withDevtoolsPruning` and `rndevtools-verify-bundle` are a pair; weakening either breaks the guarantee that makes this safe to depend on.
- Redact and bound anything captured from a running app before it enters a store or crosses the socket. The broker is unauthenticated loopback.
- The vendored SimSlim tree and its SHA-256 provenance manifests are byte-anchored. Never edit `native/rndevtools-sim-helper/vendor/**`, the `rndevtools.1` patch artifact, or either `*_SHA256SUMS` file without following the update procedure in its `PROVENANCE.md`.
- Add or update focused tests for behavior changes. Run the relevant workspace's `quality` command before calling work complete.
- Keep commits and PRs small and use Conventional Commit messages.

## Repo Configuration

- `pnpm-workspace.yaml` holds the shared catalog and supply-chain policy (`minimumReleaseAge`, `allowBuilds`). Pin dependencies there, not in package manifests.
- Building `apps/desktop` from source requires a HeroUI Pro license and `HEROUI_AUTH_TOKEN`. Without the token `pnpm install` still succeeds but the package is not hydrated, so the desktop typecheck and build fail on a missing module; CI detects the token and skips only the Electron gate, with a notice. The two packages and the native helpers must always build without it.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
