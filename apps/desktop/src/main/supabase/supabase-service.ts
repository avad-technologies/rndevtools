import type { SupabaseState } from '../../shared/supabase-protocol';
import { createSupabaseDemoService } from './demo-service';
import { SupabaseEngine } from './service-engine';
import type {
	CreateSupabaseService,
	SupabaseServiceDeps,
} from './service-ports';

/**
 * The Supabase service main wires up: the orchestrator (SupabaseEngine) for
 * this Mac, or the in-memory demo stacks in demo mode. Off, or on a Mac
 * that can't run native stacks, the orchestrator runs no process at all.
 */

const PLATFORM_REASON =
	'Native Supabase needs Apple silicon and macOS 14 or later.';
const ARCH = /^[A-Za-z0-9_-]{1,32}$/;
const MACOS_VERSION = /^(\d{1,3})(?:\.\d{1,3}){0,2}$/;

/**
 * Whether this Mac can run native stacks (Apple silicon, macOS 14 or later),
 * from what Electron reports and without spawning anything. An unreadable
 * version counts as unsupported.
 */
export function supabasePlatformAvailability(
	platform: SupabaseServiceDeps['platform']
): SupabaseState['availability']['platform'] {
	const version =
		platform.platform === 'darwin' ? (platform.macosVersion?.trim() ?? '') : '';
	const match = MACOS_VERSION.exec(version);
	const arch = ARCH.test(platform.arch) ? platform.arch : '';
	const supported =
		platform.platform === 'darwin' &&
		arch === 'arm64' &&
		Number(match?.[1]) >= 14;
	return {
		supported,
		arch,
		macosVersion: match ? version : '',
		...(supported ? {} : { reasonText: PLATFORM_REASON }),
	};
}

export const createSupabaseService: CreateSupabaseService = (deps) => {
	const platform = supabasePlatformAvailability(deps.platform);
	return deps.demo
		? createSupabaseDemoService(deps, platform)
		: new SupabaseEngine(deps, { platform });
};
