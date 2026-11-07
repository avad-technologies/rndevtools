const markerPrefix = 'RN Devtools QA: ';

type ProbeIdentity = Readonly<{ label: string; marker: string }>;

export function readProbeIdentity(config: unknown): ProbeIdentity | undefined {
	if (
		typeof config !== 'object' ||
		config === null ||
		!('label' in config) ||
		typeof config.label !== 'string' ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.label)
	) {
		return undefined;
	}
	return { label: config.label, marker: markerPrefix + config.label };
}

type ProbeStatus =
	| 'unconfigured'
	| 'expected-only'
	| 'missing-expected'
	| 'foreign-marker'
	| 'malformed';

export function checkProbeNotes(
	data: unknown,
	identity: ProbeIdentity | undefined,
): { status: ProbeStatus; notes: string[] } {
	if (!Array.isArray(data)) return { status: 'malformed', notes: [] };
	const notes: string[] = [];
	for (const row of data) {
		if (
			typeof row !== 'object' ||
			row === null ||
			!('body' in row) ||
			typeof row.body !== 'string'
		) {
			return { status: 'malformed', notes: [] };
		}
		notes.push(row.body);
	}
	if (!identity) return { status: 'unconfigured', notes };
	if (!notes.includes(identity.marker)) {
		return { status: 'missing-expected', notes };
	}
	if (
		notes.some(
			(note) => note.startsWith(markerPrefix) && note !== identity.marker,
		)
	) {
		return { status: 'foreign-marker', notes };
	}
	return { status: 'expected-only', notes };
}
