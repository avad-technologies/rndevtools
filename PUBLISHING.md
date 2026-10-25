# Publishing

Both npm packages are versioned together and published from `main`.

```sh
# 1. Push the release commits.
git push origin main

# 2. Authenticate once (public registry, not a private mirror).
npm login --registry=https://registry.npmjs.org

# 3. Publish core first; react-native depends on it.
pnpm --filter @rndevtools/core publish --access public --registry=https://registry.npmjs.org
pnpm --filter @rndevtools/react-native publish --access public --registry=https://registry.npmjs.org
```

`pnpm publish` rewrites `workspace:` and `catalog:` protocols to concrete
versions in the published manifests.

## Consumers on local tarballs

A consumer that installed pre-release tarballs (`file:…/rndevtools-core-0.2.0.tgz`)
should switch to the published versions and drop its policy exemptions:

```sh
pnpm remove @rndevtools/core @rndevtools/react-native
pnpm add -D @rndevtools/core@^0.2.0 @rndevtools/react-native@^0.2.0
```

Then remove any `@rndevtools/*` entries from `minimumReleaseAgeExclude` /
`trustPolicyExclude` in the consumer's `pnpm-workspace.yaml` once the release
is older than that consumer's `minimumReleaseAge`.
