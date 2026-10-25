import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Test support for the recorded Supabase CLI 2.121.0 fixtures. Fixtures hold
 * placeholders such as `<secret-key>` instead of key material; tests that need
 * realistic shapes build them at runtime with withRealisticSecrets, so no
 * secret-shaped string is ever committed.
 */

const FIXTURE_DIRECTORY = fileURLToPath(
	new URL('./__fixtures__/supabase-2.121.0/', import.meta.url)
);

/** The fixtures this adapter owns, in the dialect's fixture set. */
export const SUPABASE_CLI_FIXTURES = [
	'version',
	'list-running',
	'list-stopped',
	'list-empty',
	'list-unreadable',
	'status-sleeping',
	'status-awake',
	'status-stopped',
	'status-unknown-id',
	'status-release-mismatch',
	'status-never-started',
	'start-fresh',
	'start-resume-studio',
	'start-already-running',
	'start-endpoint-changes',
	'start-port-conflict',
	'start-needs-recreate',
	'start-runtime-mismatch',
	'stop',
	'restart',
	'destroy-single',
	'destroy-multiple',
	'destroy-partial',
	'logs',
	'prepare',
	'migration-list',
	'migration-up',
	'db-reset',
	'inspect-db-stats',
	'inspect-table-stats',
	'db-dump',
	'seed-buckets',
	'error-status-no-stack',
	'error-local-db-not-running',
	'error-db-connect-tls',
	'error-db-connect-refused',
	'error-release-mismatch',
] as const;

export type SupabaseCliFixtureName = (typeof SUPABASE_CLI_FIXTURES)[number];

type SupabaseCliFixture = Readonly<{
	name: SupabaseCliFixtureName;
	cli: string;
	surface: string;
	provenance: 'recorded' | 'synthesized';
	source: string;
	exitCode: number;
	stdout?: unknown;
	stdoutText?: string;
	stderr: readonly string[];
}>;

export function loadSupabaseCliFixture(
	name: SupabaseCliFixtureName
): SupabaseCliFixture {
	const parsed = JSON.parse(
		readFileSync(`${FIXTURE_DIRECTORY}${name}.json`, 'utf8')
	) as Omit<SupabaseCliFixture, 'name'>;
	return { ...parsed, name };
}

/** The exact stdout the CLI printed: one JSON line, or raw text. */
export function fixtureStdout(fixture: SupabaseCliFixture): string {
	if (fixture.stdoutText !== undefined) return fixture.stdoutText;
	return `${JSON.stringify(fixture.stdout)}\n`;
}

/** Anything a projection, log or IPC payload must never contain. */
export const SECRET_SHAPED =
	/sb_secret_|sb_publishable_|eyJ[\w-]+\.[\w-]+|postgres(?:ql)?:\/\/[^\s"]*:[^\s"@<]+@|SERVICE_ROLE|SECRET_KEY|S3_PROTOCOL_ACCESS_KEY/;

/**
 * Realistic stand-ins for the fixture placeholders, assembled at runtime so
 * the repository never contains a key-shaped literal.
 */
export function realisticSecrets() {
	const jwt = (claims: string) =>
		['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', claims, '.', 'c2lnbmF0dXJl'].join(
			''
		);
	return {
		publishableKey: ['sb', 'publishable', 'Ab12Cd34Ef56Gh78Ij90Kl12'].join('_'),
		secretKey: ['sb', 'secret', 'Zz09Yy98Xx87Ww76Vv65Uu54'].join('_'),
		anonKey: jwt('JyZWYiOiJhbm9uIn0'),
		serviceRoleKey: jwt('JyZWYiOiJzZXJ2aWNlIn0'),
		s3AccessKey: ['s3', 'access', 'example', '0123'].join('-'),
		s3Secret: ['s3', 'secret', 'example', '4567'].join('-'),
		dbPassword: ['pass', 'word', '-', 'example'].join(''),
		dbUrl: `postgresql://postgres:${['pass', 'word', '-', 'example'].join('')}@127.0.0.1:30630/postgres`,
	};
}

/** Replaces every placeholder in a fixture value with a realistic secret. */
export function withRealisticSecrets(value: unknown): {
	value: unknown;
	secrets: readonly string[];
} {
	const secrets = realisticSecrets();
	const replacements: Readonly<Record<string, string>> = {
		'<publishable-key>': secrets.publishableKey,
		'<secret-key>': secrets.secretKey,
		'<anon-jwt>': secrets.anonKey,
		'<service-role-jwt>': secrets.serviceRoleKey,
		'<s3-access-key>': secrets.s3AccessKey,
		'<s3-secret>': secrets.s3Secret,
		'postgresql://postgres:<password>@127.0.0.1:<port>/postgres': secrets.dbUrl,
	};
	const visit = (current: unknown): unknown => {
		if (typeof current === 'string') return replacements[current] ?? current;
		if (Array.isArray(current)) return current.map(visit);
		if (current !== null && typeof current === 'object') {
			return Object.fromEntries(
				Object.entries(current).map(([key, entry]) => [key, visit(entry)])
			);
		}
		return current;
	};
	return {
		value: visit(value),
		secrets: [
			secrets.publishableKey,
			secrets.secretKey,
			secrets.anonKey,
			secrets.serviceRoleKey,
			secrets.s3AccessKey,
			secrets.s3Secret,
			secrets.dbPassword,
		],
	};
}
