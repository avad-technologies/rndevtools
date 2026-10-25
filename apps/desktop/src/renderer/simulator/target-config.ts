/**
 * Hints about the app being debugged.
 *
 * Nothing here changes behaviour: these values only supply placeholder text and
 * default field values in the Simulator panels. They live in one module so a
 * team can point the desktop app at their own product by editing a single file
 * rather than hunting through panel components.
 */
export type DevtoolsTargetConfig = {
	/** Example deep link, shown as the URL field placeholder. */
	readonly deepLinkExample: string;
	/** Example App Group container id for the "Reveal app group" action. */
	readonly appGroupExample: string;
	/** Default name template when creating simulators in bulk. */
	readonly deviceNameTemplate: string;
};

export const targetConfig: DevtoolsTargetConfig = Object.freeze({
	deepLinkExample: 'myapp://home',
	appGroupExample: 'group.com.example.app',
	deviceNameTemplate: 'Example Test',
});
