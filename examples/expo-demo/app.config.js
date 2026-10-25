// Expo reads app.json first and passes its `expo` object, with defaults filled
// in, to this function as `config`. The static app.json stays the source of
// truth for the app's identity (scheme, bundle identifier) so tools that only
// read JSON, like RN Devtools lanes, see the same values; this file only adds
// settings that need Node to resolve.

/** @type {import('expo/config').ConfigContext} */
module.exports = ({ config }) => ({
	...config,
	plugins: [...(config.plugins ?? []), './plugins/with-scene-lifecycle'],
	experiments: {
		...config.experiments,
		// Share native builds across git worktrees so parallel lanes of the same
		// native shell install a cached dev client instead of rebuilding it.
		buildCacheProvider: {
			plugin: '@rndevtools/react-native/build-cache',
		},
	},
});
