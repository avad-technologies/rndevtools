import { shortPath } from '@/simulator/fleet-model';

export type GetStartedTaskId =
	| 'check-mac'
	| 'add-project'
	| 'boot-simulator'
	| 'connect-app'
	| 'start-lane'
	| 'local-supabase'
	| 'record-capture'
	| 'automate-recipe';

export type GetStartedTask = Readonly<{
	id: GetStartedTaskId;
	group: 'start' | 'beyond';
	title: string;
	detail: string;
	done: boolean;
	tag?: string;
}>;

/** What the checklist reads from the runtimes; every task is derived, never stored. */
export type GetStartedInput = Readonly<{
	capability: Readonly<{
		status: 'checking' | 'available' | 'unavailable';
		xcodeVersion?: string | undefined;
		runtimeAvailability: Readonly<{ available: number }>;
	}>;
	repositories: readonly string[];
	worktreeCount: number;
	bootedCount: number;
	appSessionCount: number;
	laneCount: number;
	/** Absent where this Mac cannot run local Supabase, so the task is left out. */
	supabase?: Readonly<{ running: number }> | undefined;
	captureCount: number;
	recipeCount: number;
}>;

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function getStartedTasks(input: GetStartedInput): GetStartedTask[] {
	const { capability } = input;
	const macReady = capability.status === 'available';
	const xcode = capability.xcodeVersion
		? `Xcode ${capability.xcodeVersion}`
		: 'Xcode';
	const repository = input.repositories[0];
	const tasks: GetStartedTask[] = [
		{
			id: 'check-mac',
			group: 'start',
			title: 'Check your Mac',
			detail: macReady
				? `${xcode} and ${plural(capability.runtimeAvailability.available, 'iOS runtime')} found`
				: 'Find Xcode and an iOS Simulator runtime',
			done: macReady,
		},
		{
			id: 'add-project',
			group: 'start',
			title: 'Add your project',
			detail: repository
				? `${shortPath(repository)} · ${plural(input.worktreeCount, 'worktree')}`
				: 'Pick the repository you work in',
			done: repository !== undefined,
		},
		{
			id: 'boot-simulator',
			group: 'start',
			title: 'Boot a Simulator',
			detail:
				input.bootedCount > 0
					? `${plural(input.bootedCount, 'Simulator')} booted`
					: 'Pick a device to run your app on',
			done: input.bootedCount > 0,
		},
		{
			id: 'connect-app',
			group: 'start',
			title: 'Connect your app',
			detail:
				input.appSessionCount > 0
					? `${plural(input.appSessionCount, 'app')} connected`
					: 'Add @rndevtools/react-native to see network, logs and state',
			done: input.appSessionCount > 0,
		},
		{
			id: 'start-lane',
			group: 'beyond',
			title: 'Start a lane for a worktree',
			detail:
				input.laneCount > 0
					? `${plural(input.laneCount, 'lane')} running`
					: 'Its own Simulator and Metro port, side by side',
			done: input.laneCount > 0,
		},
	];
	if (input.supabase) {
		tasks.push({
			id: 'local-supabase',
			group: 'beyond',
			title: 'Run a local Supabase stack',
			detail:
				input.supabase.running > 0
					? `${plural(input.supabase.running, 'stack')} running`
					: 'One backend per lane',
			done: input.supabase.running > 0,
			tag: 'Alpha',
		});
	}
	tasks.push(
		{
			id: 'record-capture',
			group: 'beyond',
			title: 'Record a capture',
			detail:
				input.captureCount > 0
					? `${plural(input.captureCount, 'capture')} saved`
					: 'Screenshots and recordings of a Simulator',
			done: input.captureCount > 0,
		},
		{
			id: 'automate-recipe',
			group: 'beyond',
			title: 'Automate with a recipe',
			detail:
				input.recipeCount > 0
					? `${plural(input.recipeCount, 'recipe')} saved`
					: 'Repeatable Simulator setup for you or an agent',
			done: input.recipeCount > 0,
		}
	);
	return tasks;
}

export function getStartedProgress(tasks: readonly GetStartedTask[]): {
	done: number;
	total: number;
	/** The first task not done yet, getting-started tasks first. */
	next: GetStartedTask | undefined;
	complete: boolean;
} {
	const done = tasks.filter((task) => task.done).length;
	return {
		done,
		total: tasks.length,
		next: tasks.find((task) => !task.done),
		complete: done === tasks.length,
	};
}

export type MacCheck = Readonly<{
	id: 'xcode' | 'license' | 'runtime' | 'control' | 'helper';
	name: string;
	detail: string;
	state: 'ready' | 'check' | 'checking' | 'optional';
	/** A fix setup can run itself; the rest say what to do. */
	fix?: 'select-xcode';
}>;

/** Setup's Check your Mac rows, from what Simulator discovery reported. */
export function macChecks(input: {
	capability: Readonly<{
		status: 'checking' | 'available' | 'unavailable';
		xcodeVersion?: string | undefined;
		selectedDeveloperDirectoryLabel?: string | undefined;
		licenseStatus: 'accepted' | 'required' | 'unknown';
		features: Readonly<{ deviceManagement: boolean }>;
	}>;
	runtimes: readonly Readonly<{ name: string; isAvailable: boolean }>[];
	native: Readonly<{
		status: 'checking' | 'available' | 'unavailable' | 'untrusted';
		helperVersion?: string | undefined;
	}>;
}): MacCheck[] {
	const { capability, native } = input;
	const checking = capability.status === 'checking';
	const runtimes = input.runtimes.filter((runtime) => runtime.isAvailable);
	const checks: MacCheck[] = [
		capability.xcodeVersion
			? {
					id: 'xcode',
					name: 'Xcode',
					detail: [
						capability.xcodeVersion,
						capability.selectedDeveloperDirectoryLabel,
					]
						.filter(Boolean)
						.join(' · '),
					state: 'ready',
				}
			: checking
				? {
						id: 'xcode',
						name: 'Xcode',
						detail: 'Looking for Xcode',
						state: 'checking',
					}
				: {
						id: 'xcode',
						name: 'Xcode',
						detail: 'Choose the Xcode you use',
						state: 'check',
						fix: 'select-xcode',
					},
	];
	if (capability.licenseStatus === 'required') {
		checks.push({
			id: 'license',
			name: 'Xcode license',
			detail: 'Accept it in Terminal with sudo xcodebuild -license',
			state: 'check',
		});
	}
	checks.push(
		runtimes.length > 0
			? {
					id: 'runtime',
					name: 'iOS Simulator runtime',
					detail: runtimes
						.slice(0, 2)
						.map((runtime) => runtime.name)
						.join(', '),
					state: 'ready',
				}
			: {
					id: 'runtime',
					name: 'iOS Simulator runtime',
					detail: checking
						? 'Looking for runtimes'
						: 'Install one in Xcode › Settings › Components',
					state: checking ? 'checking' : 'check',
				},
		capability.features.deviceManagement
			? {
					id: 'control',
					name: 'Simulator control',
					detail: 'simctl responds',
					state: 'ready',
				}
			: {
					id: 'control',
					name: 'Simulator control',
					detail: checking
						? 'Checking simctl'
						: 'Works once Xcode and a runtime are ready',
					state: checking ? 'checking' : 'check',
				},
		native.status === 'available'
			? {
					id: 'helper',
					name: 'Signed native helper',
					detail: native.helperVersion
						? `Version ${native.helperVersion}`
						: 'Signature verified',
					state: 'ready',
				}
			: native.status === 'untrusted'
				? {
						id: 'helper',
						name: 'Signed native helper',
						detail: 'Its signature did not verify; reinstall RN Devtools',
						state: 'check',
					}
				: {
						id: 'helper',
						name: 'Signed native helper',
						detail:
							native.status === 'checking'
								? 'Checking the bundled helper'
								: 'Optional: captures, SimSlim and live screens use it',
						state: native.status === 'checking' ? 'checking' : 'optional',
					}
	);
	return checks;
}
