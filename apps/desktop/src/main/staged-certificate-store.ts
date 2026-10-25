import { createHash, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SimulatorAction } from '../shared/simulator-protocol';
import type { SimulatorCertificateIdentity } from './simulator-confirmation';

const DEFAULT_TTL_MS = 60_000;
const MAX_CERTIFICATE_BYTES = 16 * 1024 * 1024;
const MAX_CERTIFICATE_SUBJECT_BYTES = 512;
const MAX_PENDING_CERTIFICATES = 8;
const MAX_PENDING_CERTIFICATE_BYTES = 32 * 1024 * 1024;
const CERTIFICATE_EXTENSIONS = new Set(['.cer', '.crt', '.der', '.pem']);
const PEM_CERTIFICATE_PATTERN =
	/^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/;
const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const stagedCertificateIdentitySchema = z.strictObject({
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	sizeBytes: z.number().int().positive().max(MAX_CERTIFICATE_BYTES),
	subject: z
		.string()
		.min(1)
		.max(MAX_CERTIFICATE_SUBJECT_BYTES)
		.regex(/^[\x20-\x7e]+$/)
		.optional(),
});

type RootCertificateAction = Extract<
	SimulatorAction,
	{ kind: 'keychain.addCertificate' }
>;

export type StagedCertificate = {
	bytes: Buffer;
	cleanup: () => Promise<void>;
	identity: SimulatorCertificateIdentity;
	materialize: () => Promise<MaterializedCertificate>;
};

type MaterializedCertificate = {
	cleanup: () => Promise<void>;
	path: string;
};

type StagedCertificateRecord = {
	actionId: string;
	artifact: StagedCertificate;
	expiresAt: number;
	senderId: number;
	timer: NodeJS.Timeout;
	udid: string;
};

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function sanitizeSubject(subject: string): string | undefined {
	const normalized = subject
		.replaceAll(/\s+/g, ' ')
		.replaceAll(/[^\x20-\x7e]/g, '?')
		.trim();
	if (!normalized) return undefined;
	return Buffer.from(normalized, 'utf8')
		.subarray(0, MAX_CERTIFICATE_SUBJECT_BYTES)
		.toString('utf8')
		.trim();
}

function canonicalCertificateBytes(source: Buffer): {
	bytes: Buffer;
	certificate: X509Certificate;
} {
	let certificate: X509Certificate;
	const beginsAsPem = source
		.toString('ascii', 0, Math.min(source.byteLength, 64))
		.trimStart()
		.startsWith('-----BEGIN');
	if (beginsAsPem) {
		if (source.some((byte) => byte > 0x7f)) {
			throw new Error('Selected PEM certificate must contain only ASCII text.');
		}
		const match = PEM_CERTIFICATE_PATTERN.exec(source.toString('ascii').trim());
		const payload = match?.[1]?.replaceAll(/\r?\n/g, '') ?? '';
		if (!payload || !BASE64_PATTERN.test(payload)) {
			throw new Error(
				'Selected PEM file must contain exactly one certificate.'
			);
		}
		const decoded = Buffer.from(payload, 'base64');
		try {
			certificate = new X509Certificate(decoded);
			if (!certificate.raw.equals(decoded)) {
				throw new Error('Selected DER certificate contains trailing data.');
			}
		} finally {
			decoded.fill(0);
		}
	} else {
		certificate = new X509Certificate(source);
		if (!certificate.raw.equals(source)) {
			throw new Error('Selected DER certificate contains trailing data.');
		}
	}
	return { bytes: Buffer.from(certificate.raw), certificate };
}

async function readBoundedFile(
	file: Awaited<ReturnType<typeof open>>,
	maximumBytes: number
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for (;;) {
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
		if (bytesRead === 0) break;
		totalBytes += bytesRead;
		if (totalBytes > maximumBytes) {
			throw new Error('Selected certificate exceeds the safe size limit.');
		}
		chunks.push(buffer.subarray(0, bytesRead));
	}
	if (totalBytes === 0) throw new Error('Selected certificate is empty.');
	return Buffer.concat(chunks, totalBytes);
}

async function loadCertificateSource(selectedPath: string): Promise<{
	bytes: Buffer;
	identity: SimulatorCertificateIdentity;
}> {
	const selected = path.resolve(selectedPath);
	if (!CERTIFICATE_EXTENSIONS.has(path.extname(selected).toLowerCase())) {
		throw new Error(
			'Selected certificate must use a supported certificate extension.'
		);
	}
	const resolved = await realpath(selected);
	const handle = await open(
		resolved,
		constants.O_RDONLY | constants.O_NOFOLLOW
	);
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.size <= 0 ||
			metadata.size > MAX_CERTIFICATE_BYTES
		) {
			throw new Error('Selected certificate must be a bounded regular file.');
		}
		const selectedBytes = await readBoundedFile(handle, MAX_CERTIFICATE_BYTES);
		let canonical: ReturnType<typeof canonicalCertificateBytes> | undefined;
		try {
			canonical = canonicalCertificateBytes(selectedBytes);
		} catch {
			throw new Error(
				'Selected file must contain exactly one valid X.509 certificate.'
			);
		} finally {
			selectedBytes.fill(0);
		}
		try {
			const subject = sanitizeSubject(canonical.certificate.subject);
			const identity = stagedCertificateIdentitySchema.parse({
				sha256: sha256(canonical.bytes),
				sizeBytes: canonical.bytes.byteLength,
				...(subject ? { subject } : {}),
			});
			return {
				bytes: canonical.bytes,
				identity: {
					sha256: identity.sha256,
					sizeBytes: identity.sizeBytes,
					...(identity.subject ? { subject: identity.subject } : {}),
				},
			};
		} catch (error) {
			canonical.bytes.fill(0);
			throw error;
		}
	} finally {
		await handle.close();
	}
}

export class StagedCertificateStore {
	readonly #directory: string;
	readonly #materializedDirectories = new Set<string>();
	readonly #now: () => number;
	readonly #records = new Map<string, StagedCertificateRecord>();
	readonly #revokedSenders = new Set<number>();
	readonly #staged = new Map<StagedCertificate, number | null>();
	readonly #ttlMs: number;
	#pendingBytes = 0;
	#started = false;

	constructor({
		directory,
		now = Date.now,
		ttlMs = DEFAULT_TTL_MS,
	}: { directory: string; now?: () => number; ttlMs?: number }) {
		this.#directory = path.resolve(directory);
		this.#now = now;
		this.#ttlMs =
			Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		await rm(this.#directory, { force: true, recursive: true });
		await mkdir(this.#directory, { mode: 0o700, recursive: true });
		await chmod(this.#directory, 0o700);
		this.#started = true;
	}

	registerSender(senderId: number): void {
		this.#revokedSenders.delete(senderId);
	}

	async stage(
		selectedPath: string,
		senderId: number
	): Promise<StagedCertificate> {
		if (!this.#started || this.#revokedSenders.has(senderId)) {
			throw new Error('Certificate staging is unavailable.');
		}
		const source = await loadCertificateSource(selectedPath);
		if (!this.#started || this.#revokedSenders.has(senderId)) {
			source.bytes.fill(0);
			throw new Error('Certificate staging is shutting down.');
		}
		if (
			this.#staged.size >= MAX_PENDING_CERTIFICATES ||
			this.#pendingBytes + source.bytes.byteLength >
				MAX_PENDING_CERTIFICATE_BYTES
		) {
			source.bytes.fill(0);
			throw new Error('The pending certificate approval queue is full.');
		}
		let cleaned = false;
		let materializationStarted = false;
		const artifact: StagedCertificate = {
			bytes: source.bytes,
			identity: source.identity,
			materialize: async () => {
				if (!this.#started || cleaned || this.#staged.get(artifact) !== null) {
					throw new Error('The approved certificate is no longer available.');
				}
				if (materializationStarted) {
					throw new Error(
						'The approved certificate has already been materialized.'
					);
				}
				materializationStarted = true;
				if (
					artifact.bytes.byteLength !== artifact.identity.sizeBytes ||
					sha256(artifact.bytes) !== artifact.identity.sha256
				) {
					throw new Error('The approved certificate bytes changed before use.');
				}
				const artifactDirectory = await mkdtemp(
					path.join(this.#directory, 'certificate-')
				);
				this.#materializedDirectories.add(artifactDirectory);
				const artifactPath = path.join(artifactDirectory, 'certificate.cer');
				let materializedCleaned = false;
				let cleanupAttempt: Promise<void> | undefined;
				const cleanup = async (): Promise<void> => {
					if (materializedCleaned) return;
					if (cleanupAttempt) return cleanupAttempt;
					cleanupAttempt = rm(artifactDirectory, {
						force: true,
						recursive: true,
					})
						.then(() => {
							materializedCleaned = true;
							this.#materializedDirectories.delete(artifactDirectory);
						})
						.finally(() => {
							cleanupAttempt = undefined;
						});
					return cleanupAttempt;
				};
				try {
					await chmod(artifactDirectory, 0o700);
					const output = await open(
						artifactPath,
						constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
						0o600
					);
					try {
						await output.writeFile(artifact.bytes);
						await output.sync();
					} finally {
						await output.close();
					}
					await chmod(artifactPath, 0o400);
					const verification = await open(
						artifactPath,
						constants.O_RDONLY | constants.O_NOFOLLOW
					);
					try {
						const bytes = await readBoundedFile(
							verification,
							MAX_CERTIFICATE_BYTES
						);
						if (
							bytes.byteLength !== artifact.identity.sizeBytes ||
							sha256(bytes) !== artifact.identity.sha256
						) {
							throw new Error(
								'The one-use certificate file failed verification.'
							);
						}
					} finally {
						await verification.close();
					}
					return { cleanup, path: artifactPath };
				} catch (error) {
					await cleanup();
					throw error;
				}
			},
			cleanup: async () => {
				if (cleaned) return;
				cleaned = true;
				this.#staged.delete(artifact);
				for (const [token, record] of this.#records) {
					if (record.artifact !== artifact) continue;
					clearTimeout(record.timer);
					this.#records.delete(token);
				}
				this.#pendingBytes -= artifact.bytes.byteLength;
				artifact.bytes.fill(0);
			},
		};
		this.#staged.set(artifact, senderId);
		this.#pendingBytes += artifact.bytes.byteLength;
		return artifact;
	}

	bind(
		token: string,
		senderId: number,
		action: RootCertificateAction,
		artifact: StagedCertificate
	): void {
		if (
			!action.trustRoot ||
			this.#staged.get(artifact) !== senderId ||
			this.#records.has(token)
		) {
			throw new Error(
				'Only pending trusted-root certificate actions may bind staged artifacts.'
			);
		}
		const expiresAt = this.#now() + this.#ttlMs;
		const timer = setTimeout(() => {
			void this.#discardRecord(token);
		}, this.#ttlMs);
		timer.unref();
		this.#records.set(token, {
			actionId: action.actionId,
			artifact,
			expiresAt,
			senderId,
			timer,
			udid: action.udid,
		});
	}

	async claim(
		token: string | undefined,
		senderId: number,
		action: RootCertificateAction
	): Promise<StagedCertificate | undefined> {
		if (!token) return undefined;
		const record = this.#records.get(token);
		if (!record) return undefined;
		this.#records.delete(token);
		clearTimeout(record.timer);
		if (
			!action.trustRoot ||
			record.senderId !== senderId ||
			record.actionId !== action.actionId ||
			record.udid !== action.udid ||
			record.expiresAt < this.#now() ||
			record.artifact.bytes.byteLength !== record.artifact.identity.sizeBytes ||
			sha256(record.artifact.bytes) !== record.artifact.identity.sha256
		) {
			await record.artifact.cleanup();
			return undefined;
		}
		// The accepted job, not the renderer window, owns the artifact from here.
		// This lets an already-authorized queued action finish if its window closes.
		this.#staged.set(record.artifact, null);
		return record.artifact;
	}

	async revokeSender(senderId: number): Promise<void> {
		this.#revokedSenders.add(senderId);
		await Promise.all([
			...[...this.#records.entries()]
				.filter(([, record]) => record.senderId === senderId)
				.map(([token]) => this.#discardRecord(token)),
			...[...this.#staged.entries()]
				.filter(([, owner]) => owner === senderId)
				.map(([artifact]) => artifact.cleanup()),
		]);
	}

	async stop(): Promise<void> {
		this.#started = false;
		for (const record of this.#records.values()) clearTimeout(record.timer);
		this.#records.clear();
		await Promise.all(
			[...this.#staged.keys()].map((artifact) => artifact.cleanup())
		);
		await Promise.all(
			[...this.#materializedDirectories].map((directory) =>
				rm(directory, { force: true, recursive: true })
			)
		);
		this.#materializedDirectories.clear();
		await rm(this.#directory, { force: true, recursive: true });
		this.#revokedSenders.clear();
	}

	async #discardRecord(token: string): Promise<void> {
		const record = this.#records.get(token);
		if (!record) return;
		this.#records.delete(token);
		clearTimeout(record.timer);
		await record.artifact.cleanup();
	}
}
