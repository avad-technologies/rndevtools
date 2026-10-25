const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

// SDK 57's template still starts React Native from the app delegate. iOS 27
// requires scenes; Expo already provides a scene delegate that also forwards
// launch URLs and lifecycle events to the app delegate and its subscribers.
const legacyWindowBootstrap = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

function withSceneLifecycle(config) {
	config = withInfoPlist(config, (config) => {
		config.modResults.UIApplicationSceneManifest = {
			UIApplicationSupportsMultipleScenes: false,
			UISceneConfigurations: {
				UIWindowSceneSessionRoleApplication: [
					{
						UISceneConfigurationName: 'Default Configuration',
						UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
					},
				],
			},
		};
		return config;
	});
	return withAppDelegate(config, (config) => {
		if (config.modResults.language !== 'swift') {
			throw new Error('The demo scene lifecycle requires a Swift AppDelegate.');
		}
		let contents = config.modResults.contents;
		const legacyDeclaration = 'class AppDelegate: ExpoAppDelegate {';
		const sceneDeclaration =
			'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
		if (contents.includes(legacyDeclaration)) {
			if (!contents.includes(legacyWindowBootstrap)) {
				throw new Error('The Expo AppDelegate window bootstrap changed.');
			}
			contents = contents
				.replace(legacyDeclaration, sceneDeclaration)
				.replace(legacyWindowBootstrap, '');
		} else if (!contents.includes(sceneDeclaration)) {
			throw new Error('The Expo AppDelegate declaration changed.');
		}
		config.modResults.contents = contents;
		return config;
	});
}

module.exports = withSceneLifecycle;
