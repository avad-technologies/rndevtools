import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type {
	SimulatorOnboardingOperation,
	SimulatorOnboardingReceipt,
} from '../shared/simulator-protocol';
import {
	simulatorOnboardingOperationSchema,
	simulatorOnboardingReceiptSchema,
} from '../shared/simulator-protocol';
import { safeErrorText } from './security';

const MAX_PATH_BYTES = 4 * 1024;

export async function resolveXcodeDeveloperDirectory(
	applicationPath: string
): Promise<string> {
	if (
		!path.isAbsolute(applicationPath) ||
		Buffer.byteLength(applicationPath, 'utf8') > MAX_PATH_BYTES ||
		path.extname(applicationPath).toLowerCase() !== '.app'
	) {
		throw new Error('Select an Xcode application bundle.');
	}
	const application = await realpath(applicationPath);
	const applicationMetadata = await lstat(application);
	if (
		!applicationMetadata.isDirectory() ||
		applicationMetadata.isSymbolicLink()
	) {
		throw new Error('The selected Xcode application is not a real directory.');
	}
	const developerDirectory = await realpath(
		path.join(application, 'Contents', 'Developer')
	);
	const relativeDeveloperDirectory = path.relative(
		application,
		developerDirectory
	);
	if (
		!relativeDeveloperDirectory ||
		relativeDeveloperDirectory.startsWith('..') ||
		path.isAbsolute(relativeDeveloperDirectory)
	) {
		throw new Error(
			'The selected Xcode developer directory escaped its application.'
		);
	}
	const developerMetadata = await lstat(developerDirectory);
	if (!developerMetadata.isDirectory() || developerMetadata.isSymbolicLink()) {
		throw new Error(
			'The selected application has no valid Xcode developer directory.'
		);
	}
	await access(
		path.join(developerDirectory, 'usr', 'bin', 'xcodebuild'),
		constants.X_OK
	);
	return developerDirectory;
}

export async function validateXcodeDeveloperDirectory(
	developerDirectoryPath: string
): Promise<string> {
	if (
		!path.isAbsolute(developerDirectoryPath) ||
		Buffer.byteLength(developerDirectoryPath, 'utf8') > MAX_PATH_BYTES
	) {
		throw new Error('The stored Xcode developer directory is invalid.');
	}
	const developerDirectory = await realpath(developerDirectoryPath);
	const applicationPath = path.dirname(path.dirname(developerDirectory));
	const resolved = await resolveXcodeDeveloperDirectory(applicationPath);
	if (resolved !== developerDirectory) {
		throw new Error(
			'The stored Xcode developer directory changed unexpectedly.'
		);
	}
	return resolved;
}

type SimulatorOnboardingIpcDependencies = {
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	selectXcodeApplication: (
		event: IpcMainInvokeEvent
	) => Promise<string | undefined>;
	activateXcodeDeveloperDirectory: (
		developerDirectory: string
	) => Promise<void>;
	openPrivacySettings: (
		permission: Extract<
			SimulatorOnboardingOperation,
			{ kind: 'privacy.openSettings' }
		>['permission']
	) => Promise<void>;
	revealAgentCli: () => Promise<void>;
	/** Runs `rndevtools setup` and returns its per-file outcome lines. */
	setupAgentCli: () => Promise<string[]>;
};

function failed(
	operation: SimulatorOnboardingOperation,
	error: unknown
): SimulatorOnboardingReceipt {
	return simulatorOnboardingReceiptSchema.parse({
		actionId: operation.actionId,
		kind: operation.kind,
		completed: false,
		error: safeErrorText(error),
	});
}

export function createSimulatorOnboardingIpcHandlers({
	assertTrustedRenderer,
	selectXcodeApplication,
	activateXcodeDeveloperDirectory,
	openPrivacySettings,
	revealAgentCli,
	setupAgentCli,
}: SimulatorOnboardingIpcDependencies) {
	return {
		runOperation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<SimulatorOnboardingReceipt> => {
			assertTrustedRenderer(event);
			const operation = simulatorOnboardingOperationSchema.parse(value);
			try {
				if (operation.kind === 'toolchain.selectXcode') {
					const applicationPath = await selectXcodeApplication(event);
					if (!applicationPath) {
						return simulatorOnboardingReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
						});
					}
					const developerDirectory =
						await resolveXcodeDeveloperDirectory(applicationPath);
					await activateXcodeDeveloperDirectory(developerDirectory);
					return simulatorOnboardingReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						requiresRefresh: true,
					});
				}
				if (operation.kind === 'agentCli.setup') {
					const summary = await setupAgentCli();
					return simulatorOnboardingReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						summary: summary
							.slice(0, 32)
							.map((line) => line.slice(0, 4 * 1024)),
					});
				}
				if (operation.kind === 'privacy.openSettings') {
					await openPrivacySettings(operation.permission);
				} else {
					await revealAgentCli();
				}
				return simulatorOnboardingReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
				});
			} catch (error) {
				return failed(operation, error);
			}
		},
	};
}
