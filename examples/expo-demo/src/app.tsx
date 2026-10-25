import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// The only devtools import in the app. See src/devtools/host.tsx for why that
// matters: it is the seam Metro cuts for production builds.
import { DevtoolsHost } from '@/devtools/host';

const queryClient = new QueryClient();

export function App() {
	return (
		<GestureHandlerRootView style={styles.root}>
			<SafeAreaProvider>
				<QueryClientProvider client={queryClient}>
					<View style={styles.content}>
						<Text style={styles.title}>RN Devtools demo</Text>
						<Text style={styles.body}>
							Shake the device or tap the floating launcher to open the panels.
						</Text>
					</View>
					<DevtoolsHost queryClient={queryClient} />
				</QueryClientProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
	content: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		padding: 24,
	},
	title: { fontSize: 20, fontWeight: '600' },
	body: { fontSize: 14, opacity: 0.7, textAlign: 'center' },
});
