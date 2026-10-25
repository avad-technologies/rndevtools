import path from 'node:path';
import { URL } from 'node:url';
import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';

const MAX_ERROR_TEXT_LENGTH = 4 * 1024;
const MAX_EXTERNAL_URL_LENGTH = 8 * 1024;
const MAX_LOOPBACK_URL_LENGTH = 2 * 1024;
/** The literal loopback hosts local services listen on, as URL parses them. */
const LOOPBACK_LITERAL_HOSTS = new Set(['127.0.0.1', '[::1]']);
const DEFAULT_DIALOG_TEXT_LENGTH = 160;
const RENDERER_ASSET_EXTENSIONS = new Set([
	'.css',
	'.html',
	'.js',
	'.png',
	'.svg',
	'.woff2',
]);

export const PACKAGED_RENDERER_SCHEME = 'rndevtools';
export const PACKAGED_RENDERER_URL = `${PACKAGED_RENDERER_SCHEME}://app/index.html`;
export const PACKAGED_RENDERER_CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: rndevtools-capture:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"frame-src 'none'",
	"frame-ancestors 'none'",
	"worker-src 'none'",
	'media-src rndevtools-capture:',
	"base-uri 'self'",
	"form-action 'self'",
].join('; ');

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		normalized === 'localhost' ||
		normalized === '::1' ||
		normalized === '0:0:0:0:0:0:0:1' ||
		/^127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

/**
 * electron-vite provides this URL during local development. Packaged builds
 * must never grant the preload bridge to content selected through an ambient
 * environment variable.
 */
export function trustedDevelopmentRendererUrl(
	value: string | undefined,
	isPackaged: boolean
): string | undefined {
	if (isPackaged || !value || value.length > MAX_EXTERNAL_URL_LENGTH)
		return undefined;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== 'http:' && url.protocol !== 'https:') ||
			!isLoopbackHostname(url.hostname) ||
			url.username ||
			url.password
		) {
			return undefined;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

/**
 * The URL `shell.openExternal` may open for a local service main resolved
 * itself, such as Mailpit or Studio: `http://127.0.0.1:<port>` or
 * `http://[::1]:<port>`, optionally with a path, written canonically, with no
 * credentials, query or fragment. `localhost`, other addresses, https and
 * every other scheme are refused, so a bad value can never open a remote
 * page or hand a URL to another application.
 */
export function trustedLoopbackHttpUrl(value: string): string | undefined {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_LOOPBACK_URL_LENGTH ||
		/[?#]/.test(value)
	) {
		return undefined;
	}
	try {
		const url = new URL(value);
		const port = Number(url.port);
		if (
			url.protocol !== 'http:' ||
			!LOOPBACK_LITERAL_HOSTS.has(url.hostname) ||
			!isLoopbackHostname(url.hostname) ||
			!Number.isInteger(port) ||
			port < 1 ||
			url.username ||
			url.password ||
			(url.href !== value && url.href !== `${value}/`)
		) {
			return undefined;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

function isDialogControl(codePoint: number): boolean {
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		// The Arabic letter mark, left-to-right and right-to-left marks.
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		// Line and paragraph separators, bidirectional embeddings and overrides.
		(codePoint >= 0x2028 && codePoint <= 0x202e) ||
		// Bidirectional isolates.
		(codePoint >= 0x2066 && codePoint <= 0x2069) ||
		// Invisible spacing: the zero-width space and byte-order mark.
		codePoint === 0x200b ||
		codePoint === 0xfeff
	);
}

/**
 * Makes text safe for one line of a native dialog: canonically composed
 * (NFC), control, bidirectional and invisible characters replaced with
 * spaces, whitespace collapsed, and the result bounded to `maxLength` code
 * points with an ellipsis. Compatibility forms are kept, so a full-width
 * lookalike of a branch name still reads differently from the real one.
 * Empty text becomes the fallback.
 */
export function sanitizeDialogText(
	value: string | undefined,
	options: Readonly<{ maxLength?: number; fallback?: string }> = {}
): string {
	const maxLength =
		options.maxLength !== undefined &&
		Number.isInteger(options.maxLength) &&
		options.maxLength > 0
			? options.maxLength
			: DEFAULT_DIALOG_TEXT_LENGTH;
	const cleaned = Array.from((value ?? '').normalize('NFC'), (character) =>
		isDialogControl(character.codePointAt(0) ?? 0) ? ' ' : character
	)
		.join('')
		.replace(/\s+/gu, ' ')
		.trim();
	if (!cleaned) return options.fallback ?? '';
	const characters = Array.from(cleaned);
	return characters.length <= maxLength
		? cleaned
		: `${characters.slice(0, maxLength - 1).join('')}…`;
}

/** A thrown value as text that may leave main: redacted, at most 4 KiB. */
export function safeErrorText(error: unknown): string {
	return redactDiagnosticText(diagnosticErrorText(error)).slice(
		0,
		MAX_ERROR_TEXT_LENGTH
	);
}

export function urlsMatchWithoutHash(left: string, right: string): boolean {
	try {
		const leftUrl = new URL(left);
		const rightUrl = new URL(right);
		leftUrl.hash = '';
		rightUrl.hash = '';
		return leftUrl.href === rightUrl.href;
	} catch {
		return false;
	}
}

/**
 * Maps the private renderer origin to the generated renderer directory only.
 * The custom protocol lets packaged builds keep Electron's legacy file://
 * privileges disabled without exposing arbitrary local files to the renderer.
 */
export function packagedRendererAssetPath(
	rendererRoot: string,
	requestUrl: string
): string | undefined {
	if (requestUrl.length > MAX_EXTERNAL_URL_LENGTH) return undefined;
	try {
		const url = new URL(requestUrl);
		if (
			url.protocol !== `${PACKAGED_RENDERER_SCHEME}:` ||
			url.hostname !== 'app' ||
			url.port ||
			url.username ||
			url.password
		) {
			return undefined;
		}
		const authorityOffset = requestUrl.indexOf('://') + 3;
		const rawPathOffset = requestUrl.indexOf('/', authorityOffset);
		const rawPath =
			rawPathOffset === -1
				? '/'
				: (requestUrl.slice(rawPathOffset).split(/[?#]/, 1)[0] ?? '/');
		const pathname = decodeURIComponent(rawPath);
		if (
			!pathname.startsWith('/') ||
			pathname.includes('\\') ||
			pathname.includes('\0')
		) {
			return undefined;
		}
		const segments = pathname.split('/').filter(Boolean);
		if (segments.length === 0) segments.push('index.html');
		if (segments.some((segment) => segment === '.' || segment === '..')) {
			return undefined;
		}
		const root = path.resolve(rendererRoot);
		const candidate = path.resolve(root, ...segments);
		if (!candidate.startsWith(`${root}${path.sep}`)) return undefined;
		if (!RENDERER_ASSET_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
			return undefined;
		}
		return candidate;
	} catch {
		return undefined;
	}
}
