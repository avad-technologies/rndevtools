import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	type SimulatorInput,
	type SimulatorInputResult,
	simulatorInputResultSchema,
	simulatorInputSchema,
} from '../shared/simulator-input-protocol';
import {
	type CaptureCompositionRecipe,
	captureCompositionRecipeSchema,
	type SimulatorNativeState,
	simulatorNativeCapabilitiesSchema,
} from '../shared/simulator-protocol';
import {
	NativeHelperTrustError,
	type VerifiedNativeHelper,
	verifyNativeHost,
} from './native-helper-trust';
import { ensurePrivateDirectory } from './private-files';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from './simulator-command-runner';

const INSPECTION_PROTOCOL_VERSION = 2;
const COMPOSITION_PROTOCOL_VERSION = 3;
const MUTATION_BROKER_PROTOCOL_VERSION = 4;
const SIMULATOR_INPUT_PROTOCOL_VERSION = 5;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MUTATION_BROKER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COMPOSITION_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_COMPOSITION_OUTPUT_BYTES = 64 * 1024 * 1024;
const identifierSchema = z.string().trim().min(1).max(256);

const permissionStatusSchema = z.strictObject({
	statuses: z
		.array(
			z.strictObject({
				id: z.enum([
					'accessibility',
					'screen_recording',
					'camera',
					'microphone',
				]),
				value: z.enum([
					'granted',
					'denied',
					'restricted',
					'not_determined',
					'not_granted',
					'unknown',
				]),
				canPrompt: z.literal(false),
			})
		)
		.max(4),
});

const handshakeSchema = z.strictObject({
	helperVersion: z.string().trim().min(1).max(128),
	protocolVersion: z.literal(INSPECTION_PROTOCOL_VERSION),
	capabilities: z.strictObject({
		operations: z
			.array(z.enum(['handshake', 'permission_status', 'capability_status']))
			.length(3),
		permissionInspection: z.literal(true),
		permissionPrompting: z.literal(false),
		simulatorMutation: z.literal(false),
		runtimeDownloads: z.literal(false),
		capabilityInspection: z.literal(true),
		liveCaptureSessions: z.literal(false),
	}),
});

const compositionHandshakeSchema = z.strictObject({
	helperVersion: z.string().trim().min(1).max(128),
	protocolVersion: z.literal(COMPOSITION_PROTOCOL_VERSION),
	capabilities: z.strictObject({
		operations: z
			.array(
				z.enum([
					'handshake',
					'permission_status',
					'capability_status',
					'compose_image',
				])
			)
			.length(4),
		permissionInspection: z.literal(true),
		permissionPrompting: z.literal(false),
		simulatorMutation: z.literal(false),
		runtimeDownloads: z.literal(false),
		capabilityInspection: z.literal(true),
		liveCaptureSessions: z.literal(false),
		imageComposition: z.literal(true),
	}),
});

const mutationBrokerResultSchema = z.strictObject({
	helperResponse: z.string().max(4 * 1024 * 1024),
});

const responseSchema = z.union([
	z.strictObject({
		protocolVersion: z.union([
			z.literal(INSPECTION_PROTOCOL_VERSION),
			z.literal(COMPOSITION_PROTOCOL_VERSION),
			z.literal(MUTATION_BROKER_PROTOCOL_VERSION),
			z.literal(SIMULATOR_INPUT_PROTOCOL_VERSION),
		]),
		requestId: identifierSchema,
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.strictObject({
		protocolVersion: z.union([
			z.literal(INSPECTION_PROTOCOL_VERSION),
			z.literal(COMPOSITION_PROTOCOL_VERSION),
			z.literal(MUTATION_BROKER_PROTOCOL_VERSION),
			z.literal(SIMULATOR_INPUT_PROTOCOL_VERSION),
		]),
		requestId: identifierSchema,
		ok: z.literal(false),
		error: z.strictObject({
			code: identifierSchema,
			message: z.string().max(4 * 1024),
			retryable: z.boolean(),
		}),
	}),
]);

const compositionResultSchema = z.strictObject({
	operation: z.literal('compose_image'),
	outputName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	outputFormat: z.enum(['png', 'jpeg']),
	width: z.number().int().positive().max(8_192),
	height: z.number().int().positive().max(8_192),
	byteCount: z.number().int().positive().max(MAX_COMPOSITION_OUTPUT_BYTES),
	inputCount: z.union([z.literal(1), z.literal(2)]),
	composition: z.enum(['single', 'side_by_side', 'opacity', 'difference']),
	metadataRendered: z.boolean(),
	bezelStyle: z.enum(['none', 'rndevtools-generic-v1']),
	atomicCommit: z.literal(true),
});

export type NativeImageCompositionInput = {
	primaryPath: string;
	secondaryPath?: string;
	outputPath: string;
	recipe: CaptureCompositionRecipe;
};

type Runner = typeof runSimulatorCommand;
type Verifier = typeof verifyNativeHost;

function assertOwnedFile(
	metadata: Awaited<ReturnType<typeof lstat>>,
	label: string
): void {
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error(`${label} must be a regular local file.`);
	}
	const userId = process.getuid?.();
	if (userId !== undefined && metadata.uid !== userId) {
		throw new Error(`${label} must be owned by the current user.`);
	}
}

/** A private image-composition directory that the current user owns. */
function compositionDirectory(
	directory: string,
	{ recursive }: { recursive: boolean }
): Promise<string> {
	return ensurePrivateDirectory(directory, 'Image-composition storage', {
		recursive,
		ownedByUser: true,
	});
}

/**
 * Copies a regular file the current user owns into a new 0600 file, refusing
 * one that is empty, over `maxBytes`, not `expectedBytes` long when that is
 * given, or that changes while it is read.
 */
async function copyOwnedFile(
	sourcePath: string,
	destinationPath: string,
	{
		label,
		maxBytes,
		expectedBytes,
		rejectedMessage,
		changedMessage,
	}: {
		label: string;
		maxBytes: number;
		expectedBytes?: number;
		rejectedMessage: string;
		changedMessage: string;
	}
): Promise<void> {
	const metadata = await lstat(sourcePath);
	assertOwnedFile(metadata, label);
	if (
		metadata.size <= 0 ||
		metadata.size > maxBytes ||
		(expectedBytes !== undefined && metadata.size !== expectedBytes)
	) {
		throw new Error(rejectedMessage);
	}
	const source = await open(
		sourcePath,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
	);
	let destination: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const openedMetadata = await source.stat();
		assertOwnedFile(openedMetadata, label);
		if (openedMetadata.size !== metadata.size) {
			throw new Error(changedMessage);
		}
		const data = await source.readFile();
		if (data.byteLength !== metadata.size) {
			throw new Error(changedMessage);
		}
		destination = await open(
			destinationPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600
		);
		await destination.writeFile(data);
		await destination.sync();
	} finally {
		await Promise.allSettled([source.close(), destination?.close()]);
	}
}

function stageImage(
	sourcePath: string,
	destinationPath: string
): Promise<void> {
	return copyOwnedFile(sourcePath, destinationPath, {
		label: 'Capture input',
		maxBytes: MAX_COMPOSITION_INPUT_BYTES,
		rejectedMessage: 'Capture input exceeds the 32 MiB composition limit.',
		changedMessage: 'Capture input changed while it was being staged.',
	});
}

/**
 * A failure the signed native host reported itself, as opposed to a spawn or
 * transport failure. The host's code stays attached so a refused attestation
 * can be told apart from a helper that died mid-operation.
 */
export class NativeHostResponseError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable: boolean) {
		super(message);
		this.name = 'NativeHostResponseError';
		this.code = code;
		this.retryable = retryable;
	}
}

export class NativeHostClient {
	readonly #resourceDirectory: string;
	readonly #appVersion: string;
	readonly #compositionWorkspaceDirectory: string | undefined;
	readonly #runner: Runner;
	readonly #verifier: Verifier;
	#verified: Promise<VerifiedNativeHelper> | undefined;

	constructor({
		resourceDirectory,
		appVersion,
		compositionWorkspaceDirectory,
		runner = runSimulatorCommand,
		verifier = verifyNativeHost,
	}: {
		resourceDirectory: string;
		appVersion: string;
		compositionWorkspaceDirectory?: string;
		runner?: Runner;
		verifier?: Verifier;
	}) {
		this.#resourceDirectory = resourceDirectory;
		this.#appVersion = appVersion;
		this.#compositionWorkspaceDirectory = compositionWorkspaceDirectory;
		this.#runner = runner;
		this.#verifier = verifier;
	}

	async inspectPermissions(
		signal?: AbortSignal
	): Promise<SimulatorNativeState> {
		const [handshake, compositionHandshake] = await Promise.all([
			this.#call('handshake', signal).then((value) =>
				handshakeSchema.parse(value)
			),
			this.#call('handshake', signal, {
				protocolVersion: COMPOSITION_PROTOCOL_VERSION,
			}).then((value) => compositionHandshakeSchema.parse(value)),
		]);
		const verified = await this.#verified;
		if (
			!verified ||
			handshake.helperVersion !== verified.manifest.appVersion ||
			compositionHandshake.helperVersion !== verified.manifest.appVersion
		) {
			throw new NativeHelperTrustError(
				'Native host handshake does not match its verified manifest.',
				'untrusted'
			);
		}
		const operations = new Set(handshake.capabilities.operations);
		if (
			operations.size !== 3 ||
			!operations.has('handshake') ||
			!operations.has('permission_status') ||
			!operations.has('capability_status')
		) {
			throw new NativeHelperTrustError(
				'Native host advertised an unexpected operation set.',
				'untrusted'
			);
		}
		const compositionOperations = new Set(
			compositionHandshake.capabilities.operations
		);
		if (
			compositionOperations.size !== 4 ||
			!compositionOperations.has('handshake') ||
			!compositionOperations.has('permission_status') ||
			!compositionOperations.has('capability_status') ||
			!compositionOperations.has('compose_image')
		) {
			throw new NativeHelperTrustError(
				'Native host advertised an unexpected composition operation set.',
				'untrusted'
			);
		}
		const [permissions, advanced] = await Promise.all([
			this.#call('permission_status', signal).then((value) =>
				permissionStatusSchema.parse(value)
			),
			this.#call('capability_status', signal).then((value) =>
				simulatorNativeCapabilitiesSchema.parse(value)
			),
		]);
		return {
			status: 'available',
			helperVersion: handshake.helperVersion,
			permissionInspection: true,
			permissionPrompting: false,
			capabilityInspection: true,
			liveCaptureSessions: false,
			imageComposition: true,
			permissions: permissions.statuses,
			advanced,
			checkedAt: advanced.checkedAtMilliseconds,
		};
	}

	async compose(
		input: NativeImageCompositionInput,
		signal: AbortSignal
	): Promise<void> {
		if (!this.#compositionWorkspaceDirectory) {
			throw new Error(
				'The native image-composition workspace is not configured.'
			);
		}
		const recipe = captureCompositionRecipeSchema.parse(input.recipe);
		const root = await compositionDirectory(
			this.#compositionWorkspaceDirectory,
			{ recursive: true }
		);
		const workspaceToken = randomBytes(16).toString('hex');
		const workspace = path.join(root, workspaceToken);
		const inputs = path.join(workspace, 'inputs');
		const outputs = path.join(workspace, 'outputs');
		const inputExtension = (sourcePath: string): string => {
			const extension = path.extname(sourcePath).toLowerCase();
			if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
				throw new Error('Capture input must be a PNG or JPEG image.');
			}
			return extension;
		};
		const primaryInput = `primary${inputExtension(input.primaryPath)}`;
		const secondaryInput = input.secondaryPath
			? `secondary${inputExtension(input.secondaryPath)}`
			: undefined;
		const output = `output.${recipe.outputFormat === 'jpeg' ? 'jpeg' : 'png'}`;
		try {
			await compositionDirectory(workspace, { recursive: false });
			await Promise.all([
				compositionDirectory(inputs, { recursive: false }),
				compositionDirectory(outputs, { recursive: false }),
			]);
			await stageImage(input.primaryPath, path.join(inputs, primaryInput));
			if (input.secondaryPath && secondaryInput) {
				await stageImage(
					input.secondaryPath,
					path.join(inputs, secondaryInput)
				);
			}
			const result = compositionResultSchema.parse(
				await this.#call('compose_image', signal, {
					protocolVersion: COMPOSITION_PROTOCOL_VERSION,
					payload: {
						workspaceToken,
						primaryInput,
						...(secondaryInput ? { secondaryInput } : {}),
						output,
						...recipe,
					},
					timeoutMs: 120_000,
				})
			);
			if (
				result.outputName !== output ||
				result.outputFormat !== recipe.outputFormat ||
				result.inputCount !== (secondaryInput ? 2 : 1) ||
				result.metadataRendered !== Boolean(recipe.metadata) ||
				result.bezelStyle !== recipe.layout.bezel
			) {
				throw new Error(
					'Native compositor returned inconsistent result metadata.'
				);
			}
			await copyOwnedFile(path.join(outputs, output), input.outputPath, {
				label: 'Composed image',
				maxBytes: MAX_COMPOSITION_OUTPUT_BYTES,
				expectedBytes: result.byteCount,
				rejectedMessage:
					'Composed image did not match its verified helper result.',
				changedMessage: 'Composed image changed before it could be committed.',
			});
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	}

	async runSimulatorMutation(
		helperRequest: string,
		{
			signal,
			timeoutMs,
			forceKillDelayMs,
		}: {
			signal?: AbortSignal;
			timeoutMs: number;
			forceKillDelayMs?: number;
		}
	): Promise<string> {
		if (Buffer.byteLength(helperRequest, 'utf8') > 64 * 1024) {
			throw new Error('Simulator helper mutation request exceeds 64 KiB.');
		}
		const result = mutationBrokerResultSchema.parse(
			await this.#call('run_simulator_mutation', signal, {
				protocolVersion: MUTATION_BROKER_PROTOCOL_VERSION,
				payload: { helperRequest },
				timeoutMs,
				...(forceKillDelayMs ? { forceKillDelayMs } : {}),
				maxResponseBytes: MAX_MUTATION_BROKER_RESPONSE_BYTES,
			})
		);
		return result.helperResponse;
	}

	/**
	 * Delivers one input gesture to a Simulator through the host's HID path.
	 * The payload is validated by the shared schema before it leaves this
	 * process and again by the host; an unsigned build may use this freely
	 * because touching a Simulator's screen mutates nothing on disk.
	 */
	async sendSimulatorInput(
		input: SimulatorInput,
		signal?: AbortSignal
	): Promise<SimulatorInputResult> {
		const validated = simulatorInputSchema.parse(input);
		return simulatorInputResultSchema.parse(
			await this.#call('send_simulator_input', signal, {
				protocolVersion: SIMULATOR_INPUT_PROTOCOL_VERSION,
				payload: validated,
				// A 2 KiB text at ~12 ms per key is ~25 s; swipes are bounded at 10 s.
				timeoutMs: 60_000,
			})
		);
	}

	async #call(
		operation:
			| 'handshake'
			| 'permission_status'
			| 'capability_status'
			| 'compose_image'
			| 'run_simulator_mutation'
			| 'send_simulator_input',
		signal?: AbortSignal,
		{
			protocolVersion = INSPECTION_PROTOCOL_VERSION,
			payload = {},
			timeoutMs = 15_000,
			forceKillDelayMs,
			maxResponseBytes = MAX_RESPONSE_BYTES,
		}: {
			protocolVersion?: 2 | 3 | 4 | 5;
			payload?: Record<string, unknown>;
			timeoutMs?: number;
			forceKillDelayMs?: number;
			maxResponseBytes?: number;
		} = {}
	): Promise<unknown> {
		const requestId = `native-${randomUUID()}`;
		this.#verified ??= this.#verifier({
			resourceDirectory: this.#resourceDirectory,
			appVersion: this.#appVersion,
		});
		let helper: VerifiedNativeHelper;
		try {
			helper = await this.#verified;
		} catch (error) {
			this.#verified = undefined;
			throw error;
		}
		const input = `${JSON.stringify({
			protocolVersion,
			requestId,
			operation,
			payload,
		})}\n`;
		let stdout: string;
		try {
			stdout = (
				await this.#runner(helper.executablePath, [], {
					stdin: input,
					...(signal ? { signal } : {}),
					timeoutMs,
					...(forceKillDelayMs ? { forceKillDelayMs } : {}),
					maxOutputBytes: maxResponseBytes,
				})
			).stdout;
		} catch (error) {
			if (error instanceof SimulatorCommandError && error.stdout)
				stdout = error.stdout;
			else throw error;
		}
		const response = responseSchema.parse(JSON.parse(stdout) as unknown);
		if (response.protocolVersion !== protocolVersion) {
			throw new Error(
				'Native host response protocol did not match the request.'
			);
		}
		if (response.requestId !== requestId) {
			throw new Error(
				'Native host response identifier did not match the request.'
			);
		}
		if (!response.ok) {
			throw new NativeHostResponseError(
				response.error.code,
				response.error.message,
				response.error.retryable
			);
		}
		return response.result;
	}
}
