import type { FileHandle } from 'node:fs/promises';
import { SIMULATOR_CAPTURE_PROTOCOL_SCHEME } from '../shared/simulator-protocol';
import type {
	OpenSimulatorCapture,
	SimulatorCaptureStore,
} from './simulator-capture-store';

const MAX_REQUEST_URL_BYTES = 8 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_ACTIVE_READERS = 32;
const activeReaders = new WeakMap<SimulatorCaptureStore, number>();

type ByteRange = {
	start: number;
	end: number;
};

function responseHeaders(): Headers {
	return new Headers({
		'cache-control': 'no-store, private',
		'content-security-policy': "default-src 'none'; sandbox",
		'cross-origin-resource-policy': 'cross-origin',
		'x-content-type-options': 'nosniff',
	});
}

function errorResponse(
	status: number,
	message: string,
	size?: number,
	omitBody = false
): Response {
	const headers = responseHeaders();
	headers.set('content-type', 'text/plain; charset=utf-8');
	if (status === 405) headers.set('allow', 'GET, HEAD');
	if (status === 416 && size !== undefined) {
		headers.set('content-range', `bytes */${size}`);
	}
	return new Response(omitBody ? null : message, { headers, status });
}

export function captureIdFromProtocolUrl(
	requestUrl: string
): string | undefined {
	if (Buffer.byteLength(requestUrl, 'utf8') > MAX_REQUEST_URL_BYTES)
		return undefined;
	try {
		const url = new URL(requestUrl);
		if (
			url.protocol !== `${SIMULATOR_CAPTURE_PROTOCOL_SCHEME}:` ||
			url.hostname !== 'capture' ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return undefined;
		}
		const authorityOffset = requestUrl.indexOf('://') + 3;
		const rawPathOffset = requestUrl.indexOf('/', authorityOffset);
		if (rawPathOffset < 0) return undefined;
		const rawPath = requestUrl.slice(rawPathOffset).split(/[?#]/, 1)[0];
		if (!rawPath || /%2f|%5c/i.test(rawPath)) return undefined;
		const pathname = decodeURIComponent(rawPath);
		if (pathname.includes('\\') || pathname.includes('\0')) return undefined;
		const match =
			/^\/(capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
				pathname
			);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function requestedRange(
	value: string | null,
	size: number
): ByteRange | undefined | null {
	if (value === null) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
	if (!match) return null;
	const startText = match[1] ?? '';
	const endText = match[2] ?? '';
	if (!startText && !endText) return null;
	if (!startText) {
		const suffixLength = Number(endText);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}
	const start = Number(startText);
	if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
	const requestedEnd = endText ? Number(endText) : size - 1;
	if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
	return { start, end: Math.min(requestedEnd, size - 1) };
}

function fileBody(
	handle: FileHandle,
	{ start, end }: ByteRange,
	release: () => void
): ReadableStream<Uint8Array> {
	let position = start;
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await handle.close().catch(() => undefined);
		release();
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (position > end) {
				await close();
				controller.close();
				return;
			}
			try {
				const length = Math.min(STREAM_CHUNK_BYTES, end - position + 1);
				const buffer = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(buffer, 0, length, position);
				if (bytesRead === 0) throw new Error('Capture ended during streaming.');
				position += bytesRead;
				controller.enqueue(
					new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
				);
			} catch (error) {
				await close();
				controller.error(error);
			}
		},
		async cancel() {
			await close();
		},
	});
}

function captureResponse(
	request: Request,
	opened: OpenSimulatorCapture,
	release: () => void
): Response | Promise<Response> {
	const range = requestedRange(request.headers.get('range'), opened.size);
	if (range === null) {
		return opened.handle
			.close()
			.catch(() => undefined)
			.then(() => {
				release();
				return errorResponse(
					416,
					'Requested range is not satisfiable.',
					opened.size,
					request.method === 'HEAD'
				);
			});
	}
	const selected = range ?? { start: 0, end: opened.size - 1 };
	const contentLength = selected.end - selected.start + 1;
	const headers = responseHeaders();
	headers.set('accept-ranges', 'bytes');
	headers.set('content-length', String(contentLength));
	headers.set('content-type', opened.capture.mimeType);
	headers.set(
		'content-disposition',
		`inline; filename="${opened.capture.name.replaceAll(/["\\]/g, '_')}"`
	);
	if (range) {
		headers.set(
			'content-range',
			`bytes ${selected.start}-${selected.end}/${opened.size}`
		);
	}
	if (request.method === 'HEAD') {
		return opened.handle
			.close()
			.catch(() => undefined)
			.then(() => {
				release();
				return new Response(null, {
					headers,
					status: range ? 206 : 200,
				});
			});
	}
	return new Response(fileBody(opened.handle, selected, release), {
		headers,
		status: range ? 206 : 200,
	});
}

export async function serveSimulatorCaptureRequest(
	store: SimulatorCaptureStore,
	request: Request
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return errorResponse(405, 'Method not allowed.');
	}
	const captureId = captureIdFromProtocolUrl(request.url);
	if (!captureId) {
		return errorResponse(
			404,
			'Capture not found.',
			undefined,
			request.method === 'HEAD'
		);
	}
	const active = activeReaders.get(store) ?? 0;
	if (active >= MAX_ACTIVE_READERS) {
		const response = errorResponse(
			429,
			'Too many active capture readers.',
			undefined,
			request.method === 'HEAD'
		);
		response.headers.set('retry-after', '1');
		return response;
	}
	activeReaders.set(store, active + 1);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const remaining = (activeReaders.get(store) ?? 1) - 1;
		if (remaining <= 0) activeReaders.delete(store);
		else activeReaders.set(store, remaining);
	};
	let opened: OpenSimulatorCapture | undefined;
	try {
		opened = await store.openForRead(captureId);
		return await captureResponse(request, opened, release);
	} catch {
		await opened?.handle.close().catch(() => undefined);
		release();
		return errorResponse(
			404,
			'Capture not found.',
			undefined,
			request.method === 'HEAD'
		);
	}
}
