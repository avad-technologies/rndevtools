import { TextArea } from '@heroui/react/textarea';
import {
	CheckCircle2,
	FileJson2,
	History,
	Play,
	RotateCcw,
	ShieldAlert,
	Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	Badge,
	ConfirmAction,
	EmptyPanel,
	InlineCode,
	PanelHeader,
	SectionCard,
	StatusPill,
} from '@/components/ui';
import { formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { ScenarioDefinitionSummary } from '../../shared/protocol';

type VariableDrafts = Readonly<Record<string, string>>;

const IMPORT_TEMPLATE =
	'{\n  "schemaVersion": 1,\n  "namespace": "rndevtools-scenarios",\n  "scenarios": []\n}';

function initialVariables(
	scenario: ScenarioDefinitionSummary | null
): VariableDrafts {
	if (!scenario) return {};
	return Object.fromEntries(
		scenario.variables.flatMap((variable) =>
			variable.defaultValue === undefined
				? []
				: [[variable.id, String(variable.defaultValue)]]
		)
	);
}

function resolvedVariables(
	scenario: ScenarioDefinitionSummary,
	drafts: VariableDrafts
): Readonly<Record<string, string | number | boolean>> {
	const output: Record<string, string | number | boolean> = {};
	for (const variable of scenario.variables) {
		const raw = drafts[variable.id];
		if (raw === undefined || raw === '') {
			if (variable.required && variable.defaultValue === undefined) {
				throw new Error(`${variable.label} is required.`);
			}
			continue;
		}
		if (variable.type === 'number') {
			const number = Number(raw);
			if (!Number.isFinite(number))
				throw new Error(`${variable.label} must be a number.`);
			output[variable.id] = number;
		} else if (variable.type === 'boolean') {
			if (raw !== 'true' && raw !== 'false') {
				throw new Error(`${variable.label} must be true or false.`);
			}
			output[variable.id] = raw === 'true';
		} else {
			output[variable.id] = raw;
		}
	}
	return output;
}

function receiptTone(status: string): 'success' | 'warning' | 'danger' {
	if (status === 'complete') return 'success';
	if (status === 'rolled-back') return 'warning';
	return 'danger';
}

/**
 * Validates the import textarea without mutating device state, so the panel can
 * surface inline feedback and gate the merge trigger before a round-trip.
 */
export function validateScenarioImport(text: string): {
	ok: boolean;
	error?: string;
} {
	const trimmed = text.trim();
	if (trimmed === '') return { ok: false, error: 'Paste a scenario document.' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: 'Document is not valid JSON.' };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: 'Top level must be a JSON object.' };
	}
	const document = parsed as Record<string, unknown>;
	if (!Array.isArray(document.scenarios)) {
		return { ok: false, error: 'Missing a "scenarios" array.' };
	}
	if (document.scenarios.length === 0) {
		return { ok: false, error: 'Add at least one scenario to import.' };
	}
	return { ok: true };
}

export function ScenariosPanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const scenarios = selectedDevice?.tools.scenarios ?? [];
	const runtime = selectedDevice?.tools.scenarioRuntime ?? { running: false };
	const receipts = selectedDevice?.tools.scenarioReceipts ?? [];
	const [selectedId, setSelectedId] = useState<string | null>(
		scenarios[0]?.id ?? null
	);
	const selected =
		scenarios.find((scenario) => scenario.id === selectedId) ??
		scenarios[0] ??
		null;
	const [variablesByScenario, setVariablesByScenario] = useState<
		Readonly<Record<string, VariableDrafts>>
	>({});
	const drafts = selected
		? (variablesByScenario[selected.id] ?? initialVariables(selected))
		: {};
	let variableError: string | undefined;
	let variables: Readonly<Record<string, string | number | boolean>> = {};
	if (selected) {
		try {
			variables = resolvedVariables(selected, drafts);
		} catch (error) {
			variableError =
				error instanceof Error ? error.message : 'Variables are invalid.';
		}
	}
	const [importText, setImportText] = useState(IMPORT_TEMPLATE);
	const importValidation = useMemo(
		() => validateScenarioImport(importText),
		[importText]
	);
	const importReason = actionUnavailableReason('scenarios', 'import');
	const latestReceipt = useMemo(
		() =>
			selected
				? receipts
						.filter((receipt) => receipt.scenarioId === selected.id)
						.sort((left, right) => right.completedAt - left.completedAt)[0]
				: undefined,
		[receipts, selected]
	);
	const executeReason = actionUnavailableReason('scenarios', 'execute');
	const runBlockedReason = runtime.recoveryError
		? 'Corrupt recovery data must be discarded first.'
		: runtime.active
			? 'Undo the active scenario before running another.'
			: runtime.running
				? 'A scenario transaction is already running.'
				: variableError
					? variableError
					: executeReason;

	return (
		<section className="panel-root">
			<PanelHeader
				title="Scenarios"
				description="Run bounded, versioned app-state transactions with full preflight, rollback capture, active-state visibility, and one-tap undo."
				meta={
					runtime.recoveryError ? (
						<span className="flex items-center gap-1.5 text-(--danger-text)">
							<ShieldAlert className="h-3 w-3" /> Recovery data needs attention
						</span>
					) : runtime.active ? (
						<span className="flex items-center gap-1.5 text-(--warning-text)">
							<ShieldAlert className="h-3 w-3" /> {runtime.active.scenarioName}{' '}
							{runtime.active.recoveryRequired ? 'needs recovery' : 'active'}
						</span>
					) : (
						<span className="flex items-center gap-1.5 text-(--brand-text)">
							<CheckCircle2 className="h-3 w-3" /> No scenario override
						</span>
					)
				}
				actions={
					runtime.recoveryError ? (
						<ConfirmAction
							triggerLabel="Discard corrupt journal"
							triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
							title="Discard corrupt recovery data?"
							description="This removes only the unreadable scenario recovery journal. Any app state left by its transaction must be reviewed manually."
							confirmLabel="Discard journal"
							tone="danger"
							isDisabled={!canRunAction('scenarios', 'discardRecovery')}
							onConfirm={() => {
								const recoveryError = runtime.recoveryError;
								if (!recoveryError) return;
								void runAction(
									'scenarios',
									'discardRecovery',
									{ recoveryError },
									'Corrupt scenario recovery journal discarded.'
								);
							}}
						/>
					) : runtime.active ? (
						<ConfirmAction
							triggerLabel="Undo active"
							triggerIcon={<RotateCcw className="h-3.5 w-3.5" />}
							title={`Undo ${runtime.active.scenarioName}?`}
							description="The app will restore every reversible value captured before this scenario ran, in reverse dependency order."
							confirmLabel="Undo changes"
							tone="warning"
							isDisabled={!canRunAction('scenarios', 'undo')}
							onConfirm={() => {
								const active = runtime.active;
								if (!active) return;
								void runAction(
									'scenarios',
									'undo',
									{ receiptId: active.receiptId },
									'Active scenario undone.'
								);
							}}
						/>
					) : null
				}
			/>
			<div className="grid min-h-0 flex-1 grid-cols-[330px_minmax(0,1fr)]">
				<div className="panel-scroll border-r border-foreground/8 p-4">
					<div className="mb-2 flex items-center justify-between px-1">
						<span className="text-xs uppercase tracking-[0.08em] text-(--text-3)">
							Available scenarios
						</span>
						<Badge>{scenarios.length}</Badge>
					</div>
					{scenarios.length === 0 ? (
						<EmptyPanel
							compact
							icon={<Play className="h-5 w-5" />}
							title="No scenarios"
							description="Import a versioned scenario document or connect a build with bundled scenarios."
						/>
					) : (
						<div className="space-y-2">
							{scenarios.map((scenario) => {
								const isSelected = selected?.id === scenario.id;
								return (
									<button
										aria-current={isSelected ? 'true' : undefined}
										aria-pressed={isSelected}
										className={`w-full rounded-lg border p-3 text-left transition-colors ${isSelected ? 'border-(--brand-border) bg-(--brand-soft)' : 'border-foreground/[0.06] bg-foreground/[0.02] hover:border-foreground/12 hover:bg-foreground/[0.04]'}`}
										key={scenario.id}
										type="button"
										onClick={() => setSelectedId(scenario.id)}
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<p className="m-0 truncate text-xs font-medium text-(--foreground)">
													{scenario.name}
												</p>
												<p className="mb-0 mt-1 font-mono text-xs text-(--text-3)">
													{scenario.id} · v{scenario.version}
												</p>
											</div>
											<Badge tone={scenario.bundled ? 'info' : 'default'}>
												{scenario.bundled ? 'Bundled' : 'User'}
											</Badge>
										</div>
									</button>
								);
							})}
						</div>
					)}
					<div className="mt-5">
						<SectionCard
							title="Import user scenarios"
							icon={<FileJson2 className="h-3.5 w-3.5" />}
						>
							<TextArea
								aria-label="Scenario import JSON"
								aria-describedby="scenario-import-feedback"
								aria-invalid={!importValidation.ok}
								className="min-h-36 w-full rounded-md border border-foreground/10 bg-background/30 p-3 font-mono text-xs leading-4 text-(--foreground) outline-none transition-colors focus:border-(--brand-border)"
								maxLength={512 * 1024}
								value={importText}
								onChange={(event) => setImportText(event.currentTarget.value)}
							/>
							<div
								className="mt-2 flex items-center justify-between gap-2"
								id="scenario-import-feedback"
							>
								<span
									className={`text-xs ${importValidation.ok ? 'text-(--brand-text)' : 'text-(--text-3)'}`}
								>
									{importValidation.ok
										? 'Document looks valid — bundled IDs stay protected.'
										: (importValidation.error ?? '')}
								</span>
								<button
									className="text-xs text-(--text-3) underline-offset-2 hover:text-(--foreground) hover:underline"
									type="button"
									onClick={() => setImportText(IMPORT_TEMPLATE)}
								>
									Reset
								</button>
							</div>
							<div className="mt-3">
								<ConfirmAction
									triggerLabel="Merge import"
									title="Import user scenarios?"
									description="Every definition is strictly parsed before the persistent scenario set changes. Bundled IDs cannot be replaced."
									confirmLabel="Validate and merge"
									isDisabled={!importValidation.ok || importReason !== null}
									triggerVariant="secondary"
									onConfirm={() =>
										void runAction(
											'scenarios',
											'import',
											{ json: importText, mode: 'merge' },
											'Scenario document imported.'
										)
									}
								/>
								{importValidation.ok && importReason ? (
									<p className="mb-0 mt-2 text-xs text-(--text-3)">
										{importReason}
									</p>
								) : null}
							</div>
						</SectionCard>
					</div>
				</div>
				<div className="panel-scroll p-6">
					{selected ? (
						<div className="mx-auto max-w-3xl">
							{runtime.recoveryError ? (
								<div className="mb-5 rounded-lg border border-(--danger)/25 bg-(--danger)/[0.08] p-4 text-xs text-(--danger-text)">
									{runtime.recoveryError}
								</div>
							) : null}
							<div className="mb-5 flex items-start justify-between gap-4">
								<div>
									<h2 className="m-0 text-xl font-semibold tracking-[-0.035em] text-(--foreground)">
										{selected.name}
									</h2>
									<p className="mb-0 mt-2 max-w-xl text-xs leading-5 text-(--muted)">
										{selected.description ?? 'No description provided.'}
									</p>
								</div>
								<div className="flex gap-2">
									{!selected.bundled ? (
										<ConfirmAction
											triggerLabel="Delete"
											triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
											title="Delete this user scenario?"
											description="The persistent definition will be removed. Bundled scenarios are immutable."
											confirmLabel="Delete scenario"
											isDisabled={!canRunAction('scenarios', 'remove')}
											onConfirm={() =>
												void runAction(
													'scenarios',
													'remove',
													{
														id: selected.id,
														version: selected.version,
														definitionToken: selected.definitionToken,
													},
													'Scenario deleted.'
												)
											}
										/>
									) : null}
									<ConfirmAction
										triggerLabel="Run"
										triggerIcon={<Play className="h-3.5 w-3.5" />}
										triggerVariant="primary"
										title={`Run ${selected.name}?`}
										description={`The app will preflight all ${selected.steps.length} steps, capture rollback state, then apply sequentially. Privileged and non-reversible steps remain blocked by the mobile engine.`}
										confirmLabel="Run transaction"
										isDisabled={runBlockedReason !== null}
										onConfirm={() => {
											void runAction(
												'scenarios',
												'execute',
												{
													id: selected.id,
													version: selected.version,
													definitionToken: selected.definitionToken,
													variables,
												},
												`${selected.name} activated.`
											);
										}}
									/>
								</div>
							</div>
							{runBlockedReason && !variableError ? (
								<p className="mb-5 mt-[-8px] text-xs text-(--text-3)">
									Run is unavailable: {runBlockedReason}
								</p>
							) : null}
							{selected.variables.length > 0 ? (
								<SectionCard className="mb-5" title="Variables">
									<div className="grid grid-cols-2 gap-3">
										{selected.variables.map((variable) => (
											<label
												className="text-xs text-(--muted)"
												key={variable.id}
											>
												{variable.label}
												{variable.required ? ' *' : ''}
												<input
													className="mt-1 h-9 w-full rounded-md border border-foreground/10 bg-background/30 px-3 text-xs text-(--foreground) outline-none transition-colors focus:border-(--brand-border)"
													value={drafts[variable.id] ?? ''}
													onChange={(event) =>
														setVariablesByScenario((current) => ({
															...current,
															[selected.id]: {
																...drafts,
																[variable.id]: event.target.value,
															},
														}))
													}
												/>
											</label>
										))}
									</div>
									{variableError ? (
										<p className="mb-0 mt-2 text-xs text-(--danger-text)">
											{variableError}
										</p>
									) : null}
								</SectionCard>
							) : null}
							<div className="grid grid-cols-3 overflow-hidden rounded-lg border border-foreground/8 bg-foreground/[0.025]">
								<div className="border-r border-foreground/8 p-4">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Steps
									</p>
									<p className="mb-0 mt-1 font-mono text-lg tabular-nums text-(--foreground)">
										{selected.steps.length}
									</p>
								</div>
								<div className="border-r border-foreground/8 p-4">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Variables
									</p>
									<p className="mb-0 mt-1 font-mono text-lg tabular-nums text-(--foreground)">
										{selected.variables.length}
									</p>
								</div>
								<div className="p-4">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Preconditions
									</p>
									<p className="mb-0 mt-1 font-mono text-lg tabular-nums text-(--foreground)">
										{selected.preconditionCount}
									</p>
								</div>
							</div>
							<div className="mt-5 space-y-2">
								{selected.steps.map((step, index) => (
									<div
										className="flex items-center gap-3 rounded-lg border border-foreground/8 bg-foreground/[0.02] p-3"
										key={step.id}
									>
										<span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-foreground/10 font-mono text-xs tabular-nums text-(--muted)">
											{index + 1}
										</span>
										<div>
											<p className="m-0 text-xs font-medium text-(--foreground)">
												{step.label ?? step.id}
											</p>
											<div className="mt-1">
												<InlineCode>{step.type}</InlineCode>
											</div>
										</div>
									</div>
								))}
							</div>
							{latestReceipt ? (
								<SectionCard
									className="mt-5"
									title="Latest transaction"
									icon={<History className="h-3.5 w-3.5" />}
									actions={
										<StatusPill tone={receiptTone(latestReceipt.status)}>
											{latestReceipt.status}
										</StatusPill>
									}
								>
									<p className="m-0 text-xs text-(--text-3)">
										{formatRelativeTime(latestReceipt.completedAt)} ·{' '}
										{latestReceipt.stepResults.length} step results
									</p>
									{latestReceipt.error ? (
										<p className="mb-0 mt-2 text-xs text-(--danger-text)">
											{latestReceipt.error}
										</p>
									) : null}
								</SectionCard>
							) : null}
						</div>
					) : (
						<EmptyPanel
							icon={<Play className="h-5 w-5" />}
							title="Select a scenario"
							description="Review its transaction before running it on the connected app."
						/>
					)}
				</div>
			</div>
		</section>
	);
}
