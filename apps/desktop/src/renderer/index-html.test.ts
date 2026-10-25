import { describe, expect, it } from 'vitest';
import html from './index.html?raw';

describe('renderer HTML security policy', () => {
	it('leaves frame ancestry to the packaged response header', () => {
		expect(html).toContain("default-src 'self'");
		expect(html).not.toContain('frame-ancestors');
	});
});

describe('renderer HTML theme', () => {
	it('leaves the theme to the appearance setting', () => {
		expect(html).toContain('<meta name="color-scheme" content="light dark" />');
		expect(html).not.toMatch(/<html[^>]*\b(class|data-theme)=/);
	});
});
