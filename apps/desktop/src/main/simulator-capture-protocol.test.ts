import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	captureIdFromProtocolUrl,
	serveSimulatorCaptureRequest,
} from './simulator-capture-protocol';
import {
	SimulatorCaptureStore,
	simulatorCaptureUrl,
} from './simulator-capture-store';

const UDID = '11111111-2222-3333-4444-555555555555';
const temporaryDirectories: string[] = [];

async function fixture(contents = '0123456789') {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-capture-protocol-')
	);
	temporaryDirectories.push(directory);
	const store = new SimulatorCaptureStore(path.join(directory, 'store'));
	const pending = await store.reserve({
		deviceUdid: UDID,
		kind: 'video',
		format: 'mp4',
		name: 'recording',
	});
	await writeFile(pending.path, contents);
	const capture = await store.commit(pending);
	return { capture, directory, pending, store };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('Simulator capture protocol', () => {
	it('accepts only one exact opaque identifier and rejects traversal variants', () => {
		const id = 'capture-12345678-1234-4123-8123-123456789abc';
		expect(captureIdFromProtocolUrl(`rndevtools-capture://capture/${id}`)).toBe(
			id
		);
		for (const url of [
			`rndevtools-capture://other/${id}`,
			`rndevtools-capture://capture/${id}/extra`,
			`rndevtools-capture://capture/%2e%2e/${id}`,
			`rndevtools-capture://capture/%2Fetc%2Fpasswd`,
			`rndevtools-capture://capture/${id}?path=/etc/passwd`,
			`rndevtools-capture://capture/${id}#fragment`,
			`rndevtools-capture://user@capture/${id}`,
			`file:///tmp/${id}`,
		]) {
			expect(captureIdFromProtocolUrl(url), url).toBeUndefined();
		}
	});

	it('serves trusted MIME with no-store and nosniff headers', async () => {
		const { capture, store } = await fixture();
		const response = await serveSimulatorCaptureRequest(
			store,
			new Request(simulatorCaptureUrl(capture.id))
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('video/mp4');
		expect(response.headers.get('content-length')).toBe('10');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await response.text()).toBe('0123456789');
	});

	it('implements bounded single byte ranges, suffix ranges, and HEAD', async () => {
		const { capture, store } = await fixture();
		const url = simulatorCaptureUrl(capture.id);
		const partial = await serveSimulatorCaptureRequest(
			store,
			new Request(url, { headers: { range: 'bytes=2-5' } })
		);
		expect(partial.status).toBe(206);
		expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
		expect(partial.headers.get('content-length')).toBe('4');
		expect(await partial.text()).toBe('2345');

		const suffix = await serveSimulatorCaptureRequest(
			store,
			new Request(url, { headers: { range: 'bytes=-3' } })
		);
		expect(suffix.status).toBe(206);
		expect(await suffix.text()).toBe('789');

		const head = await serveSimulatorCaptureRequest(
			store,
			new Request(url, { method: 'HEAD' })
		);
		expect(head.status).toBe(200);
		expect(head.headers.get('content-length')).toBe('10');
		expect(await head.text()).toBe('');
	});

	it('returns 416 for malformed, multiple, and unsatisfiable ranges', async () => {
		const { capture, store } = await fixture();
		for (const range of [
			'bytes=10-',
			'bytes=8-2',
			'bytes=0-1,4-5',
			'items=0-1',
		]) {
			const response = await serveSimulatorCaptureRequest(
				store,
				new Request(simulatorCaptureUrl(capture.id), { headers: { range } })
			);
			expect(response.status, range).toBe(416);
			expect(response.headers.get('content-range'), range).toBe('bytes */10');
		}
		const head = await serveSimulatorCaptureRequest(
			store,
			new Request(simulatorCaptureUrl(capture.id), {
				method: 'HEAD',
				headers: { range: 'bytes=99-' },
			})
		);
		expect(head.status).toBe(416);
		expect(await head.text()).toBe('');
	});

	it('rejects unsupported methods and refuses a replaced symlink', async () => {
		const { capture, directory, pending, store } = await fixture('secret-data');
		const post = await serveSimulatorCaptureRequest(
			store,
			new Request(simulatorCaptureUrl(capture.id), { method: 'POST' })
		);
		expect(post.status).toBe(405);
		expect(post.headers.get('allow')).toBe('GET, HEAD');

		const outside = path.join(directory, 'outside.txt');
		await writeFile(outside, 'secret-data');
		await rm(pending.path);
		await symlink(outside, pending.path);
		const replaced = await serveSimulatorCaptureRequest(
			store,
			new Request(simulatorCaptureUrl(capture.id))
		);
		expect(replaced.status).toBe(404);
		expect(await replaced.text()).not.toContain('secret-data');
	});
});
