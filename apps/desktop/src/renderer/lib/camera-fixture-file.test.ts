import { describe, expect, it } from 'vitest';
import {
	assertFixtureSize,
	inspectImageFixture,
	inspectVideoFixture,
} from './camera-fixture-file';

function fixture(size: number, type: string): File {
	return new File([new Uint8Array(size)], 'fixture', { type });
}

describe('camera fixture files', () => {
	it('accepts a non-empty file of at most 384 KiB', () => {
		const message = 'Choose a non-empty fixture no larger than 384 KiB.';
		expect(() => assertFixtureSize(fixture(0, 'image/png'))).toThrow(message);
		expect(() =>
			assertFixtureSize(fixture(384 * 1024 + 1, 'image/png'))
		).toThrow(message);
		expect(() =>
			assertFixtureSize(fixture(384 * 1024, 'image/png'))
		).not.toThrow();
	});

	it('refuses a MIME type outside the image or video list before decoding', async () => {
		await expect(inspectImageFixture(fixture(4, 'image/gif'))).rejects.toThrow(
			'Still and QR fixtures must be JPEG, PNG, or WebP images.'
		);
		await expect(inspectImageFixture(fixture(4, 'video/mp4'))).rejects.toThrow(
			'Still and QR fixtures must be JPEG, PNG, or WebP images.'
		);
		await expect(inspectVideoFixture(fixture(4, 'video/webm'))).rejects.toThrow(
			'Video fixtures must be MP4 or QuickTime files.'
		);
	});
});
