import { describe, expect, it } from 'vitest';
import {
	PACKAGED_RENDERER_CONTENT_SECURITY_POLICY,
	PACKAGED_RENDERER_URL,
	packagedRendererAssetPath,
	sanitizeDialogText,
	trustedDevelopmentRendererUrl,
	trustedLoopbackHttpUrl,
	urlsMatchWithoutHash,
} from './security';

describe('desktop URL boundaries', () => {
	it('accepts only loopback renderer URLs in unpackaged development', () => {
		expect(trustedDevelopmentRendererUrl('http://localhost:5173/', false)).toBe(
			'http://localhost:5173/'
		);
		expect(trustedDevelopmentRendererUrl('http://127.0.0.1:5173/', false)).toBe(
			'http://127.0.0.1:5173/'
		);
		expect(
			trustedDevelopmentRendererUrl('https://attacker.example/', false)
		).toBeUndefined();
		expect(
			trustedDevelopmentRendererUrl('http://localhost:5173/', true)
		).toBeUndefined();
	});

	it('opens externally only canonical loopback http addresses with a port', () => {
		expect(trustedLoopbackHttpUrl('http://127.0.0.1:54324')).toBe(
			'http://127.0.0.1:54324/'
		);
		expect(
			trustedLoopbackHttpUrl('http://127.0.0.1:54323/project/default')
		).toBe('http://127.0.0.1:54323/project/default');
		expect(trustedLoopbackHttpUrl('http://[::1]:54321/')).toBe(
			'http://[::1]:54321/'
		);
		for (const value of [
			'',
			'http://localhost:54324/',
			'https://127.0.0.1:54324/',
			'http://127.0.0.2:54324/',
			'http://0.0.0.0:54324/',
			'http://192.168.1.20:54324/',
			'http://example.com:54324/',
			'http://127.0.0.1/',
			'http://127.0.0.1:80/',
			'http://127.0.0.1:0/',
			'http://user:secret@127.0.0.1:54324/',
			'http://127.0.0.1:54324@example.com/',
			'http://127.0.0.1:54324/?token=1',
			'http://127.0.0.1:54324/#fragment',
			'http://127.0.0.1:54324/?',
			// Non-canonical spellings of loopback are refused, not normalized.
			'http://127.1:54324/',
			'http://2130706433:54324/',
			'HTTP://127.0.0.1:54324/',
			'http://127.0.0.1:054324/',
			'http://[0:0:0:0:0:0:0:1]:54324/',
			'http://127.0.0.1:54324/a/../b',
			'http:\\\\127.0.0.1:54324\\',
			' http://127.0.0.1:54324/',
			'http://127.0.0.1:54324/\n',
			'javascript:alert(1)',
			'file:///etc/hosts',
			'x-apple.systempreferences:com.apple.preference.security',
			`http://127.0.0.1:54324/${'a'.repeat(4096)}`,
		]) {
			expect(trustedLoopbackHttpUrl(value), value).toBeUndefined();
		}
		expect(trustedLoopbackHttpUrl(undefined as unknown as string)).toBe(
			undefined
		);
	});

	it('flattens dialog text to one bounded, visible line', () => {
		expect(
			sanitizeDialogText('Destroy\n\tfeat/old-ui\u{202e}?\u{200b}  now\u0007')
		).toBe('Destroy feat/old-ui ? now');
		expect(
			sanitizeDialogText('\u{2066}Codex\u{2069} session\u{2028}holds it')
		).toBe('Codex session holds it');
		// Canonical forms compose; main's own copy and lookalikes stay as written.
		expect(sanitizeDialogText('Cafe\u0301')).toBe('Caf\u00e9');
		expect(sanitizeDialogText('Stack 64616c83… · native')).toBe(
			'Stack 64616c83… · native'
		);
		expect(sanitizeDialogText('\u{ff4d}ain')).toBe('\u{ff4d}ain');
		expect(sanitizeDialogText('abcdef', { maxLength: 4 })).toBe('abc…');
		// Bounded by code points: an astral character is never split.
		expect(sanitizeDialogText('😀😀😀😀', { maxLength: 3 })).toBe('😀😀…');
		expect(sanitizeDialogText(' \u{200e}\n ', { fallback: 'unknown' })).toBe(
			'unknown'
		);
		expect(sanitizeDialogText(undefined)).toBe('');
		expect(sanitizeDialogText('x'.repeat(500))).toHaveLength(160);
		expect(sanitizeDialogText('abc', { maxLength: 0 })).toBe('abc');
	});

	it('matches renderer entries while permitting only hash navigation', () => {
		expect(
			urlsMatchWithoutHash(
				'file:///Applications/ExampleApp/index.html#network',
				'file:///Applications/ExampleApp/index.html'
			)
		).toBe(true);
		expect(
			urlsMatchWithoutHash(
				'file:///Applications/ExampleApp/other.html',
				'file:///Applications/ExampleApp/index.html'
			)
		).toBe(false);
	});

	it('maps only private renderer assets below the generated root', () => {
		const root =
			'/Applications/ExampleApp.app/Contents/Resources/app.asar/dist/renderer';
		expect(packagedRendererAssetPath(root, PACKAGED_RENDERER_URL)).toBe(
			`${root}/index.html`
		);
		expect(
			packagedRendererAssetPath(root, 'rndevtools://app/assets/index.js?v=1')
		).toBe(`${root}/assets/index.js`);
		expect(
			packagedRendererAssetPath(root, 'rndevtools://other/index.html')
		).toBeUndefined();
		expect(
			packagedRendererAssetPath(root, 'rndevtools://app/%2e%2e/main/index.js')
		).toBeUndefined();
		expect(
			packagedRendererAssetPath(root, 'rndevtools://app/private.json')
		).toBeUndefined();
	});

	it('uses a packaged CSP that cannot connect to arbitrary loopback services', () => {
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).toContain(
			"connect-src 'self'"
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).not.toContain(
			'localhost'
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).not.toContain(
			'127.0.0.1'
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).not.toContain(
			"'unsafe-eval'"
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).toContain(
			"img-src 'self' data: blob: rndevtools-capture:"
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).toContain(
			'media-src rndevtools-capture:'
		);
	});
});
