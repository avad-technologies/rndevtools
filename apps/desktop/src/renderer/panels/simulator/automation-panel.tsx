import { AlertDialog } from '@heroui/react/alert-dialog';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { TextArea } from '@heroui/react/textarea';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Accessibility,
	Activity,
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	Camera,
	Check,
	ChevronDown,
	CircleStop,
	Clock3,
	Copy,
	Download,
	FileArchive,
	FileJson,
	Gauge,
	Import,
	Layers3,
	LoaderCircle,
	Network,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Save,
	ShieldAlert,
	Sparkles,
	Trash2,
	TriangleAlert,
} from 'lucide-react';
import {
	type ComponentType,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { RecipeStepEditor } from '@/components/recipe-step-editor';
import { DenseVirtualList } from '@/components/simulator-ui';
import {
	ConfirmAction,
	CopyButton,
	EmptyPanel,
	InfoPopover,
	PanelHeader,
	PanelNotice,
	SearchControl,
	Toolbar,
} from '@/components/ui';
import {
	acknowledgeThenApproveRecipe,
	recipeSlimmingAcknowledgementBinding,
	unknownSlimmingStatusesForRun,
} from '@/simulator/recipe-approval-model';
import {
	analyzeRecipeApprovals,
	createRecipeDefinition,
	createRecipeStep,
	duplicateRecipeDefinition,
	issuesForPath,
	prepareRecipeForSave,
	RECIPE_STEP_PALETTE,
	type RecipeApprovalAnalysis,
	type RecipeLane,
	type RecipeStepKind,
	recipeStepTitle,
	stripRecipeAcknowledgements,
	validateRecipeDefinition,
} from '@/simulator/recipe-model';
import { useRecipeRuntime } from '@/state/recipe-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import {
	DEFAULT_RECIPE_RUN_CONCURRENCY,
	MAX_RECIPE_CONCURRENCY,
	MAX_RECIPE_STEPS,
	MAX_RECIPE_TARGETS,
	type RecipeDefinition,
	type RecipeEvidenceManifest,
	type RecipeRun,
	type RecipeStep,
	type RecipeSummary,
} from '../../../shared/recipe-protocol';
import {
	SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
	type SlimmingSimulatorStatus,
} from '../../../shared/slimming-protocol';

type DraftEntry = { recipe: RecipeDefinition; dirty: boolean };
type DefinitionLoadState =
	| { kind: 'idle' }
	| { kind: 'loading'; recipeId: string }
	| { kind: 'error'; recipeId: string; error: string };
type EvidenceLoadState =
	| { kind: 'idle' }
	| { kind: 'loading'; evidenceId: string }
	| { kind: 'ready'; evidence: RecipeEvidenceManifest }
	| { kind: 'missing'; evidenceId: string }
	| { kind: 'error'; evidenceId: string; error: string };
type EditorView = 'definition' | 'evidence';

const ACTIVE_RUN_STATUSES = new Set<RecipeRun['status']>([
	'queued',
	'needs-approval',
	'resolving',
	'running',
	'cancelling',
]);
const STEP_RENDER_KEYS = new WeakMap<RecipeStep, string>();

export function AutomationPanel() {
	const recipeRuntime = useRecipeRuntime();
	const simulatorRuntime = useSimulatorRuntime();
	const slimmingRuntime = useSlimmingRuntime();
	const [query, setQuery] = useState('');
	const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
	const [definitionLoad, setDefinitionLoad] = useState<DefinitionLoadState>({
		kind: 'idle',
	});
	const [selectedLane, setSelectedLane] = useState<RecipeLane>('steps');
	const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
	const [paletteKind, setPaletteKind] = useState<RecipeStepKind>('simulator');
	const [view, setView] = useState<EditorView>('definition');
	const [targetUdids, setTargetUdids] = useState<string[]>([]);
	const [concurrency, setConcurrency] = useState(
		DEFAULT_RECIPE_RUN_CONCURRENCY
	);
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const [evidenceLoad, setEvidenceLoad] = useState<EvidenceLoadState>({
		kind: 'idle',
	});
	const [localError, setLocalError] = useState<string | null>(null);
	const definitionRequestRef = useRef(0);
	const evidenceRequestRef = useRef(0);

	const persistedById = useMemo(
		() =>
			new Map(
				recipeRuntime.state.recipes.map((summary) => [summary.id, summary])
			),
		[recipeRuntime.state.recipes]
	);
	const recipeSummaries = useMemo(() => {
		const summaries = [...recipeRuntime.state.recipes];
		for (const entry of Object.values(drafts)) {
			if (persistedById.has(entry.recipe.id)) continue;
			const approval = analyzeRecipeApprovals(entry.recipe);
			summaries.push({
				id: entry.recipe.id,
				name: entry.recipe.name,
				description: entry.recipe.description,
				revision: entry.recipe.revision,
				updatedAt: entry.recipe.updatedAt,
				stepCount: entry.recipe.steps.length,
				teardownStepCount: entry.recipe.teardown.length,
				requiresMutationApproval: approval.findings.length > 0,
			});
		}
		return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
	}, [drafts, persistedById, recipeRuntime.state.recipes]);
	const visibleRecipes = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return recipeSummaries.filter(
			(summary) =>
				normalized.length === 0 ||
				`${summary.name} ${summary.description ?? ''} ${summary.id}`
					.toLowerCase()
					.includes(normalized)
		);
	}, [query, recipeSummaries]);
	// The catalog rows that show the unsaved dot, as a key that changes only
	// when one of them does.
	const dirtyRecipeIds = useMemo(
		() =>
			Object.entries(drafts)
				.filter(([, entry]) => entry.dirty)
				.map(([id]) => id)
				.sort()
				.join('\n'),
		[drafts]
	);
	const selectedSummary = selectedRecipeId
		? (recipeSummaries.find((summary) => summary.id === selectedRecipeId) ??
			null)
		: null;
	const selectedEntry = selectedRecipeId ? drafts[selectedRecipeId] : undefined;
	const draft = selectedEntry?.recipe ?? null;
	const validationIssues = useMemo(
		() => (draft ? validateRecipeDefinition(draft) : []),
		[draft]
	);
	const approval = useMemo(
		() => (draft ? analyzeRecipeApprovals(draft) : emptyApprovalAnalysis()),
		[draft]
	);
	const activeSteps = draft?.[selectedLane] ?? [];
	const selectedStepIndex = activeSteps.findIndex(
		(step) => step.id === selectedStepId
	);
	const selectedStep =
		selectedStepIndex >= 0 ? activeSteps[selectedStepIndex] : null;
	const totalStepCount = draft ? draft.steps.length + draft.teardown.length : 0;
	const runsForRecipe = useMemo(
		() =>
			recipeRuntime.state.runs
				.filter((run) => run.recipeId === selectedRecipeId)
				.sort((left, right) => right.createdAt - left.createdAt),
		[recipeRuntime.state.runs, selectedRecipeId]
	);
	const selectedRun =
		runsForRecipe.find((run) => run.id === selectedRunId) ??
		runsForRecipe[0] ??
		null;
	const activeRun = runsForRecipe.find((run) =>
		ACTIVE_RUN_STATUSES.has(run.status)
	);
	const activeRunUnknownSlimmingStatuses = activeRun
		? unknownSlimmingStatusesForRun(
				activeRun,
				slimmingRuntime.state.statusBySimulator
			)
		: [];
	const canSave = Boolean(
		draft &&
			selectedEntry?.dirty &&
			validationIssues.length === 0 &&
			recipeRuntime.isBridgeAvailable
	);
	const concurrencyValid =
		Number.isInteger(concurrency) &&
		concurrency >= 1 &&
		concurrency <= MAX_RECIPE_CONCURRENCY;
	const canRun = Boolean(
		draft &&
			persistedById.has(draft.id) &&
			!selectedEntry?.dirty &&
			validationIssues.length === 0 &&
			targetUdids.length >= 1 &&
			targetUdids.length <= MAX_RECIPE_TARGETS &&
			concurrencyValid &&
			recipeRuntime.isBridgeAvailable
	);

	useEffect(() => {
		if (selectedRecipeId || recipeSummaries.length === 0) return;
		setSelectedRecipeId(recipeSummaries[0]?.id ?? null);
	}, [recipeSummaries, selectedRecipeId]);

	useEffect(() => {
		if (
			!selectedRecipeId ||
			selectedEntry ||
			!persistedById.has(selectedRecipeId)
		)
			return;
		const requestId = definitionRequestRef.current + 1;
		definitionRequestRef.current = requestId;
		setDefinitionLoad({ kind: 'loading', recipeId: selectedRecipeId });
		void recipeRuntime
			.getRecipe(selectedRecipeId)
			.then((recipe) => {
				if (definitionRequestRef.current !== requestId) return;
				if (!recipe) {
					setDefinitionLoad({
						kind: 'error',
						recipeId: selectedRecipeId,
						error: 'The recipe manifest no longer exists.',
					});
					return;
				}
				const sanitized = stripRecipeAcknowledgements(recipe);
				setDrafts((current) => ({
					...current,
					[recipe.id]: { recipe: sanitized.recipe, dirty: sanitized.removed },
				}));
				setConcurrency(sanitized.recipe.defaultConcurrency);
				if (sanitized.removed) {
					setLocalError(
						'Stored experimental acknowledgement was removed. Save this recipe before running, then acknowledge any unknown compatibility tuple from Simulator Slimming.'
					);
				}
				setDefinitionLoad({ kind: 'idle' });
			})
			.catch((error: unknown) => {
				if (definitionRequestRef.current !== requestId) return;
				setDefinitionLoad({
					kind: 'error',
					recipeId: selectedRecipeId,
					error: errorText(error),
				});
			});
	}, [persistedById, recipeRuntime, selectedEntry, selectedRecipeId]);

	useEffect(() => {
		const currentSteps = draft?.[selectedLane] ?? [];
		if (currentSteps.some((step) => step.id === selectedStepId)) return;
		setSelectedStepId(currentSteps[0]?.id ?? null);
	}, [draft, selectedLane, selectedStepId]);

	useEffect(() => {
		setTargetUdids((current) => {
			const available = new Set(
				simulatorRuntime.state.devices.map((device) => device.udid)
			);
			const filtered = current.filter((udid) => available.has(udid));
			if (filtered.length === 0 && simulatorRuntime.selectedDevice) {
				return [simulatorRuntime.selectedDevice.udid];
			}
			return arraysEqual(current, filtered) ? current : filtered;
		});
	}, [simulatorRuntime.selectedDevice, simulatorRuntime.state.devices]);

	useEffect(() => {
		if (!selectedRun) {
			setSelectedRunId(null);
			setEvidenceLoad({ kind: 'idle' });
			return;
		}
		if (selectedRun.id !== selectedRunId) setSelectedRunId(selectedRun.id);
		const requestId = evidenceRequestRef.current + 1;
		evidenceRequestRef.current = requestId;
		setEvidenceLoad((current) =>
			current.kind === 'ready' && current.evidence.id === selectedRun.evidenceId
				? current
				: { kind: 'loading', evidenceId: selectedRun.evidenceId }
		);
		void recipeRuntime
			.getEvidence(selectedRun.evidenceId)
			.then((evidence) => {
				if (evidenceRequestRef.current !== requestId) return;
				setEvidenceLoad(
					evidence
						? { kind: 'ready', evidence }
						: { kind: 'missing', evidenceId: selectedRun.evidenceId }
				);
			})
			.catch((error: unknown) => {
				if (evidenceRequestRef.current !== requestId) return;
				setEvidenceLoad({
					kind: 'error',
					evidenceId: selectedRun.evidenceId,
					error: errorText(error),
				});
			});
	}, [recipeRuntime, selectedRun, selectedRunId]);

	const updateDraft = useCallback((recipe: RecipeDefinition) => {
		setDrafts((current) => ({
			...current,
			[recipe.id]: { recipe, dirty: true },
		}));
	}, []);

	const saveDraft = async () => {
		if (!draft || validationIssues.length > 0) return;
		setLocalError(null);
		const persisted = persistedById.get(draft.id);
		const prepared = prepareRecipeForSave(draft, {
			now: Date.now(),
			...(persisted === undefined ? {} : { persisted }),
		});
		if (!prepared.ok) {
			setLocalError(prepared.error);
			return;
		}
		try {
			const summary = await recipeRuntime.saveRecipe(prepared.recipe);
			setDrafts((current) => ({
				...current,
				[summary.id]: {
					dirty: false,
					recipe: {
						...prepared.recipe,
						revision: summary.revision,
						updatedAt: summary.updatedAt,
					},
				},
			}));
		} catch (error) {
			setLocalError(errorText(error));
		}
	};

	const createRecipe = () => {
		const id = `recipe-${crypto.randomUUID()}`;
		const recipe = createRecipeDefinition({ id, now: Date.now() });
		setDrafts((current) => ({ ...current, [id]: { recipe, dirty: true } }));
		setSelectedRecipeId(id);
		setSelectedLane('steps');
		setSelectedStepId(recipe.steps[0]?.id ?? null);
		setConcurrency(recipe.defaultConcurrency);
		setView('definition');
		setLocalError(null);
	};

	const duplicateRecipe = () => {
		if (!draft) return;
		const id = `${draft.id.slice(0, 210)}-copy-${crypto.randomUUID().slice(0, 8)}`;
		const copy = duplicateRecipeDefinition(draft, { id, now: Date.now() });
		setDrafts((current) => ({
			...current,
			[id]: { recipe: copy, dirty: true },
		}));
		setSelectedRecipeId(id);
		setSelectedLane('steps');
		setSelectedStepId(copy.steps[0]?.id ?? null);
		setConcurrency(copy.defaultConcurrency);
		setView('definition');
	};

	const removeSelectedRecipe = async () => {
		if (!selectedRecipeId) return;
		if (persistedById.has(selectedRecipeId)) {
			const receipt = await recipeRuntime.runFileOperation({
				kind: 'recipe.delete',
				recipeId: selectedRecipeId,
			});
			if (!receipt.completed) return;
		}
		setDrafts((current) => {
			const next = { ...current };
			delete next[selectedRecipeId];
			return next;
		});
		setSelectedRecipeId(
			recipeSummaries.find((summary) => summary.id !== selectedRecipeId)?.id ??
				null
		);
		setLocalError(null);
	};

	const addStep = () => {
		if (!draft || totalStepCount >= MAX_RECIPE_STEPS) return;
		const usedIds = new Set(
			[...draft.steps, ...draft.teardown].map((step) => step.id)
		);
		const prefix = `step-${paletteKind.replace('.', '-')}`;
		let index = totalStepCount + 1;
		let id = `${prefix}-${index}`;
		while (usedIds.has(id)) {
			index += 1;
			id = `${prefix}-${index}`;
		}
		const step = createRecipeStep(paletteKind, id);
		updateDraft({ ...draft, [selectedLane]: [...draft[selectedLane], step] });
		setSelectedStepId(step.id);
	};

	const replaceSelectedStep = (step: RecipeStep) => {
		if (!draft || selectedStepIndex < 0) return;
		const next = [...draft[selectedLane]];
		next[selectedStepIndex] = step;
		updateDraft({ ...draft, [selectedLane]: next });
		setSelectedStepId(step.id);
	};

	const removeSelectedStep = () => {
		if (!draft || selectedStepIndex < 0) return;
		const next = draft[selectedLane].filter(
			(_, index) => index !== selectedStepIndex
		);
		updateDraft({ ...draft, [selectedLane]: next });
		setSelectedStepId(
			next[Math.min(selectedStepIndex, next.length - 1)]?.id ?? null
		);
	};

	const moveSelectedStep = (direction: -1 | 1) => {
		if (!draft || selectedStepIndex < 0) return;
		const destination = selectedStepIndex + direction;
		if (destination < 0 || destination >= draft[selectedLane].length) return;
		const next = [...draft[selectedLane]];
		const current = next[selectedStepIndex];
		const target = next[destination];
		if (!current || !target) return;
		next[selectedStepIndex] = target;
		next[destination] = current;
		updateDraft({ ...draft, [selectedLane]: next });
	};

	const toggleTarget = (udid: string) => {
		setLocalError(null);
		setTargetUdids((current) => {
			if (current.includes(udid))
				return current.filter((value) => value !== udid);
			if (current.length >= MAX_RECIPE_TARGETS) {
				setLocalError(`Select at most ${MAX_RECIPE_TARGETS} exact targets.`);
				return current;
			}
			return [...current, udid];
		});
	};

	const startRun = async () => {
		if (!draft || !canRun) return;
		setLocalError(null);
		const receipt = await recipeRuntime.runRecipe({
			recipeId: draft.id,
			targetUdids,
			concurrency,
		});
		if (!receipt.accepted) {
			setLocalError(receipt.error ?? 'Recipe run was rejected.');
			return;
		}
		if (receipt.runId) {
			setSelectedRunId(receipt.runId);
			setView('evidence');
		}
	};

	const approvePendingRun = async (
		run: RecipeRun,
		typedAcknowledgement?: string
	) => {
		setLocalError(null);
		const receipt = await acknowledgeThenApproveRecipe({
			run,
			statusBySimulator: slimmingRuntime.state.statusBySimulator,
			...(typedAcknowledgement === undefined ? {} : { typedAcknowledgement }),
			acknowledgeCompatibility: slimmingRuntime.acknowledgeCompatibility,
			approveRun: recipeRuntime.approveRun,
		});
		if (!receipt.accepted) {
			setLocalError(receipt.error ?? 'Pending recipe approval was rejected.');
			return;
		}
		if (receipt.runId) {
			setSelectedRunId(receipt.runId);
			setView('evidence');
		}
	};

	const importRecipe = async () => {
		const receipt = await recipeRuntime.runFileOperation({
			kind: 'recipe.import',
		});
		if (receipt.completed && receipt.recipe) {
			setSelectedRecipeId(receipt.recipe.id);
			setView('definition');
		}
	};

	return (
		<section className="panel-root recipe-panel">
			<PanelHeader
				actions={
					<Button
						aria-label="Refresh recipe catalog"
						isDisabled={
							!recipeRuntime.isBridgeAvailable || recipeRuntime.isLoading
						}
						isIconOnly
						size="sm"
						variant="secondary"
						onPress={() => void recipeRuntime.refresh()}
					>
						<RefreshCw
							className={`h-3.5 w-3.5 ${recipeRuntime.isLoading ? 'animate-spin' : ''}`}
						/>
					</Button>
				}
				description="Combine simulator actions into reusable recipes. Choose your simulators, review the steps, and run. Execution history and captured results stay on this Mac."
				meta={`${recipeRuntime.state.recipes.length} saved · ${recipeRuntime.state.runs.length} runs`}
				title="Automation"
			/>
			{!recipeRuntime.isBridgeAvailable ? (
				<PanelNotice title="Recipe provider unavailable." tone="warning">
					Update and reopen the installed desktop app. The renderer cannot save,
					import, export, or run recipes without the narrow Recipe bridge.
				</PanelNotice>
			) : null}
			{recipeRuntime.runtimeError ? (
				<PanelNotice title="Recipe state could not be loaded." tone="danger">
					{recipeRuntime.runtimeError}
				</PanelNotice>
			) : null}
			{localError ? (
				<PanelNotice title="Recipe action needs attention." tone="danger">
					{localError}
				</PanelNotice>
			) : null}
			<Toolbar>
				<SearchControl
					ariaLabel="Search recipes"
					placeholder="Search recipes"
					value={query}
					onChange={setQuery}
				/>
				<span className="sim-toolbar-meta">
					{visibleRecipes.length} recipes
				</span>
				<div className="sim-toolbar-spacer" />
				<Button size="sm" variant="secondary" onPress={createRecipe}>
					<Plus className="h-3.5 w-3.5" /> New recipe
				</Button>
				<Button
					isDisabled={!recipeRuntime.isBridgeAvailable}
					size="sm"
					variant="secondary"
					onPress={() => void importRecipe()}
				>
					<Import className="h-3.5 w-3.5" /> Import
				</Button>
				<Button
					isDisabled={!draft}
					size="sm"
					variant="secondary"
					onPress={duplicateRecipe}
				>
					<Copy className="h-3.5 w-3.5" /> Duplicate
				</Button>
				<Button
					isDisabled={!canSave}
					size="sm"
					variant="primary"
					onPress={() => void saveDraft()}
				>
					<Save className="h-3.5 w-3.5" /> Save
				</Button>
			</Toolbar>
			<div className="sim-automation-layout recipe-workspace">
				<section className="sim-list-pane recipe-catalog">
					{recipeRuntime.isLoading && recipeSummaries.length === 0 ? (
						<div className="recipe-loading-state" role="status">
							<LoaderCircle className="h-4 w-4 animate-spin" /> Loading recipes…
						</div>
					) : (
						<DenseVirtualList
							ariaLabel="Recipe catalog"
							emptyDescription="Create a recipe or import a JSON file."
							emptyTitle={query ? 'No recipes match' : 'No recipes yet'}
							items={visibleRecipes}
							getId={(summary) => summary.id}
							dependencies={[dirtyRecipeIds]}
							rowHeight={72}
							selectedId={selectedRecipeId ?? undefined}
							textValue={(summary) => `${summary.name} ${summary.id}`}
							onSelect={(summary) => {
								setSelectedRecipeId(summary.id);
								setView('definition');
								setLocalError(null);
							}}
							renderItem={(summary) => (
								<RecipeRow
									dirty={drafts[summary.id]?.dirty ?? false}
									summary={summary}
								/>
							)}
						/>
					)}
				</section>
				<section className="sim-scenario-detail recipe-editor-pane panel-scroll">
					{definitionLoad.kind === 'loading' && !draft ? (
						<div className="recipe-loading-state" role="status">
							<LoaderCircle className="h-4 w-4 animate-spin" /> Loading
							definition…
						</div>
					) : definitionLoad.kind === 'error' && !draft ? (
						<EmptyPanel
							compact
							description={definitionLoad.error}
							icon={<TriangleAlert />}
							title="Definition unavailable"
						/>
					) : draft ? (
						<>
							<RecipeEditorHeader
								dirty={selectedEntry?.dirty ?? false}
								draft={draft}
								issues={validationIssues.length}
								selectedView={view}
								onChange={updateDraft}
								onViewChange={setView}
							/>
							{view === 'definition' ? (
								<div className="recipe-definition-body">
									<div className="recipe-lane-toolbar">
										<fieldset
											className="recipe-segmented-control"
											aria-label="Recipe lane"
										>
											<Button
												aria-pressed={selectedLane === 'steps'}
												size="sm"
												variant={
													selectedLane === 'steps' ? 'secondary' : 'ghost'
												}
												onPress={() => setSelectedLane('steps')}
											>
												<Play className="h-3 w-3" /> Run · {draft.steps.length}
											</Button>
											<Button
												aria-pressed={selectedLane === 'teardown'}
												size="sm"
												variant={
													selectedLane === 'teardown' ? 'secondary' : 'ghost'
												}
												onPress={() => setSelectedLane('teardown')}
											>
												<RotateCcw className="h-3 w-3" /> Cleanup ·{' '}
												{draft.teardown.length}
											</Button>
										</fieldset>
										<div className="recipe-add-step">
											<NativeSelect fullWidth={false} variant="secondary">
												<NativeSelect.Trigger
													aria-label="Step type"
													value={paletteKind}
													onChange={(event) =>
														setPaletteKind(
															event.currentTarget.value as RecipeStepKind
														)
													}
												>
													{RECIPE_STEP_PALETTE.map((item) => (
														<NativeSelect.Option
															key={item.kind}
															value={item.kind}
														>
															{item.label}
														</NativeSelect.Option>
													))}
													<NativeSelect.Indicator>
														<ChevronDown className="h-3 w-3" />
													</NativeSelect.Indicator>
												</NativeSelect.Trigger>
											</NativeSelect>
											<Button
												isDisabled={totalStepCount >= MAX_RECIPE_STEPS}
												size="sm"
												variant="secondary"
												onPress={addStep}
											>
												<Plus className="h-3 w-3" /> Add
											</Button>
										</div>
									</div>
									<p className="recipe-lane-note">
										{selectedLane === 'steps'
											? 'Run steps execute in order for each exact target.'
											: 'Cleanup executes after completion, failure, cancellation, or interruption.'}
										<span>
											{totalStepCount} / {MAX_RECIPE_STEPS} total
										</span>
									</p>
									<ExecutionRail
										issues={validationIssues}
										lane={selectedLane}
										selectedStepId={selectedStepId}
										steps={activeSteps}
										onSelect={setSelectedStepId}
									/>
									{selectedStep ? (
										<>
											<div className="recipe-step-actions">
												<Button
													aria-label="Move step up"
													isDisabled={selectedStepIndex <= 0}
													isIconOnly
													size="sm"
													variant="ghost"
													onPress={() => moveSelectedStep(-1)}
												>
													<ArrowUp className="h-3.5 w-3.5" />
												</Button>
												<Button
													aria-label="Move step down"
													isDisabled={
														selectedStepIndex >= activeSteps.length - 1
													}
													isIconOnly
													size="sm"
													variant="ghost"
													onPress={() => moveSelectedStep(1)}
												>
													<ArrowDown className="h-3.5 w-3.5" />
												</Button>
												<Button
													size="sm"
													variant="danger"
													onPress={removeSelectedStep}
												>
													<Trash2 className="h-3 w-3" /> Remove step
												</Button>
											</div>
											<RecipeStepEditor
												issues={validationIssues}
												path={`${selectedLane}.${selectedStepIndex}`}
												step={selectedStep}
												onChange={replaceSelectedStep}
											/>
										</>
									) : (
										<EmptyPanel
											compact
											description="Add a typed step to this lane. A recipe must contain at least one run step."
											icon={<Layers3 />}
											title="This lane is empty"
										/>
									)}
									{validationIssues.length > 0 ? (
										<RecipeValidationSummary issues={validationIssues} />
									) : null}
								</div>
							) : (
								<EvidenceView
									evidenceLoad={evidenceLoad}
									run={selectedRun}
									onExport={(evidenceId) =>
										void recipeRuntime.runFileOperation({
											kind: 'evidence.export',
											evidenceId,
										})
									}
								/>
							)}
						</>
					) : (
						<EmptyPanel
							action={
								<Button size="sm" variant="primary" onPress={createRecipe}>
									<Plus className="h-3.5 w-3.5" /> Create recipe
								</Button>
							}
							description="Save a sequence of simulator actions to run again."
							icon={<FileJson />}
							title="Select or create a recipe"
						/>
					)}
				</section>
				{draft ? (
					<aside className="sim-automation-inspector recipe-run-inspector panel-scroll">
						<RunInspector
							activeRun={activeRun}
							activeRunUnknownSlimmingStatuses={
								activeRunUnknownSlimmingStatuses
							}
							approval={approval}
							canRun={canRun}
							concurrency={concurrency}
							concurrencyValid={concurrencyValid}
							draft={draft}
							isDirty={selectedEntry?.dirty ?? false}
							runs={runsForRecipe}
							selectedRun={selectedRun}
							summary={selectedSummary}
							targetUdids={targetUdids}
							devices={simulatorRuntime.state.devices}
							onCancel={(runId) => void recipeRuntime.cancelRun(runId)}
							onApprove={(run, acknowledgement) =>
								void approvePendingRun(run, acknowledgement)
							}
							onConcurrencyChange={setConcurrency}
							onExportRecipe={() =>
								draft
									? void recipeRuntime.runFileOperation({
											kind: 'recipe.export',
											recipeId: draft.id,
										})
									: undefined
							}
							onRun={() => void startRun()}
							onSelectRun={(runId) => {
								setSelectedRunId(runId);
								setView('evidence');
							}}
							onToggleTarget={toggleTarget}
						/>
						<div className="recipe-inspector-footer-actions">
							<ConfirmAction
								confirmLabel={
									persistedById.has(selectedRecipeId ?? '')
										? 'Continue'
										: 'Discard draft'
								}
								description={
									persistedById.has(selectedRecipeId ?? '')
										? 'The desktop will open a second native warning bound to this exact recipe before deleting its local definition. Run evidence remains separate.'
										: 'Discard this unsaved in-memory draft. It has never been written to local recipe storage.'
								}
								isDisabled={!draft}
								title={
									persistedById.has(selectedRecipeId ?? '')
										? 'Delete saved recipe?'
										: 'Discard draft?'
								}
								triggerIcon={<Trash2 className="h-3 w-3" />}
								triggerLabel={
									persistedById.has(selectedRecipeId ?? '')
										? 'Delete recipe'
										: 'Discard draft'
								}
								triggerVariant="ghost"
								tone="danger"
								onConfirm={() => void removeSelectedRecipe()}
							/>
						</div>
					</aside>
				) : null}
			</div>
		</section>
	);
}

function RecipeRow({
	summary,
	dirty,
}: {
	summary: RecipeSummary;
	dirty: boolean;
}) {
	return (
		<>
			<div className="sim-list-leading">
				<FileJson className="h-3.5 w-3.5" />
			</div>
			<div className="sim-list-copy">
				<strong>{summary.name}</strong>
				<span>
					r{summary.revision} · {summary.stepCount + summary.teardownStepCount}{' '}
					steps
				</span>
			</div>
			<div className="recipe-row-state">
				{dirty ? (
					<span className="recipe-dirty-dot" title="Unsaved changes" />
				) : null}
				{summary.requiresMutationApproval ? (
					<ShieldAlert
						aria-label="Native approval required"
						className="h-3 w-3"
					/>
				) : null}
			</div>
		</>
	);
}

function RecipeEditorHeader({
	draft,
	dirty,
	issues,
	selectedView,
	onChange,
	onViewChange,
}: {
	draft: RecipeDefinition;
	dirty: boolean;
	issues: number;
	selectedView: EditorView;
	onChange: (recipe: RecipeDefinition) => void;
	onViewChange: (view: EditorView) => void;
}) {
	return (
		<header className="recipe-definition-header">
			<div className="recipe-definition-title">
				<Input
					aria-label="Recipe name"
					value={draft.name}
					onChange={(event) =>
						onChange({ ...draft, name: event.currentTarget.value })
					}
				/>
				<TextArea
					aria-label="Recipe description"
					placeholder="Describe the invariant this recipe proves."
					value={draft.description ?? ''}
					onChange={(event) =>
						onChange({
							...draft,
							description:
								event.currentTarget.value.length > 0
									? event.currentTarget.value
									: undefined,
						})
					}
				/>
			</div>
			<div className="recipe-header-meta">
				<code>{draft.id}</code>
				<span>revision {draft.revision}</span>
				{dirty ? <span className="is-dirty">Unsaved</span> : <span>Saved</span>}
				{issues > 0 ? (
					<span className="is-invalid">{issues} issues</span>
				) : null}
			</div>
			<fieldset
				className="recipe-segmented-control recipe-view-control"
				aria-label="Editor view"
			>
				<Button
					aria-pressed={selectedView === 'definition'}
					size="sm"
					variant={selectedView === 'definition' ? 'secondary' : 'ghost'}
					onPress={() => onViewChange('definition')}
				>
					<Layers3 className="h-3 w-3" /> Definition
				</Button>
				<Button
					aria-pressed={selectedView === 'evidence'}
					size="sm"
					variant={selectedView === 'evidence' ? 'secondary' : 'ghost'}
					onPress={() => onViewChange('evidence')}
				>
					<Activity className="h-3 w-3" /> Evidence
				</Button>
			</fieldset>
		</header>
	);
}

function ExecutionRail({
	steps,
	lane,
	selectedStepId,
	issues,
	onSelect,
}: {
	steps: RecipeStep[];
	lane: RecipeLane;
	selectedStepId: string | null;
	issues: ReturnType<typeof validateRecipeDefinition>;
	onSelect: (id: string) => void;
}) {
	if (steps.length === 0) return null;
	return (
		<ol
			className={`recipe-execution-rail is-${lane}`}
			aria-label={`${lane} steps`}
		>
			{steps.map((step, index) => {
				const stepIssues = issuesForPath(issues, `${lane}.${index}`);
				const Icon = iconForStep(step.kind);
				return (
					<li key={stepRenderKey(step)}>
						<button
							aria-current={step.id === selectedStepId ? 'step' : undefined}
							className={step.id === selectedStepId ? 'is-selected' : undefined}
							type="button"
							onClick={() => onSelect(step.id)}
						>
							<span className="recipe-rail-marker">
								<Icon className="h-3 w-3" />
							</span>
							<span className="recipe-rail-copy">
								<strong>{recipeStepTitle(step)}</strong>
								<small>
									{step.kind} · {step.id}
								</small>
							</span>
							<span className="recipe-rail-index">
								{String(index + 1).padStart(2, '0')}
							</span>
							{stepIssues.length > 0 ? (
								<AlertTriangle
									aria-label={`${stepIssues.length} validation issues`}
									className="h-3 w-3"
								/>
							) : null}
						</button>
					</li>
				);
			})}
		</ol>
	);
}

function RecipeValidationSummary({
	issues,
}: {
	issues: ReturnType<typeof validateRecipeDefinition>;
}) {
	return (
		<section className="recipe-validation-summary" aria-live="polite">
			<header>
				<AlertTriangle className="h-3.5 w-3.5" />
				<strong>
					Resolve {issues.length} schema{' '}
					{issues.length === 1 ? 'issue' : 'issues'}
				</strong>
			</header>
			<ul>
				{issues.slice(0, 8).map((issue) => (
					<li key={`${issue.path}:${issue.message}`}>
						<code>{issue.path}</code> {issue.message}
					</li>
				))}
			</ul>
			{issues.length > 8 ? <p>+ {issues.length - 8} more issues</p> : null}
		</section>
	);
}

function RunInspector({
	draft,
	summary,
	approval,
	devices,
	targetUdids,
	concurrency,
	concurrencyValid,
	canRun,
	isDirty,
	activeRun,
	activeRunUnknownSlimmingStatuses,
	selectedRun,
	runs,
	onToggleTarget,
	onConcurrencyChange,
	onRun,
	onApprove,
	onCancel,
	onSelectRun,
	onExportRecipe,
}: {
	draft: RecipeDefinition | null;
	summary: RecipeSummary | null;
	approval: RecipeApprovalAnalysis;
	devices: ReturnType<typeof useSimulatorRuntime>['state']['devices'];
	targetUdids: string[];
	concurrency: number;
	concurrencyValid: boolean;
	canRun: boolean;
	isDirty: boolean;
	activeRun: RecipeRun | undefined;
	activeRunUnknownSlimmingStatuses: SlimmingSimulatorStatus[];
	selectedRun: RecipeRun | null;
	runs: RecipeRun[];
	onToggleTarget: (udid: string) => void;
	onConcurrencyChange: (value: number) => void;
	onRun: () => void;
	onApprove: (run: RecipeRun, acknowledgement?: string) => void;
	onCancel: (runId: string) => void;
	onSelectRun: (runId: string) => void;
	onExportRecipe: () => void;
}) {
	return (
		<>
			<header>
				<h2>Run settings</h2>
				<InfoPopover label="Running recipes">
					Review the selected simulators and steps before running. The desktop
					app confirms sensitive actions and saves the results locally.
				</InfoPopover>
			</header>
			<section className="recipe-run-section">
				<div className="recipe-section-title">
					<span>Targets</span>
					<code>
						{targetUdids.length} / {MAX_RECIPE_TARGETS}
					</code>
				</div>
				<fieldset
					className="recipe-target-list"
					aria-label="Recipe target Simulators"
				>
					{devices.length === 0 ? (
						<p>No Simulator targets discovered.</p>
					) : (
						devices.map((device) => {
							const selected = targetUdids.includes(device.udid);
							return (
								<button
									aria-pressed={selected}
									className={selected ? 'is-selected' : undefined}
									key={device.udid}
									type="button"
									onClick={() => onToggleTarget(device.udid)}
								>
									<span className="recipe-target-check">
										{selected ? <Check className="h-3 w-3" /> : null}
									</span>
									<span>
										<strong>{device.name}</strong>
										<small>
											{device.state} · {device.udid.slice(0, 8)}
										</small>
									</span>
								</button>
							);
						})
					)}
				</fieldset>
				<div className="recipe-field recipe-concurrency-field">
					<span>Parallel targets</span>
					<Input
						aria-label="Recipe concurrency"
						max={MAX_RECIPE_CONCURRENCY}
						min={1}
						type="number"
						value={String(concurrency)}
						onChange={(event) =>
							onConcurrencyChange(Number(event.currentTarget.value))
						}
					/>
					<small>
						1–{MAX_RECIPE_CONCURRENCY}; cleanup remains target-scoped.
					</small>
				</div>
				{concurrencyValid ? null : (
					<p className="sim-field-error" role="alert">
						Use a concurrency from 1–{MAX_RECIPE_CONCURRENCY}.
					</p>
				)}
			</section>
			<ApprovalPreview
				approval={approval}
				requiresApproval={summary?.requiresMutationApproval ?? false}
			/>
			<section className="recipe-run-section recipe-run-actions">
				<Button isDisabled={!canRun} variant="primary" onPress={onRun}>
					<Play className="h-3.5 w-3.5" />
					{summary?.requiresMutationApproval || approval.findings.length > 0
						? 'Review & run'
						: 'Run recipe'}
				</Button>
				<Button
					isDisabled={!draft || !summary || isDirty}
					size="sm"
					variant="secondary"
					onPress={onExportRecipe}
				>
					<Download className="h-3.5 w-3.5" /> Export recipe
				</Button>
				{!summary ? (
					<p>Save this definition before running or exporting it.</p>
				) : null}
				{isDirty && summary ? (
					<p>Save the current revision before running it.</p>
				) : null}
			</section>
			<ActiveRunCard
				run={activeRun}
				unknownSlimmingStatuses={activeRunUnknownSlimmingStatuses}
				onApprove={onApprove}
				onCancel={onCancel}
			/>
			<RunHistory
				runs={runs}
				selectedRun={selectedRun}
				onSelect={onSelectRun}
			/>
		</>
	);
}

function ApprovalPreview({
	approval,
	requiresApproval,
}: {
	approval: RecipeApprovalAnalysis;
	requiresApproval: boolean;
}) {
	const hasFindings = approval.findings.length > 0 || requiresApproval;
	if (!hasFindings)
		return (
			<div className="recipe-approval-preview">
				<strong>No sensitive steps detected</strong>
				<InfoPopover label="Recipe review">
					The desktop checks the full recipe again before running. Steps that
					erase data, change permissions, or apply SimSlim need additional
					review.
				</InfoPopover>
			</div>
		);
	return (
		<section
			className={`recipe-approval-preview ${hasFindings ? 'is-required' : ''}`}
		>
			<header>
				<ShieldAlert className="h-3.5 w-3.5" />
				<div>
					<span>Approval preview</span>
					<strong>
						{hasFindings ? 'Native review required' : 'Read-only review'}
					</strong>
				</div>
			</header>
			<div className="recipe-approval-counts">
				<span>
					<b>{approval.destructiveCount}</b> destructive
				</span>
				<span>
					<b>{approval.privacyCount}</b> privacy-sensitive
				</span>
				<span>
					<b>{approval.slimmingCount}</b> slimming
				</span>
			</div>
			{approval.findings.length > 0 ? (
				<ul>
					{approval.findings.slice(0, 4).map((finding) => (
						<li key={`${finding.lane}:${finding.stepId}:${finding.category}`}>
							<strong>{finding.label}</strong>
							<span>
								{finding.lane} · {finding.detail}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p>
					No destructive, location/push/camera, or SimSlim mutation step
					detected.
				</p>
			)}
			<p>
				Run always asks main to evaluate the exact normalized request. Privacy
				fixtures never grant or reset OS permissions.
			</p>
		</section>
	);
}

function ActiveRunCard({
	run,
	unknownSlimmingStatuses,
	onApprove,
	onCancel,
}: {
	run: RecipeRun | undefined;
	unknownSlimmingStatuses: SlimmingSimulatorStatus[];
	onApprove: (run: RecipeRun, acknowledgement?: string) => void;
	onCancel: (runId: string) => void;
}) {
	if (!run)
		return (
			<section className="sim-recent-run recipe-active-run">
				<header>
					<span>
						<Clock3 className="h-3.5 w-3.5" /> Active run
					</span>
				</header>
				<p>No run is active for this recipe.</p>
			</section>
		);
	const completed = run.targets.reduce(
		(sum, target) => sum + target.completedSteps,
		0
	);
	const total = run.targets.reduce((sum, target) => sum + target.totalSteps, 0);
	const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
	const needsAttention = run.targets.some((target) =>
		['partial', 'failed', 'interrupted'].includes(target.cleanup.status)
	);
	return (
		<section
			className={`sim-recent-run recipe-active-run ${needsAttention ? 'needs-attention' : ''}`}
		>
			<header>
				<span>
					<Activity className="h-3.5 w-3.5" /> Active run
				</span>
				<code>{run.status}</code>
			</header>
			<strong>{run.message}</strong>
			<div
				className="recipe-progress-track"
				aria-label={`${percent}% complete`}
				role="progressbar"
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={percent}
			>
				<span style={{ width: `${percent}%` }} />
			</div>
			<p>
				{completed} / {total} target steps · concurrency {run.concurrency}
			</p>
			<div className="recipe-target-progress">
				{run.targets.map((target) => (
					<div key={target.udid}>
						<span className={`recipe-status-dot is-${target.status}`} />
						<strong>{target.udid.slice(0, 8)}</strong>
						<code>
							{target.completedSteps}/{target.totalSteps}
						</code>
						<small>{target.message}</small>
						{target.cleanup.status !== 'not-started' ? (
							<em>
								cleanup {target.cleanup.status} ·{' '}
								{target.cleanup.completedSteps}/{target.cleanup.totalSteps}
							</em>
						) : null}
					</div>
				))}
			</div>
			{needsAttention ? (
				<p className="recipe-needs-attention">
					<AlertTriangle className="h-3 w-3" /> Cleanup needs attention. Inspect
					target evidence before retrying.
				</p>
			) : null}
			{run.status === 'needs-approval' ? (
				<RecipePendingApprovalControls
					run={run}
					unknownSlimmingStatuses={unknownSlimmingStatuses}
					onApprove={onApprove}
				/>
			) : null}
			<Button size="sm" variant="danger" onPress={() => onCancel(run.id)}>
				<CircleStop className="h-3.5 w-3.5" /> Cancel run
			</Button>
		</section>
	);
}

function RecipePendingApprovalControls({
	run,
	unknownSlimmingStatuses,
	onApprove,
}: {
	run: RecipeRun;
	unknownSlimmingStatuses: SlimmingSimulatorStatus[];
	onApprove: (run: RecipeRun, acknowledgement?: string) => void;
}) {
	const binding = recipeSlimmingAcknowledgementBinding(unknownSlimmingStatuses);
	const [acknowledgementInput, setAcknowledgementInput] = useState({
		binding,
		value: '',
	});
	const typedAcknowledgement =
		acknowledgementInput.binding === binding ? acknowledgementInput.value : '';
	return (
		<div className="recipe-pending-approval-actions">
			<p>
				Approve reuses action <code>{run.actionId}</code>, recipe, target order,
				and concurrency exactly as submitted. Native confirmation remains
				mandatory.
			</p>
			{unknownSlimmingStatuses.length === 0 ? (
				<Button
					isDisabled={!run.pendingRequest}
					size="sm"
					variant="primary"
					onPress={() => onApprove(run)}
				>
					<ShieldAlert className="h-3.5 w-3.5" /> Approve exact request
				</Button>
			) : !run.pendingRequest ? (
				<Button isDisabled size="sm" variant="primary">
					<ShieldAlert className="h-3.5 w-3.5" /> Pending request unavailable
				</Button>
			) : (
				<AlertDialog
					onOpenChange={(open) =>
						open ? undefined : setAcknowledgementInput({ binding, value: '' })
					}
				>
					<AlertDialog.Trigger className="button button--sm button--primary">
						<ShieldAlert className="h-3.5 w-3.5" /> Review unknown tuple
					</AlertDialog.Trigger>
					<AlertDialog.Backdrop className="bg-black/40 backdrop-blur-sm dark:bg-black/70">
						<AlertDialog.Container
							className="border border-foreground/12 bg-overlay shadow-2xl"
							size="lg"
						>
							<AlertDialog.Dialog>
								<AlertDialog.Header>
									<AlertDialog.Icon status="warning">
										<ShieldAlert className="h-5 w-5" />
									</AlertDialog.Icon>
									<AlertDialog.Heading>
										Acknowledge current unknown compatibility
									</AlertDialog.Heading>
								</AlertDialog.Header>
								<AlertDialog.Body>
									<div className="sim-ack-dialog-body">
										<p>
											The signed helper will freshly verify and persist only
											these exact current tuple keys. The recipe and pending
											request never store this acknowledgement.
										</p>
										<div className="sim-tuple-list">
											{unknownSlimmingStatuses.map((status) => (
												<div
													key={`${status.simulatorUdid}-${status.compatibility?.key}`}
												>
													<code>{status.simulatorUdid}</code>
													<span>{status.compatibility?.key}</span>
												</div>
											))}
										</div>
										<div className="sim-ack-input">
											<span>
												Type{' '}
												<code>{SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT}</code>{' '}
												exactly
											</span>
											<Input
												aria-label="Recipe unknown compatibility acknowledgement"
												autoComplete="off"
												value={typedAcknowledgement}
												onChange={(event) =>
													setAcknowledgementInput({
														binding,
														value: event.currentTarget.value,
													})
												}
											/>
										</div>
									</div>
								</AlertDialog.Body>
								<AlertDialog.Footer>
									<Button size="sm" slot="close" variant="ghost">
										Cancel
									</Button>
									<Button
										isDisabled={
											typedAcknowledgement !==
											SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT
										}
										size="sm"
										slot="close"
										variant="primary"
										onPress={() => onApprove(run, typedAcknowledgement)}
									>
										Acknowledge &amp; approve exact request
									</Button>
								</AlertDialog.Footer>
							</AlertDialog.Dialog>
						</AlertDialog.Container>
					</AlertDialog.Backdrop>
				</AlertDialog>
			)}
		</div>
	);
}

function RunHistory({
	runs,
	selectedRun,
	onSelect,
}: {
	runs: RecipeRun[];
	selectedRun: RecipeRun | null;
	onSelect: (runId: string) => void;
}) {
	return (
		<section className="recipe-run-history">
			<header>
				<span>Recent evidence</span>
				<code>{runs.length}</code>
			</header>
			{runs.length === 0 ? (
				<p>No evidence manifests yet.</p>
			) : (
				runs.slice(0, 6).map((run) => (
					<button
						aria-current={run.id === selectedRun?.id ? 'true' : undefined}
						key={run.id}
						type="button"
						onClick={() => onSelect(run.id)}
					>
						<span className={`recipe-status-dot is-${run.status}`} />
						<span>
							<strong>{run.status}</strong>
							<small>{new Date(run.createdAt).toLocaleString()}</small>
						</span>
						<code>r{run.recipeRevision}</code>
					</button>
				))
			)}
		</section>
	);
}

function EvidenceView({
	run,
	evidenceLoad,
	onExport,
}: {
	run: RecipeRun | null;
	evidenceLoad: EvidenceLoadState;
	onExport: (evidenceId: string) => void;
}) {
	if (!run)
		return (
			<EmptyPanel
				compact
				description="Run a saved recipe to create a local manifest with bounded timeline events, capture IDs, and diagnostic correlation IDs."
				icon={<FileArchive />}
				title="No evidence selected"
			/>
		);
	if (evidenceLoad.kind === 'loading' || evidenceLoad.kind === 'idle')
		return (
			<div className="recipe-loading-state" role="status">
				<LoaderCircle className="h-4 w-4 animate-spin" /> Loading evidence
				manifest…
			</div>
		);
	if (evidenceLoad.kind === 'error' || evidenceLoad.kind === 'missing')
		return (
			<EmptyPanel
				compact
				description={
					evidenceLoad.kind === 'error'
						? evidenceLoad.error
						: 'The local evidence manifest is not available.'
				}
				icon={<TriangleAlert />}
				title="Evidence unavailable"
			/>
		);
	const evidence = evidenceLoad.evidence;
	return (
		<div className="recipe-evidence-view">
			<header className="recipe-evidence-header">
				<div>
					<p className="sim-eyebrow">Local evidence bundle</p>
					<h2>{evidence.recipe.name}</h2>
					<p>
						{evidence.status} · revision {evidence.recipe.revision} ·{' '}
						{evidence.targets.length} targets
					</p>
				</div>
				<Button
					size="sm"
					variant="secondary"
					onPress={() => onExport(evidence.id)}
				>
					<Download className="h-3.5 w-3.5" /> Export bundle
				</Button>
			</header>
			<div className="recipe-evidence-stats">
				<EvidenceMetric
					icon={Activity}
					label="Timeline"
					value={evidence.timeline.length}
				/>
				<EvidenceMetric
					icon={Camera}
					label="Captures"
					value={evidence.captureIds.length}
				/>
				<EvidenceMetric
					icon={Gauge}
					label="Correlations"
					value={evidence.diagnosticCorrelationIds.length}
				/>
				<EvidenceMetric
					icon={Layers3}
					label="Targets"
					value={evidence.targets.length}
				/>
			</div>
			<section className="recipe-evidence-timeline">
				<header>
					<span>Timeline</span>
					<code>{evidence.id}</code>
				</header>
				<DenseVirtualList
					ariaLabel="Evidence timeline"
					emptyDescription="The provider has created the manifest but has not recorded an event yet."
					emptyTitle="Waiting for first event"
					items={evidence.timeline}
					getId={(event) =>
						`${event.sequence}:${event.targetUdid ?? 'host'}:${event.stepId ?? 'run'}`
					}
					rowHeight={64}
					textValue={(event) =>
						`${event.phase} ${event.status} ${event.message}`
					}
					onSelect={() => {}}
					renderItem={(event) => (
						<>
							<span className={`recipe-timeline-sequence is-${event.status}`}>
								{String(event.sequence).padStart(3, '0')}
							</span>
							<div className="sim-list-copy">
								<strong>{event.message}</strong>
								<span>
									{event.phase} · {event.stepId ?? 'run'} ·{' '}
									{event.targetUdid?.slice(0, 8) ?? 'host'}
								</span>
							</div>
							<code className="recipe-timeline-time">
								{new Date(event.at).toLocaleTimeString()}
							</code>
						</>
					)}
				/>
			</section>
			<div className="recipe-evidence-artifacts">
				<EvidenceIdList
					icon={Camera}
					ids={evidence.captureIds}
					label="Capture IDs"
				/>
				<EvidenceIdList
					icon={Gauge}
					ids={evidence.diagnosticCorrelationIds}
					label="Diagnostic correlations"
				/>
			</div>
			<p className="recipe-evidence-boundary">
				<FileArchive className="h-3.5 w-3.5" /> This projection contains opaque
				IDs and bounded metadata only. Local paths never cross into the
				renderer.
			</p>
		</div>
	);
}

function EvidenceMetric({
	icon: Icon,
	label,
	value,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	value: number;
}) {
	return (
		<div>
			<Icon className="h-3.5 w-3.5" />
			<span>{label}</span>
			<strong>{value}</strong>
		</div>
	);
}

function EvidenceIdList({
	icon: Icon,
	label,
	ids,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	ids: string[];
}) {
	return (
		<section>
			<header>
				<span>
					<Icon className="h-3.5 w-3.5" /> {label}
				</span>
				{ids.length > 0 ? (
					<CopyButton label={`Copy ${label}`} value={ids.join('\n')} />
				) : null}
			</header>
			{ids.length === 0 ? (
				<p>None recorded.</p>
			) : (
				<ul>
					{ids.slice(0, 8).map((id) => (
						<li key={id}>
							<code>{id}</code>
						</li>
					))}
				</ul>
			)}
			{ids.length > 8 ? (
				<p>+ {ids.length - 8} more in exported manifest</p>
			) : null}
		</section>
	);
}

function iconForStep(
	kind: RecipeStep['kind']
): ComponentType<{ className?: string }> {
	switch (kind) {
		case 'simulator':
			return Play;
		case 'semantic':
			return Accessibility;
		case 'network':
			return Network;
		case 'camera':
			return Camera;
		case 'capture':
			return FileJson;
		case 'wait':
			return Clock3;
		case 'wait-for':
			return Activity;
		case 'assert':
			return Check;
		case 'restore-point':
			return RotateCcw;
		case 'slimming.mutation':
			return Sparkles;
	}
}

function emptyApprovalAnalysis(): RecipeApprovalAnalysis {
	return {
		findings: [],
		destructiveCount: 0,
		privacyCount: 0,
		slimmingCount: 0,
		mutationCount: 0,
	};
}

function arraysEqual(
	left: readonly string[],
	right: readonly string[]
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function stepRenderKey(step: RecipeStep): string {
	const existing = STEP_RENDER_KEYS.get(step);
	if (existing) return existing;
	const key = `editor-step-${crypto.randomUUID()}`;
	STEP_RENDER_KEYS.set(step, key);
	return key;
}

function errorText(error: unknown): string {
	return error instanceof Error
		? error.message.slice(0, 8 * 1024)
		: 'Recipe operation failed.';
}
