jest.mock('react-native-safe-area-context', () => {
	const actual = jest.requireActual('react-native-safe-area-context');
	return {
		...actual,
		initialWindowMetrics: {
			frame: { x: 0, y: 0, width: 402, height: 874 },
			insets: { top: 47, right: 0, bottom: 34, left: 0 },
		},
		useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
	};
});
