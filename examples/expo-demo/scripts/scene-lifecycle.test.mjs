import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const withSceneLifecycle = require('../plugins/with-scene-lifecycle');

const legacyBootstrap = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

const legacyDelegate = `import Expo
class AppDelegate: ExpoAppDelegate {
  var reactNativeFactory: RCTReactNativeFactory?
  func launch() {
${legacyBootstrap}  }
}
`;

async function appDelegate(contents, language = 'swift') {
	const config = withSceneLifecycle({
		name: 'ExampleApp',
		slug: 'example-app',
	});
	const result = await config.mods.ios.appDelegate({
		...config,
		modResults: { contents, language, path: 'AppDelegate.swift' },
		modRequest: {},
	});
	return result.modResults.contents;
}

test('moves the Expo window bootstrap to its scene delegate and is idempotent', async () => {
	const contents = await appDelegate(legacyDelegate);
	assert.match(contents, /ExpoAppDelegate, ExpoReactNativeFactoryProvider/);
	assert.doesNotMatch(contents, /window = UIWindow|factory.startReactNative/);
	assert.match(contents, /var reactNativeFactory: RCTReactNativeFactory\?/);
	assert.equal(await appDelegate(contents), contents);
});

test('configures the Expo scene delegate while preserving unrelated plist values', async () => {
	const config = withSceneLifecycle({
		name: 'ExampleApp',
		slug: 'example-app',
	});
	const result = await config.mods.ios.infoPlist({
		...config,
		modResults: { CFBundleDisplayName: 'ExampleApp' },
		modRequest: {},
	});
	assert.equal(result.modResults.CFBundleDisplayName, 'ExampleApp');
	assert.deepEqual(result.modResults.UIApplicationSceneManifest, {
		UIApplicationSupportsMultipleScenes: false,
		UISceneConfigurations: {
			UIWindowSceneSessionRoleApplication: [
				{
					UISceneConfigurationName: 'Default Configuration',
					UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
				},
			],
		},
	});
});

test('refuses an unknown template instead of leaving a partial scene migration', async () => {
	await assert.rejects(
		appDelegate(legacyDelegate.replace(legacyBootstrap, '')),
		/window bootstrap changed/,
	);
	await assert.rejects(
		appDelegate(
			legacyDelegate.replace('class AppDelegate:', 'class RenamedDelegate:'),
		),
		/declaration changed/,
	);
	await assert.rejects(
		appDelegate(legacyDelegate, 'objc'),
		/requires a Swift AppDelegate/,
	);
});
