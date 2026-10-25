import {
	DEFAULT_RECIPE_RUN_CONCURRENCY,
	type RecipeDefinition,
	type RecipeStep,
	type RecipeSummary,
	RNDEVTOOLS_RECIPE_FORMAT_VERSION,
	recipeDefinitionSchema,
} from '../../shared/recipe-protocol';

export const RECIPE_STEP_PALETTE = [
	{
		kind: 'simulator',
		label: 'Simulator',
		description: 'Device and app action',
	},
	{
		kind: 'semantic',
		label: 'Semantic action',
		description: 'Target an app component',
	},
	{
		kind: 'network',
		label: 'Network profile',
		description: 'Shape instrumented fetch',
	},
	{
		kind: 'camera',
		label: 'Camera fixture',
		description: 'Set app-scoped camera input',
	},
	{
		kind: 'capture',
		label: 'Capture',
		description: 'Save screenshot evidence',
	},
	{ kind: 'wait', label: 'Wait', description: 'Pause for a fixed duration' },
	{
		kind: 'wait-for',
		label: 'Wait for',
		description: 'Poll a bounded condition',
	},
	{ kind: 'assert', label: 'Assert', description: 'Require an observed state' },
	{
		kind: 'restore-point',
		label: 'Restore point',
		description: 'Capture or restore state',
	},
	{
		kind: 'slimming.mutation',
		label: 'Slimming mutation',
		description: 'Experimental service profile',
	},
] as const satisfies ReadonlyArray<{
	kind: RecipeStep['kind'];
	label: string;
	description: string;
}>;

export type RecipeStepKind = (typeof RECIPE_STEP_PALETTE)[number]['kind'];
export type RecipeLane = 'steps' | 'teardown';

export type RecipeValidationIssue = {
	path: string;
	message: string;
};

type RecipeApprovalFinding = {
	stepId: string;
	lane: RecipeLane;
	category: 'destructive' | 'privacy' | 'slimming' | 'state-mutation';
	label: string;
	detail: string;
};

export type RecipeApprovalAnalysis = {
	findings: RecipeApprovalFinding[];
	destructiveCount: number;
	privacyCount: number;
	slimmingCount: number;
	mutationCount: number;
};

type SimulatorOperation = Extract<
	RecipeStep,
	{ kind: 'simulator' }
>['action']['operation'];
type SemanticOperation = Extract<
	RecipeStep,
	{ kind: 'semantic' }
>['action']['action'];
type WaitForCondition = Extract<
	RecipeStep,
	{ kind: 'wait-for' }
>['waitFor']['condition'];
type AssertionCondition = Extract<
	RecipeStep,
	{ kind: 'assert' }
>['assertion']['condition'];
type CameraFixtureKind = Extract<
	Extract<RecipeStep, { kind: 'camera' }>,
	{ operation: 'set' }
>['fixture']['fixtureKind'];

export function createRecipeDefinition(input: {
	id: string;
	name?: string;
	now: number;
}): RecipeDefinition {
	return {
		formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
		id: input.id,
		name: input.name ?? 'Untitled recipe',
		description: '',
		revision: 1,
		createdAt: input.now,
		updatedAt: input.now,
		defaultConcurrency: DEFAULT_RECIPE_RUN_CONCURRENCY,
		steps: [createRecipeStep('wait', 'step-1')],
		teardown: [],
	};
}

export function duplicateRecipeDefinition(
	source: RecipeDefinition,
	input: { id: string; now: number }
): RecipeDefinition {
	const { recipe: sanitizedSource } = stripRecipeAcknowledgements(source);
	return {
		...sanitizedSource,
		id: input.id,
		name: `${source.name} copy`.slice(0, 128),
		revision: 1,
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function prepareRecipeForSave(
	draft: RecipeDefinition,
	input: { now: number; persisted?: RecipeSummary }
): { ok: true; recipe: RecipeDefinition } | { ok: false; error: string } {
	if (input.persisted && input.persisted.revision !== draft.revision) {
		return {
			ok: false,
			error: `Revision ${input.persisted.revision} is stored, but this editor is based on revision ${draft.revision}. Reload before saving.`,
		};
	}
	const { recipe: sanitizedDraft } = stripRecipeAcknowledgements(draft);
	const candidate = {
		...sanitizedDraft,
		revision: input.persisted ? draft.revision + 1 : draft.revision,
		updatedAt: Math.max(input.now, draft.createdAt),
	};
	const result = recipeDefinitionSchema.safeParse(candidate);
	if (!result.success) {
		return {
			ok: false,
			error: result.error.issues[0]?.message ?? 'Recipe validation failed.',
		};
	}
	return { ok: true, recipe: result.data };
}

/**
 * Experimental compatibility acknowledgements are runtime authority, not recipe
 * data. Strip legacy/imported copies before they enter the editor or persistence.
 */
export function stripRecipeAcknowledgements(source: RecipeDefinition): {
	recipe: RecipeDefinition;
	removed: boolean;
} {
	const recipe = structuredClone(source);
	let removed = false;
	for (const step of [...recipe.steps, ...recipe.teardown]) {
		if (
			step.kind === 'slimming.mutation' &&
			step.acknowledgement !== undefined
		) {
			delete step.acknowledgement;
			removed = true;
		}
	}
	return { recipe, removed };
}

export function validateRecipeDefinition(
	draft: RecipeDefinition
): RecipeValidationIssue[] {
	const result = recipeDefinitionSchema.safeParse(draft);
	const issues: RecipeValidationIssue[] = result.success
		? []
		: result.error.issues.map((issue) => ({
				path: issue.path.length === 0 ? 'recipe' : issue.path.join('.'),
				message: issue.message,
			}));
	const inspectMedia = (steps: RecipeStep[], lane: RecipeLane) => {
		steps.forEach((step, index) => {
			if (
				step.kind === 'camera' &&
				step.operation === 'set' &&
				(step.fixture.fixtureKind === 'still' ||
					step.fixture.fixtureKind === 'qr' ||
					step.fixture.fixtureKind === 'video') &&
				step.fixture.dataBase64 === 'AAAA'
			) {
				issues.push({
					path: `${lane}.${index}.fixture.dataBase64`,
					message: 'Choose a bounded media file for this camera fixture.',
				});
			}
		});
	};
	inspectMedia(draft.steps, 'steps');
	inspectMedia(draft.teardown, 'teardown');
	return issues;
}

export function issuesForPath(
	issues: readonly RecipeValidationIssue[],
	path: string
): RecipeValidationIssue[] {
	return issues.filter(
		(issue) => issue.path === path || issue.path.startsWith(`${path}.`)
	);
}

export function createRecipeStep(kind: RecipeStepKind, id: string): RecipeStep {
	switch (kind) {
		case 'simulator':
			return { id, kind, action: createSimulatorAction('device.boot') };
		case 'semantic':
			return { id, kind, action: createSemanticAction('highlight') };
		case 'network':
			return { id, kind, operation: 'clear' };
		case 'camera':
			return { id, kind, operation: 'clear' };
		case 'capture':
			return { id, kind, format: 'png', mask: 'alpha' };
		case 'wait':
			return { id, kind, durationMs: 1_000 };
		case 'wait-for':
			return { id, kind, waitFor: createWaitForCondition('network.idle') };
		case 'assert':
			return { id, kind, assertion: createAssertion('simulator.state') };
		case 'restore-point':
			return { id, kind, operation: 'capture', saveAs: 'checkpoint' };
		case 'slimming.mutation':
			return {
				id,
				kind,
				operation: 'undo',
			};
	}
}

export function createSimulatorAction(
	operation: SimulatorOperation
): Extract<RecipeStep, { kind: 'simulator' }>['action'] {
	switch (operation) {
		case 'device.boot':
		case 'device.shutdown':
		case 'location.clear':
		case 'statusBar.clear':
			return { operation };
		case 'app.launch':
			return {
				operation,
				bundleIdentifier: 'com.example.app',
				terminateRunning: false,
				arguments: [],
			};
		case 'app.terminate':
			return { operation, bundleIdentifier: 'com.example.app' };
		case 'pasteboard.sync':
			return { operation, direction: 'host-to-simulator' };
		case 'url.open':
			return { operation, url: 'https://example.com' };
		case 'location.set':
			return { operation, latitude: 37.3349, longitude: -122.009 };
		case 'location.start':
			return {
				operation,
				waypoints: [
					{ latitude: 37.3349, longitude: -122.009 },
					{ latitude: 37.3318, longitude: -122.0312 },
				],
				speedMetersPerSecond: 3,
			};
		case 'push.send':
			return {
				operation,
				bundleIdentifier: 'com.example.app',
				payloadJson: '{"aps":{"alert":"Test notification"}}',
			};
		case 'privacy.update':
			return {
				operation,
				privacyOperation: 'grant',
				service: 'location',
				bundleIdentifier: 'com.example.app',
			};
		case 'ui.appearance':
			return { operation, value: 'dark' };
		case 'ui.update':
			return { operation, setting: 'appearance', value: 'dark' };
		case 'statusBar.override':
			return { operation, overrides: { time: '9:41' } };
		case 'keychain.reset':
			return { operation };
	}
}

export function createSemanticAction(
	action: SemanticOperation
): Extract<RecipeStep, { kind: 'semantic' }>['action'] {
	switch (action) {
		case 'highlight':
		case 'activate':
		case 'focus':
			return { action, componentId: 'primary-action' };
		case 'setText':
			return { action, componentId: 'text-input', text: '' };
		case 'scroll':
			return {
				action,
				componentId: 'scroll-container',
				direction: 'down',
				amount: 0.75,
			};
	}
}

export function createWaitForCondition(
	condition: WaitForCondition
): Extract<RecipeStep, { kind: 'wait-for' }>['waitFor'] {
	switch (condition) {
		case 'component.exists':
			return { condition, componentId: 'primary-action' };
		case 'screen.change':
			return { condition };
		case 'network.idle':
			return { condition, quietMs: 1_000 };
	}
}

export function createAssertion(
	condition: AssertionCondition
): Extract<RecipeStep, { kind: 'assert' }>['assertion'] {
	switch (condition) {
		case 'simulator.state':
			return { condition, expected: 'booted' };
		case 'connected':
			return { condition, expected: true };
		case 'component.exists':
			return { condition, componentId: 'primary-action', expected: true };
		case 'screen.hash':
			return { condition, expectedHash: 'screen-hash' };
		case 'network.profile':
			return { condition, expectedProfileId: 'none' };
		case 'camera.active':
			return { condition, expected: true };
	}
}

export function createCameraFixture(
	fixtureKind: CameraFixtureKind
): Extract<
	Extract<RecipeStep, { kind: 'camera' }>,
	{ operation: 'set' }
>['fixture'] {
	switch (fixtureKind) {
		case 'unavailable':
			return { fixtureKind, label: 'Unavailable camera' };
		case 'error':
			return {
				fixtureKind,
				label: 'Camera provider error',
				errorMessage: 'Camera is unavailable in this test.',
			};
		case 'still':
		case 'qr':
			return {
				fixtureKind,
				label: 'Image fixture',
				mimeType: 'image/png',
				dataBase64: 'AAAA',
				width: 1,
				height: 1,
			};
		case 'video':
			return {
				fixtureKind,
				label: 'Video fixture',
				mimeType: 'video/mp4',
				dataBase64: 'AAAA',
				width: 1,
				height: 1,
				durationMs: 1,
			};
	}
}

export function recipeStepTitle(step: RecipeStep): string {
	if (step.label?.trim()) return step.label.trim();
	switch (step.kind) {
		case 'simulator':
			return step.action.operation;
		case 'semantic':
			return step.action.action;
		case 'network':
			return step.operation === 'set'
				? `network.${step.profileId ?? 'profile'}`
				: 'network.clear';
		case 'camera':
			return step.operation === 'set'
				? `camera.${step.fixture.fixtureKind}`
				: 'camera.clear';
		case 'capture':
			return step.name ?? `capture.${step.format}`;
		case 'wait':
			return `wait ${step.durationMs} ms`;
		case 'wait-for':
			return `wait for ${step.waitFor.condition}`;
		case 'assert':
			return `assert ${step.assertion.condition}`;
		case 'restore-point':
			return `restore point ${step.operation}`;
		case 'slimming.mutation':
			return `slimming ${step.operation}`;
	}
}

export function analyzeRecipeApprovals(
	recipe: RecipeDefinition
): RecipeApprovalAnalysis {
	const findings: RecipeApprovalFinding[] = [];
	const inspect = (step: RecipeStep, lane: RecipeLane) => {
		const add = (
			category: RecipeApprovalFinding['category'],
			label: string,
			detail: string
		) => findings.push({ stepId: step.id, lane, category, label, detail });
		switch (step.kind) {
			case 'simulator':
				switch (step.action.operation) {
					case 'device.shutdown':
					case 'app.terminate':
						add(
							'destructive',
							step.action.operation,
							'Terminates a running target or application.'
						);
						break;
					case 'location.set':
					case 'location.clear':
					case 'location.start':
						add(
							'privacy',
							step.action.operation,
							'Changes the Simulator location fixture; it does not grant system privacy permission.'
						);
						break;
					case 'pasteboard.sync':
						add(
							'privacy',
							step.action.operation,
							'Transfers clipboard contents in the selected direction between the host and Simulator.'
						);
						break;
					case 'push.send':
						add(
							'privacy',
							step.action.operation,
							'Injects a bounded push payload into the selected app sandbox.'
						);
						break;
					case 'privacy.update':
						add(
							'privacy',
							`${step.action.privacyOperation} ${step.action.service}`,
							'Changes an allowlisted Simulator privacy service for the exact bundle identifier.'
						);
						if (step.action.privacyOperation === 'reset') {
							add(
								'destructive',
								'privacy reset',
								'Removes persisted privacy decisions and requires exact native approval.'
							);
						}
						break;
					case 'keychain.reset':
						add(
							'destructive',
							step.action.operation,
							'Permanently clears the selected Simulator keychain and requires exact native approval.'
						);
						break;
					default:
						add(
							'state-mutation',
							step.action.operation,
							'Changes the selected Simulator or application state.'
						);
				}
				break;
			case 'semantic':
				if (step.action.action !== 'highlight') {
					add(
						'state-mutation',
						step.action.action,
						'Invokes an allowlisted semantic action in the connected development app.'
					);
				}
				break;
			case 'network':
				add(
					'state-mutation',
					`network.${step.operation}`,
					'Changes only the instrumented fetch profile.'
				);
				break;
			case 'camera':
				add(
					'privacy',
					`camera.${step.operation}`,
					'Changes only the app’s instrumented camera fixture; it does not grant or revoke camera access.'
				);
				break;
			case 'restore-point':
				if (step.operation !== 'capture') {
					add(
						'destructive',
						`restore-point.${step.operation}`,
						'Restores or removes a previously captured state boundary.'
					);
				}
				break;
			case 'slimming.mutation':
				add(
					'slimming',
					`slimming.${step.operation}`,
					'Uses the experimental, compatibility-gated SimSlim mutation helper.'
				);
				break;
			case 'capture':
			case 'wait':
			case 'wait-for':
			case 'assert':
				break;
		}
	};
	for (const step of recipe.steps) inspect(step, 'steps');
	for (const step of recipe.teardown) inspect(step, 'teardown');
	return {
		findings,
		destructiveCount: findings.filter((item) => item.category === 'destructive')
			.length,
		privacyCount: findings.filter((item) => item.category === 'privacy').length,
		slimmingCount: findings.filter((item) => item.category === 'slimming')
			.length,
		mutationCount: findings.filter((item) => item.category === 'state-mutation')
			.length,
	};
}
