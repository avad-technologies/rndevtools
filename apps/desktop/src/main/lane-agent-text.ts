import {
	type Lane,
	laneAppDirectory,
	laneDevClientLaunchUrl,
	opensLaneDevClient,
} from '../shared/lane-protocol';

/**
 * The lane commands main tells an agent to run, spelled as the CLI parses
 * them (an operation is always its --operation flag): the retry of a lane up
 * or launch that failed on a stored lane, and the shell words they are
 * built of. The router's recoveries and the lane service's own texts share
 * them, so a lane is retried the same way wherever an agent reads it.
 */

/**
 * How a lane up or launch asked for the launch its receipt reports on. A
 * lane up with `launch` false asked for none: it failed while it resumed
 * its stored lane, before any launch.
 */
export type LaneLaunchAsk = {
	operation: 'up' | 'launch';
	launch?: boolean | undefined;
	restart?: boolean | undefined;
	url?: string | undefined;
};

/** What a lane up or launch that failed on a stored lane did not do. */
export function laneVerb(asked: LaneLaunchAsk): 'launch' | 'start' {
	return asked.operation === 'up' && asked.launch === false
		? 'start'
		: 'launch';
}

/** `value` as one shell word: as it is when nothing in it needs quoting. */
export function shellWord(value: string): string {
	return /^[\w./@%+=:,-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * What to run once the cause of a launch that failed on a stored lane is
 * fixed. Lane up is idempotent: it starts the lane's Metro again when it
 * exited and ensures its backend, then launches, so a lane up is retried as
 * itself. Its retry leaves the udid out, as a first lane up does: lane up
 * for the app's directory resumes its lane on whichever Simulator the lane
 * runs on. Lane launch only opens the app against a running Metro and a
 * backend that serves it, so it is retried as itself only then, and through
 * lane up otherwise. A deep link is named, never repeated: it may hold a
 * token. A lane with no URL scheme opens its dev client only through a
 * launch with a full URL, which lane up cannot take, so that is its retry.
 */
export function laneRetryRecovery(
	lane: Lane,
	asked: LaneLaunchAsk,
	{
		interrupted,
		backendFailed,
	}: {
		/** Cancelled or stopped at a deadline: nothing failed to fix first. */
		interrupted: boolean;
		backendFailed: boolean;
	}
): string {
	const restart = asked.restart ? ' --restart' : '';
	const environment =
		lane.environment === 'development'
			? ''
			: ` --environment ${lane.environment}`;
	// A lane up that asked for no launch is retried without one.
	const opens = laneVerb(asked) === 'launch';
	const upBare = `rndevtools lane --operation up --worktree ${shellWord(laneAppDirectory(lane))}${environment}`;
	const up = `${upBare}${opens ? restart : ' --launch=false'}`;
	const launch = `rndevtools lane --operation launch --lane-id ${lane.id}`;
	const log = `\`rndevtools lane --operation log --lane-id ${lane.id}\` shows Metro's output.`;
	const run = interrupted ? 'Run' : 'Once the cause is fixed, run';
	if (opens && asked.url === undefined && !lane.scheme) {
		// A lane reads its scheme from app.json only when it starts, so one
		// with none never opens its dev client without a URL, however it is
		// retried, and lane up takes no URL.
		const url = shellWord(laneDevClientLaunchUrl('<scheme>', lane.port));
		const first =
			lane.metro === 'stopped' || backendFailed
				? `, once \`${upBare} --launch=false\` has started ${backendFailed ? 'its backend' : 'Metro'} again`
				: '';
		return `Lane ${lane.id} has no URL scheme for its dev client: the worktree's app.json gave none when the lane started, and a lane keeps what it started with. Only a launch with a full URL opens it${first}: \`${launch} --url ${url}${restart}\`, with <scheme> the URL scheme the app registers. Or declare a scheme in app.json and replace the lane: \`rndevtools lane --operation down --lane-id ${lane.id}\`, then \`${upBare}\`. ${log}`;
	}
	if (asked.operation === 'up') {
		return `The lane keeps its Simulator and port ${lane.port}. ${run} \`${up}\` to ${opens ? 'launch' : 'start'} it again; it starts Metro again first if Metro exited. ${log}`;
	}
	if ((lane.metro === 'stopped' || backendFailed) && !lane.scheme) {
		// Only a launch with a URL gets here for a lane with no scheme. Lane up
		// cannot open its dev client, so it starts what the launch needs and
		// nothing more, and the dev client opens through its full URL: the
		// asked one, when that was it, or else before the deep link.
		const url = shellWord(laneDevClientLaunchUrl('<scheme>', lane.port));
		const open = opensLaneDevClient(asked.url ?? '', lane.port)
			? `then \`${launch}${restart}\` with the same --url to open its dev client`
			: `then open its dev client with \`${launch} --url ${url}${restart}\`, with <scheme> the URL scheme the app registers, and then \`${launch}\` with the same --url`;
		return `${
			backendFailed
				? `Lane ${lane.id} requires its local backend, and the launch operation does not start it.`
				: `Metro for lane ${lane.id} is not running, and the launch operation does not start it.`
		} ${run} \`${upBare} --launch=false\` to start ${backendFailed ? 'the backend' : 'Metro again'}, ${open}: the up operation cannot open the dev client of a lane with no URL scheme. ${log}`;
	}
	if (lane.metro === 'stopped' || backendFailed) {
		// lane up opens the dev client (restarting the app when asked), so
		// only a deep link is left to open after it.
		const then =
			asked.url !== undefined ? `, then \`${launch}\` with the same --url` : '';
		return backendFailed
			? `Lane ${lane.id} requires its local backend, and the launch operation does not start it. ${run} \`${up}\` to start the backend and open the dev client${then}. ${log}`
			: `Metro for lane ${lane.id} is not running, and the launch operation does not start it. ${run} \`${up}\` to start Metro again and open the dev client${then}. ${log}`;
	}
	return `The lane keeps its Simulator and its Metro on port ${lane.port}. ${run} \`${launch}${restart}\`${asked.url !== undefined ? ' with the same --url' : ''} to open it again. ${log}`;
}
