jest.mock('./images', () => {
	throw new Error(
		'The shared plugins entry point must not load image diagnostics',
	);
});

jest.mock('./storage', () => {
	throw new Error(
		'The shared plugins entry point must not load the storage editor',
	);
});

it('loads the shared plugin factories without the image and storage subpaths', () => {
	const plugins = jest.requireActual<typeof import('./index')>(
		'@rndevtools/core/plugins',
	);

	expect(plugins).toEqual(
		expect.objectContaining({
			createLazyCustomPlugin: expect.any(Function),
			createNetworkPlugin: expect.any(Function),
			createQueryPlugin: expect.any(Function),
		}),
	);
});
