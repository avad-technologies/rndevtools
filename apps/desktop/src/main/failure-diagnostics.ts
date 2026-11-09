import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import type { FailureRecord } from '../shared/failure-protocol';
import { stripTerminalControls } from './supabase/cli-redact';

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const HOST_PROCESS =
	/^(?:Simulator|SimulatorTrampoline|SimRenderServer|CoreSimulatorBridge|com\.apple\.CoreSimulator(?:\..+)?)$/;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
/** Heads the Metro output a failure's detail carries after an unexpected exit. */
export const METRO_LOG_TAIL_HEADING = 'Metro log tail (redacted):';

export function failureId(key: string): string {
	return `failure-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

export function failureText(value: string, limit = 16_384): string {
	// Whole escape sequences and control characters go before redaction: in
	// colored output a credential follows `\x1b[32m` directly, with no word
	// boundary for the redaction rules to start at.
	return redactDiagnosticText(stripTerminalControls(value, true))
		.replaceAll(os.homedir(), '~')
		.slice(0, limit);
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
		const nonfatal =
			body.isNonFatalCorpse === true || body.isNonFatalCorpse === 1;
		const resource = text(exception.type) === 'EXC_RESOURCE';
		const fatalSignal =
			/^(SIGKILL|SIGABRT|SIGSEGV|SIGBUS|SIGILL|SIGTRAP)$/.test(
				text(exception.signal)
			);
		diagnostic =
			nonfatal ||
			(resource && !fatalSignal && !text(termination.indicator)) ||
			(!text(exception.type) && !text(termination.indicator));
		const captured = Date.parse(text(body.captureTime));
		if (Number.isFinite(captured) && captured >= 0) at = captured;
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
		diagnostic =
			filename.endsWith('.diag') ||
			/^none$/i.test(field('Action taken')) ||
			/NON-FATAL/i.test(field('Exception Type')) ||
			(!field('Exception Type') && !field('Termination Reason'));
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

/** What a scan made of one report, valid while its size and mtime hold. */
type ScannedReport = {
	size: number;
	mtimeMs: number;
	record: FailureRecord | undefined;
};

/**
 * Earlier scans' results by report path. A scan given one opens only reports
 * that are new or changed since, and forgets every report it did not reach.
 */
export type DiagnosticReportCache = Map<string, ScannedReport>;

export async function readDiagnosticReports(
	directories: readonly string[],
	now: number,
	cache: DiagnosticReportCache = new Map()
): Promise<{ records: FailureRecord[]; issues: string[] }> {
	const records: FailureRecord[] = [];
	const issues: string[] = [];
	const reached = new Set<string>();
	for (const directory of directories.slice(0, 12)) {
		const candidates: { name: string; size: number; mtime: number }[] = [];
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
					candidates.push({
						name: entry.name,
						size: metadata.size,
						mtime: metadata.mtimeMs,
					});
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
		for (const { name: filename, size, mtime } of candidates.slice(0, 300)) {
			if (filename.endsWith('.ips') && size > MAX_REPORT_BYTES) {
				issues.push('An oversized diagnostic report was skipped (4 MB limit).');
				continue;
			}
			const length = Math.min(
				size,
				filename.endsWith('.ips') ? MAX_REPORT_BYTES : 64 * 1024
			);
			if (length > remainingBytes) {
				issues.push('The diagnostic scan reached its 16 MB folder limit.');
				break;
			}
			const file = path.join(directory, filename);
			const scanned = cache.get(file);
			if (scanned?.size === size && scanned.mtimeMs === mtime) {
				// Unchanged since an earlier scan, so it is not opened again. It
				// still counts against the limits, so the cache never lets a scan
				// cover more reports than reading them all would.
				remainingBytes -= length;
				reached.add(file);
				if (scanned.record) records.push(scanned.record);
				continue;
			}
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
				const metadata = await handle.stat();
				// A report that changed since it was listed may still be being
				// written; it is read on a later scan.
				if (
					!metadata.isFile() ||
					metadata.size !== size ||
					metadata.mtimeMs !== mtime
				)
					continue;
				remainingBytes -= length;
				const bytes = Buffer.alloc(length);
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
				const record = parseDiagnosticReport(
					bytes.subarray(0, bytesRead).toString('utf8'),
					filename,
					mtime
				);
				cache.set(file, { size, mtimeMs: mtime, record });
				reached.add(file);
				if (record) records.push(record);
			} catch {
				/* A report may be moved or still being written; retry on the next scan. */
			} finally {
				await handle?.close();
			}
		}
	}
	// Reports that vanished, aged out, or fell past a limit.
	for (const file of cache.keys()) if (!reached.has(file)) cache.delete(file);
	return { records, issues: [...new Set(issues)].slice(0, 12) };
}
