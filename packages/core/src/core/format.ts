export function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(
	timestamp: number,
	now = Date.now(),
): string | undefined {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	const safeNow = Number.isFinite(now) ? now : timestamp;
	const seconds = Math.floor(Math.max(0, safeNow - timestamp) / 1000);
	if (seconds < 1) return 'now';
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * The single duration formatter for every diagnostic surface. Three copies had
 * drifted apart — the desktop renderer, the network panel and the performance
 * panel each rendered 2000ms differently ('2.00 s', '2.0 s', '2 s').
 */
export function formatDuration(durationMs: number | undefined): string {
	if (
		durationMs === undefined ||
		!Number.isFinite(durationMs) ||
		durationMs < 0
	) {
		return '—';
	}
	if (durationMs < 1) return '<1 ms';
	if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
	return `${(durationMs / 1000).toFixed(1)} s`;
}
