<img src="apps/desktop/build/icon.png" alt="RN Devtools app icon" width="80" height="80" />

# RN Devtools

A desktop workspace for React Native diagnostics, iOS Simulators, and parallel development across git worktrees.

**[Download the macOS preview](https://github.com/avad-technologies/rndevtools/releases/download/desktop-v0.2.0/RN-Devtools-0.2.0-arm64.dmg)** · Apple silicon · Version 0.2.0

Signed and notarized. No HeroUI account or license is needed to run the app. [Release notes and checksums](https://github.com/avad-technologies/rndevtools/releases/tag/desktop-v0.2.0).

![RN Devtools Simulator fleet and worktree lanes](docs/images/simulator-fleet.png)

## Features

- **Parallel Simulator lanes.** Give each worktree its own Simulator and Metro port. Reuse native builds when fingerprints match.
- **Local Supabase per worktree.** Manage native Postgres, REST, Auth, Storage, Realtime, and Functions. Inspect services, logs, and migrations. This integration is alpha.
- **Connected app diagnostics.** Inspect network requests, console output, storage, React Query, Zustand, navigation, performance, environment, and components.
- **Simulator automation.** Control apps, deep links, and permissions; capture screenshots and recordings; run recipes through the desktop app, bundled CLI, or MCP.
- **Experimental SimSlim profiles.** Reduce background Simulator services with compatibility checks, verification, checkpoints, and undo.

![Local Supabase stacks and their Simulator lanes](docs/images/local-supabase.png)

![Connected app network inspector](docs/images/network-inspector.png)

## Install

Open the DMG, drag **RN Devtools** into **Applications**, and launch it.

| Feature | Requires |
| --- | --- |
| Desktop app | Apple silicon Mac with macOS 14 or later |
| Simulator management | Xcode and an installed iOS Simulator runtime |
| Worktree lanes | Git, Node.js, project dependencies, and a compatible Expo development build installed on each Simulator |
| Local Supabase | The project's pinned Supabase CLI with the native runtime |
| Connected diagnostics | An app using the [React Native host integration](packages/react-native/README.md) |

Local Supabase uses separate databases with shared default signing keys. Enable **per-stack keys** for JWT signing isolation. See the [Supabase setup guide](apps/desktop/README.md#local-supabase-per-worktree-alpha).

## Try the demo

The [Expo example](examples/expo-demo/README.md) includes diagnostic plugins, the desktop connection, native build caching, and a local Supabase project. Use Node.js 24, pnpm 12.4.1, and Xcode:

```sh
git clone https://github.com/avad-technologies/rndevtools.git
cd rndevtools
pnpm install
pnpm --dir examples/expo-demo exec expo run:ios
```

Open RN Devtools alongside the demo. To connect your own app, follow the [React Native integration guide](packages/react-native/README.md).

## Build the desktop app from source

Source builds use Node.js 24, pnpm 12.4.1, Go 1.27, and Xcode's Swift toolchain. **Desktop source builders need a [HeroUI Pro](https://heroui.pro/) license and `HEROUI_AUTH_TOKEN`.** The React Native packages and the demo do not.

```sh
pnpm install
pnpm --filter @rndevtools/desktop native:build
pnpm --filter @rndevtools/desktop dev
```

Simulator mutations require a signed packaged app. See the [release guide](docs/RELEASING.md) for signing and packaging and the [desktop guide](apps/desktop/README.md) for development.

Package guides: [Core diagnostics](packages/core/README.md) · [React Native integration](packages/react-native/README.md).

## License and credits

[MIT](LICENSE). The Simulator helper includes [SimSlim](https://github.com/MobAI-App/simslim), also MIT. See [third-party notices](apps/desktop/THIRD_PARTY_NOTICES.md) and the helper's [provenance](apps/desktop/native/rndevtools-sim-helper/PROVENANCE.md).
