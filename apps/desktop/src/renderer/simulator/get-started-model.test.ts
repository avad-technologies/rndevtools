import { describe, expect, it } from 'vitest';
import {
	type GetStartedInput,
	getStartedProgress,
	getStartedTasks,
	macChecks,
} from './get-started-model';

const fresh: GetStartedInput = {
	capability: {
		status: 'checking',
		runtimeAvailability: { available: 0 },
	},
	repositories: [],
	worktreeCount: 0,
	bootedCount: 0,
	appSessionCount: 0,
	laneCount: 0,
	supabase: { running: 0 },
	captureCount: 0,
	recipeCount: 0,
};

describe('Get started tasks', () => {
	it('starts with nothing done and the Mac check next', () => {
		const tasks = getStartedTasks(fresh);
		expect(tasks.map((task) => task.id)).toEqual([
			'check-mac',
			'add-project',
			'boot-simulator',
			'connect-app',
			'start-lane',
			'local-supabase',
			'record-capture',
			'automate-recipe',
		]);
		expect(getStartedProgress(tasks)).toMatchObject({
			done: 0,
			total: 8,
			complete: false,
			next: { id: 'check-mac' },
		});
	});

	it('derives each task from what the runtimes report', () => {
		const tasks = getStartedTasks({
			...fresh,
			capability: {
				status: 'available',
				xcodeVersion: '27.0',
				runtimeAvailability: { available: 1 },
			},
			repositories: ['/Users/dev/code/example-app'],
			worktreeCount: 3,
			bootedCount: 1,
		});
		expect(tasks.find((task) => task.id === 'check-mac')).toMatchObject({
			done: true,
			detail: 'Xcode 27.0 and 1 iOS runtime found',
		});
		expect(tasks.find((task) => task.id === 'add-project')).toMatchObject({
			done: true,
			detail: '~/code/example-app · 3 worktrees',
		});
		expect(getStartedProgress(tasks)).toMatchObject({
			done: 3,
			next: { id: 'connect-app' },
		});
	});

	it('leaves out local Supabase where this Mac cannot run it', () => {
		const tasks = getStartedTasks({ ...fresh, supabase: undefined });
		expect(tasks.some((task) => task.id === 'local-supabase')).toBe(false);
		expect(tasks).toHaveLength(7);
	});

	it('is complete once every task is done', () => {
		const tasks = getStartedTasks({
			capability: {
				status: 'available',
				runtimeAvailability: { available: 2 },
			},
			repositories: ['/work/app'],
			worktreeCount: 1,
			bootedCount: 2,
			appSessionCount: 1,
			laneCount: 1,
			supabase: { running: 1 },
			captureCount: 4,
			recipeCount: 1,
		});
		expect(getStartedProgress(tasks)).toMatchObject({
			done: 8,
			complete: true,
			next: undefined,
		});
		expect(tasks[0]?.detail).toBe('Xcode and 2 iOS runtimes found');
	});
});

describe('macChecks', () => {
	const ready = {
		capability: {
			status: 'available' as const,
			xcodeVersion: '27.0',
			selectedDeveloperDirectoryLabel: 'Xcode.app',
			licenseStatus: 'accepted' as const,
			features: { deviceManagement: true },
		},
		runtimes: [
			{ name: 'iOS 27.0', isAvailable: true },
			{ name: 'iOS 26.4', isAvailable: false },
		],
		native: { status: 'available' as const, helperVersion: '1.2.0' },
	};

	it('reports a ready Mac from discovery', () => {
		expect(macChecks(ready)).toEqual([
			{
				id: 'xcode',
				name: 'Xcode',
				detail: '27.0 · Xcode.app',
				state: 'ready',
			},
			{
				id: 'runtime',
				name: 'iOS Simulator runtime',
				detail: 'iOS 27.0',
				state: 'ready',
			},
			{
				id: 'control',
				name: 'Simulator control',
				detail: 'simctl responds',
				state: 'ready',
			},
			{
				id: 'helper',
				name: 'Signed native helper',
				detail: 'Version 1.2.0',
				state: 'ready',
			},
		]);
	});

	it('offers to choose Xcode, and asks for the license only when needed', () => {
		const checks = macChecks({
			...ready,
			capability: {
				...ready.capability,
				status: 'unavailable',
				xcodeVersion: undefined,
				licenseStatus: 'required',
				features: { deviceManagement: false },
			},
			runtimes: [],
			native: { status: 'unavailable' },
		});
		expect(checks.find((check) => check.id === 'xcode')).toMatchObject({
			state: 'check',
			fix: 'select-xcode',
		});
		expect(checks.find((check) => check.id === 'license')?.state).toBe('check');
		expect(checks.find((check) => check.id === 'helper')?.state).toBe(
			'optional'
		);
		expect(macChecks(ready).some((check) => check.id === 'license')).toBe(
			false
		);
	});

	it('says it is still checking while discovery runs', () => {
		const checks = macChecks({
			...ready,
			capability: {
				...ready.capability,
				status: 'checking',
				xcodeVersion: undefined,
				features: { deviceManagement: false },
			},
			runtimes: [],
			native: { status: 'checking' },
		});
		expect(checks.every((check) => check.state === 'checking')).toBe(true);
	});
});
