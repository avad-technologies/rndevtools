import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// The only devtools import in the app. See src/devtools/host.tsx for why that
// matters: it is the seam Metro cuts for production builds.
import { DevtoolsHost } from '@/devtools/host';

const queryClient = new QueryClient();

const laneLabel = 'B';
const apiUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function DatabaseProbe() {
	const [result, setResult] = useState('Connecting to local Supabase...');
	const [notes, setNotes] = useState<string[]>([]);
	const refresh = useCallback(async () => {
		if (!apiUrl || !publishableKey) {
			setResult('FAIL: lane did not inject the local API URL and key');
			return;
		}
		try {
			const response = await fetch(
				`${apiUrl}/rest/v1/notes?select=body&order=id`,
				{
					headers: { apikey: publishableKey },
					signal: AbortSignal.timeout(15000),
				},
			);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data: unknown = await response.json();
			if (!Array.isArray(data)) throw new Error('Expected notes array');
			const bodies = data.flatMap((row: unknown) =>
				typeof row === 'object' &&
				row !== null &&
				'body' in row &&
				typeof row.body === 'string'
					? [row.body]
					: [],
			);
			setNotes(bodies);
			const own = bodies.includes(`Lane ${laneLabel}: isolated database`);
			const other = bodies.some(
				(body) =>
					/^Lane [AB]:/.test(body) && !body.startsWith(`Lane ${laneLabel}:`),
			);
			setResult(
				own && !other
					? 'PASS: own database, no cross-lane data'
					: 'FAIL: unexpected database contents',
			);
		} catch (error) {
			setResult(
				`FAIL: ${error instanceof Error ? error.message : 'Request failed'}`,
			);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return (
		<View style={styles.probe}>
			<Text style={styles.title}>Isolated lane {laneLabel}</Text>
			<Text selectable style={styles.endpoint}>
				{apiUrl ?? 'API URL missing'}
			</Text>
			<Text
				accessibilityLabel="Database isolation result"
				style={styles.result}
			>
				{result}
			</Text>
			{notes.map((body) => (
				<Text key={body} style={styles.body}>
					{body}
				</Text>
			))}
			<Pressable
				accessibilityRole="button"
				onPress={() => {
					void refresh();
				}}
				style={styles.button}
			>
				<Text style={styles.buttonText}>Refresh database</Text>
			</Pressable>
		</View>
	);
}

export function App() {
	return (
		<GestureHandlerRootView style={styles.root}>
			<SafeAreaProvider>
				<QueryClientProvider client={queryClient}>
					<View style={styles.content}>
						<Text style={styles.body}>RN Devtools demo</Text>
						<DatabaseProbe />
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
	root: { flex: 1, backgroundColor: '#f7f8fc' },
	probe: {
		alignItems: 'center',
		gap: 16,
		padding: 24,
		borderRadius: 20,
		backgroundColor: '#ffffff',
	},
	endpoint: { fontSize: 14, fontWeight: '600', color: '#3153ab' },
	result: {
		fontSize: 17,
		fontWeight: '600',
		textAlign: 'center',
		color: '#17633d',
	},
	button: {
		paddingHorizontal: 24,
		paddingVertical: 14,
		borderRadius: 12,
		backgroundColor: '#3153ab',
	},
	buttonText: { color: '#ffffff', fontWeight: '600' },
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
