import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import type { FailureRecord } from '../shared/failure-protocol';

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const HOST_PROCESS =
	/^(?:Simulator|SimulatorTrampoline|SimRenderServer|CoreSimulatorBridge|com\.apple\.CoreSimulator(?:\..+)?)$/;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

export function failureId(key: string): string {
	return `failure-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

export function failureText(value: string, limit = 16_384): string {
	return (
		redactDiagnosticText(value)
			.replaceAll(os.homedir(), '~')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal control bytes from untrusted reports.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
			.slice(0, limit)
	);
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** Project only allowlisted crash metadata and symbol names, never raw report memory. */
export function parseDiagnosticReport(
	raw: string,
	filename: string,
	mtime: number
): FailureRecord | undefined {
	let process = '';
	let udid: string | undefined;
	let detail = '';
	let at = mtime;
	let diagnostic = false;
	let nativeSimulator = false;
	let appleSimulatorProcess = false;
	if (filename.endsWith('.ips')) {
		let body: Record<string, unknown>;
		try {
			const newline = raw.indexOf('\n');
			try {
				body = object(JSON.parse(raw));
			} catch {
				body = object(JSON.parse(raw.slice(newline + 1)));
			}
		} catch {
			return undefined;
		}
		process = text(body.procName);
		const identity = `${text(body.coalitionName)} ${text(body.procPath)}`;
		udid = identity
			.match(
				new RegExp(`(?:SimDevice\\.|CoreSimulator/Devices/)(${UUID})`, 'i')
			)?.[1]
			?.toUpperCase();
		nativeSimulator = text(body.parentProc) === 'launchd_sim';
		if (!udid && !nativeSimulator && !HOST_PROCESS.test(process))
			return undefined;
		appleSimulatorProcess =
			(nativeSimulator || udid !== undefined) &&
			[
				text(body.codeSigningID),
				text(object(body.bundleInfo).CFBundleIdentifier),
			].some((identifier) => identifier.startsWith('com.apple.'));
		const exception = object(body.exception);
		const termination = object(body.termination);
		diagnostic = !text(exception.type) && !text(termination.indicator);
		const captured = Date.parse(text(body.captureTime));
		if (Number.isFinite(captured)) at = captured;
		const threads = Array.isArray(body.threads) ? body.threads : [];
		const thread = object(
			threads[typeof body.faultingThread === 'number' ? body.faultingThread : 0]
		);
		const frames = Array.isArray(body.lastExceptionBacktrace)
			? body.lastExceptionBacktrace
			: Array.isArray(thread.frames)
				? thread.frames
				: [];
		detail = [
			`Process: ${process}`,
			`Exception: ${text(exception.type)} ${text(exception.signal)}`,
			`Termination: ${text(termination.namespace)} ${text(termination.indicator)}`,
			`Parent: ${text(body.parentProc)}`,
			`System: ${text(object(body.osVersion).train)} (${text(object(body.osVersion).build)})`,
			'Exception/triggered-thread symbols:',
			...frames
				.slice(0, 16)
				.map((frame) => text(object(frame).symbol).slice(0, 512))
				.filter(Boolean),
		].join('\n');
	} else {
		const field = (label: string) =>
			raw.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
		process = (field('Process') || field('Command')).replace(/\s+\[\d+\]$/, '');
		udid = raw
			.match(
				new RegExp(`(?:SimDevice\\.|CoreSimulator/Devices/)(${UUID})`, 'i')
			)?.[1]
			?.toUpperCase();
		if (!udid && !HOST_PROCESS.test(process)) return undefined;
		diagnostic = filename.endsWith('.diag');
		detail = [
			'Process',
			'Command',
			'Date/Time',
			'OS Version',
			'Event',
			'Action taken',
			'Exception Type',
			'Termination Reason',
			'Duration',
			'Writes',
		]
			.map((label) => {
				const value = field(label);
				return value ? `${label}: ${value.slice(0, 1_024)}` : '';
			})
			.filter(Boolean)
			.join('\n');
	}
	const simulator =
		appleSimulatorProcess ||
		HOST_PROCESS.test(process) ||
		['SpringBoard', 'launchd_sim', 'backboardd'].includes(process);
	return {
		id: failureId(`report:${filename}:${mtime}`),
		at,
		kind: diagnostic
			? 'simulator-diagnostic'
			: simulator
				? 'simulator-crash'
				: 'app-crash',
		severity: diagnostic ? 'warning' : 'error',
		title: failureText(
			`${process || 'Simulator process'} ${diagnostic ? 'resource diagnostic' : 'crashed'}`,
			240
		),
		detail: failureText(
			detail +
				(appleSimulatorProcess
					? '\nApple simulator process. This report does not establish that the development app or the host Simulator app crashed.'
					: '') +
				(diagnostic
					? '\nA resource diagnostic does not itself establish a process crash.'
					: '')
		),
		source: failureText(filename, 256),
		process: failureText(process, 256),
		...(udid ? { simulatorUdid: udid } : {}),
	};
}

export async function readDiagnosticReports(
	directories: readonly string[],
	now: number
): Promise<{ records: FailureRecord[]; issues: string[] }> {
	const records: FailureRecord[] = [];
	const issues: string[] = [];
	for (const directory of directories.slice(0, 12)) {
		const candidates: { name: string; mtime: number }[] = [];
		try {
			let inspected = 0;
			for await (const entry of await opendir(directory)) {
				if (++inspected > 3_000) {
					issues.push(
						'A diagnostic folder exceeds the scan limit; some reports were not inspected.'
					);
					break;
				}
				if (!entry.isFile() || !/\.(ips|crash|diag)$/.test(entry.name))
					continue;
				const metadata = await lstat(path.join(directory, entry.name)).catch(
					() => undefined
				);
				if (metadata?.isFile() && metadata.mtimeMs >= now - 30 * 86_400_000)
					candidates.push({ name: entry.name, mtime: metadata.mtimeMs });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				issues.push(
					`Cannot read ${failureText(directory, 400)}. Check macOS file access.`
				);
			continue;
		}
		candidates.sort((a, b) => b.mtime - a.mtime);
		if (candidates.length > 300)
			issues.push(
				'Only the newest 300 reports per diagnostic folder are inspected.'
			);
		let remainingBytes = 16 * 1024 * 1024;
		for (const { name: filename } of candidates.slice(0, 300)) {
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				handle = await open(
					path.join(directory, filename),
					constants.O_RDONLY | constants.O_NOFOLLOW
				);
				const metadata = await handle.stat();
				if (!metadata.isFile() || metadata.mtimeMs < now - 30 * 86_400_000)
					continue;
				if (filename.endsWith('.ips') && metadata.size > MAX_REPORT_BYTES) {
					issues.push(
						'An oversized diagnostic report was skipped (4 MB limit).'
					);
					continue;
				}
				const size = Math.min(
					metadata.size,
					filename.endsWith('.ips') ? MAX_REPORT_BYTES : 64 * 1024
				);
				if (size > remainingBytes) {
					issues.push('The diagnostic scan reached its 16 MB folder limit.');
					break;
				}
				remainingBytes -= size;
				const bytes = Buffer.alloc(size);
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
				const record = parseDiagnosticReport(
					bytes.subarray(0, bytesRead).toString('utf8'),
					filename,
					metadata.mtimeMs
				);
				if (record) records.push(record);
			} catch {
				/* A report may be moved or still being written; retry on the next scan. */
			} finally {
				await handle?.close();
			}
		}
	}
	return { records, issues: [...new Set(issues)].slice(0, 12) };
}
