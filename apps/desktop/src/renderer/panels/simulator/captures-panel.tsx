import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import {
	AlertTriangle,
	Camera,
	CircleCheck,
	CircleStop,
	Database,
	Download,
	Film,
	FolderOpen,
	LoaderCircle,
	Play,
	RefreshCw,
	Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	CaptureCompositionEditor,
	CaptureCompositionPreview,
} from '@/components/capture-composition-editor';
import {
	BridgeUnavailableNotice,
	DenseVirtualList,
	formatBytes,
	SimulatorTargetSelect,
} from '@/components/simulator-ui';
import {
	Badge,
	ConfirmAction,
	Disclosure,
	InfoPopover,
	KeyValue,
	PanelHeader,
	PanelNotice,
	SearchControl,
	Toolbar,
} from '@/components/ui';
import { errorText } from '@/lib/runtime-action';
import {
	type CaptureCompositionFields,
	captureCompositionAspectRatio,
	DEFAULT_CAPTURE_COMPOSITION_FIELDS,
	parseCaptureCompositionFields,
} from '@/simulator/capture-composition-model';
import {
	type CaptureRetentionFields,
	type CaptureRetentionForm,
	captureRetentionFieldsFromPolicy,
	captureRetentionPolicyFromFields,
	refillCaptureRetentionForm,
	runningRecordingJobForDevice,
} from '@/simulator/capture-model';
import {
	type SimulatorCaptureOperationInput,
	useSimulatorRuntime,
} from '@/state/simulator-runtime';
import type {
	SimulatorCapture,
	SimulatorCaptureRetentionState,
} from '../../../shared/simulator-protocol';

type CaptureAccessState =
	| { kind: 'idle' }
	| { kind: 'loading'; captureId: string }
	| { kind: 'available'; captureId: string; url: string }
	| { kind: 'unavailable'; captureId: string }
	| { kind: 'error'; captureId: string; error: string };

type RetentionState =
	| { kind: 'idle' }
	| { kind: 'loading' }
	| { kind: 'ready'; value: SimulatorCaptureRetentionState }
	| { kind: 'error'; error: string };

type OperationFeedback = {
	tone: 'info' | 'danger';
	title: string;
	message: string;
};

export function CapturesPanel() {
	const {
		cancelJob,
		getCaptureAccess,
		getCaptureRetention,
		isBridgeAvailable,
		refresh,
		runAction,
		runCaptureOperation,
		selectedDevice,
		state,
	} = useSimulatorRuntime();
	const [query, setQuery] = useState('');
	const [selectedCaptureId, setSelectedCaptureId] = useState(
		state.captures[0]?.id ?? ''
	);
	const accessRequestRef = useRef(0);
	const [access, setAccess] = useState<CaptureAccessState>({ kind: 'idle' });
	const [retention, setRetention] = useState<RetentionState>({ kind: 'idle' });
	const retentionRequestRef = useRef(0);
	const [retentionForm, setRetentionForm] = useState<CaptureRetentionForm>({
		fields: { maxAgeDays: '30', maxTotalGiB: '10' },
	});
	const retentionFields = retentionForm.fields;
	const editRetentionFields = useCallback(
		(fields: CaptureRetentionFields) =>
			setRetentionForm((form) => ({ ...form, fields })),
		[]
	);
	const [pendingOperation, setPendingOperation] = useState<
		SimulatorCaptureOperationInput['kind'] | null
	>(null);
	const [operationFeedback, setOperationFeedback] =
		useState<OperationFeedback | null>(null);
	const [compositionFields, setCompositionFields] =
		useState<CaptureCompositionFields>(DEFAULT_CAPTURE_COMPOSITION_FIELDS);
	const [secondaryAccess, setSecondaryAccess] = useState<CaptureAccessState>({
		kind: 'idle',
	});
	const secondaryAccessRequestRef = useRef(0);
	const [compositionJobId, setCompositionJobId] = useState<string | null>(null);
	const captures = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return [...state.captures]
			.filter(
				(capture) =>
					normalized.length === 0 ||
					`${capture.name} ${capture.kind} ${capture.status}`
						.toLowerCase()
						.includes(normalized)
			)
			.sort((left, right) => right.createdAt - left.createdAt);
	}, [query, state.captures]);
	const captureInventoryCount = state.captures.length;
	const captureInventoryBytes = useMemo(
		() => state.captures.reduce((total, capture) => total + capture.bytes, 0),
		[state.captures]
	);
	const selectedCapture =
		state.captures.find((capture) => capture.id === selectedCaptureId) ??
		state.captures[0] ??
		null;
	const recordingJob = runningRecordingJobForDevice(
		state.jobs,
		selectedDevice?.udid
	);
	const compositionJob = compositionJobId
		? state.jobs.find((job) => job.id === compositionJobId)
		: undefined;
	const isRenderingComposition = Boolean(
		compositionJob &&
			['queued', 'preflight', 'running', 'verifying'].includes(
				compositionJob.status
			)
	);
	const screenshotCaptures = useMemo(
		() => state.captures.filter((capture) => capture.kind === 'screenshot'),
		[state.captures]
	);
	const parsedComposition = useMemo(
		() => parseCaptureCompositionFields(compositionFields),
		[compositionFields]
	);
	const canCapture = Boolean(
		isBridgeAvailable && selectedDevice && selectedDevice.state === 'booted'
	);
	const canReadSelectedCapture = Boolean(
		selectedCapture && access.kind === 'available' && pendingOperation === null
	);
	const parsedRetentionPolicy = useMemo(
		() => captureRetentionPolicyFromFields(retentionFields),
		[retentionFields]
	);
	const retentionChanged = Boolean(
		parsedRetentionPolicy &&
			retention.kind === 'ready' &&
			(parsedRetentionPolicy.maxAgeDays !== retention.value.policy.maxAgeDays ||
				parsedRetentionPolicy.maxTotalBytes !==
					retention.value.policy.maxTotalBytes)
	);

	const loadRetention = useCallback(
		async (optimisticInventory?: {
			captureCount: number;
			totalBytes: number;
		}) => {
			if (!isBridgeAvailable) {
				setRetention({ kind: 'idle' });
				return;
			}
			const requestId = retentionRequestRef.current + 1;
			retentionRequestRef.current = requestId;
			setRetention((current) =>
				current.kind === 'ready' && optimisticInventory
					? {
							kind: 'ready',
							value: { ...current.value, ...optimisticInventory },
						}
					: { kind: 'loading' }
			);
			try {
				const value = await getCaptureRetention();
				if (retentionRequestRef.current !== requestId) return;
				setRetention({ kind: 'ready', value });
				// An inventory change reloads this; an unapplied edit survives it.
				setRetentionForm((form) =>
					refillCaptureRetentionForm(form, value.policy)
				);
			} catch (error) {
				if (retentionRequestRef.current !== requestId) return;
				setRetention({ kind: 'error', error: errorText(error) });
			}
		},
		[getCaptureRetention, isBridgeAvailable]
	);

	useEffect(() => {
		void loadRetention({
			captureCount: captureInventoryCount,
			totalBytes: captureInventoryBytes,
		});
	}, [captureInventoryBytes, captureInventoryCount, loadRetention]);

	const loadCaptureAccess = useCallback(
		async (captureId: string) => {
			if (!isBridgeAvailable) {
				setAccess({ kind: 'idle' });
				return;
			}
			const requestId = accessRequestRef.current + 1;
			accessRequestRef.current = requestId;
			setAccess({ kind: 'loading', captureId });
			try {
				const result = await getCaptureAccess(captureId);
				if (
					accessRequestRef.current !== requestId ||
					result.captureId !== captureId
				) {
					return;
				}
				if (result.available && result.url) {
					setAccess({ kind: 'available', captureId, url: result.url });
				} else {
					setAccess({ kind: 'unavailable', captureId });
				}
			} catch (error) {
				if (accessRequestRef.current === requestId) {
					setAccess({
						kind: 'error',
						captureId,
						error: errorText(error),
					});
				}
			}
		},
		[getCaptureAccess, isBridgeAvailable]
	);

	useEffect(() => {
		const captureId = selectedCapture?.id;
		if (!captureId) {
			accessRequestRef.current += 1;
			setAccess({ kind: 'idle' });
			return;
		}
		void loadCaptureAccess(captureId);
		return () => {
			accessRequestRef.current += 1;
		};
	}, [loadCaptureAccess, selectedCapture?.id]);

	useEffect(() => {
		const captureId = compositionFields.secondaryCaptureId;
		if (!compositionFields.enabled || !captureId) {
			secondaryAccessRequestRef.current += 1;
			setSecondaryAccess({ kind: 'idle' });
			return;
		}
		const requestId = secondaryAccessRequestRef.current + 1;
		secondaryAccessRequestRef.current = requestId;
		setSecondaryAccess({ kind: 'loading', captureId });
		void getCaptureAccess(captureId)
			.then((result) => {
				if (secondaryAccessRequestRef.current !== requestId) return;
				setSecondaryAccess(
					result.available && result.url
						? { kind: 'available', captureId, url: result.url }
						: { kind: 'unavailable', captureId }
				);
			})
			.catch((error: unknown) => {
				if (secondaryAccessRequestRef.current === requestId) {
					setSecondaryAccess({
						kind: 'error',
						captureId,
						error: errorText(error),
					});
				}
			});
		return () => {
			secondaryAccessRequestRef.current += 1;
		};
	}, [
		compositionFields.enabled,
		compositionFields.secondaryCaptureId,
		getCaptureAccess,
	]);

	useEffect(() => {
		if (!compositionJob || isRenderingComposition) return;
		if (compositionJob.status === 'complete' && compositionJob.captureId) {
			setSelectedCaptureId(compositionJob.captureId);
			setCompositionFields((current) => ({ ...current, enabled: false }));
			setOperationFeedback({
				tone: 'info',
				title: 'Composition rendered',
				message: 'A new nondestructive capture was added to the local gallery.',
			});
		} else if (compositionJob.status === 'failed') {
			setOperationFeedback({
				tone: 'danger',
				title: 'Composition failed',
				message: compositionJob.message,
			});
		}
		setCompositionJobId(null);
	}, [compositionJob, isRenderingComposition]);

	const renderComposition = useCallback(async () => {
		if (selectedCapture?.kind !== 'screenshot' || !parsedComposition) {
			return;
		}
		const receipt = await runAction(
			{
				kind: 'capture.compose',
				udid: selectedCapture.deviceUdid,
				primaryCaptureId: selectedCapture.id,
				...(parsedComposition.secondaryCaptureId
					? { secondaryCaptureId: parsedComposition.secondaryCaptureId }
					: {}),
				recipe: parsedComposition.recipe,
				...(parsedComposition.name ? { name: parsedComposition.name } : {}),
			},
			{
				pendingMessage: 'Rendering the native capture composition…',
				successMessage: 'Native composition queued.',
			}
		);
		if (receipt.accepted && receipt.jobId) setCompositionJobId(receipt.jobId);
	}, [parsedComposition, runAction, selectedCapture]);

	const executeOperation = useCallback(
		async (
			operation: SimulatorCaptureOperationInput,
			messages: { pending: string; success: string }
		) => {
			setPendingOperation(operation.kind);
			setOperationFeedback(null);
			try {
				const receipt = await runCaptureOperation(operation, {
					pendingMessage: messages.pending,
					successMessage: messages.success,
				});
				if (receipt.cancelled) {
					setOperationFeedback({
						tone: 'info',
						title: 'Operation cancelled',
						message: 'No capture data was changed.',
					});
					return;
				}
				if (!receipt.completed) {
					setOperationFeedback({
						tone: 'danger',
						title: 'Capture operation failed',
						message:
							receipt.error ??
							'The native capture provider rejected the request.',
					});
					return;
				}
				setOperationFeedback({
					tone: 'info',
					title: 'Capture operation complete',
					message: messages.success,
				});
				if (receipt.retention) {
					const { policy } = receipt.retention;
					// Newer than any reload still in flight; the form shows what applied.
					retentionRequestRef.current += 1;
					setRetention({ kind: 'ready', value: receipt.retention });
					setRetentionForm({
						fields: captureRetentionFieldsFromPolicy(policy),
						filledFrom: policy,
					});
				}
				if (operation.kind === 'capture.delete') {
					setSelectedCaptureId('');
					setAccess({ kind: 'idle' });
				}
				if (
					operation.kind === 'capture.delete' ||
					operation.kind === 'capture.retention.update'
				) {
					await refresh();
				}
			} finally {
				setPendingOperation(null);
			}
		},
		[refresh, runCaptureOperation]
	);

	return (
		<section className="panel-root">
			<PanelHeader
				actions={<SimulatorTargetSelect />}
				description="Capture screenshots and recordings from booted targets, preview them through a private desktop protocol, and explicitly export or reveal local originals. No filesystem path crosses into the renderer."
				meta={`${state.captures.length} capture${state.captures.length === 1 ? '' : 's'}`}
				title="Captures"
			/>
			<BridgeUnavailableNotice />
			{operationFeedback ? (
				<PanelNotice
					title={operationFeedback.title}
					tone={operationFeedback.tone}
				>
					{operationFeedback.message}
				</PanelNotice>
			) : null}
			<Toolbar>
				<Button
					isDisabled={!canCapture}
					size="sm"
					variant="primary"
					onPress={() =>
						selectedDevice
							? void runAction(
									{
										kind: 'capture.screenshot',
										udid: selectedDevice.udid,
										format: 'png',
										mask: 'alpha',
									},
									{
										pendingMessage: 'Capturing the current frame…',
										successMessage: 'Screenshot captured.',
									}
								)
							: undefined
					}
				>
					<Camera className="h-3.5 w-3.5" /> Screenshot
				</Button>
				{recordingJob ? (
					<>
						<Button
							aria-label={`Stop recording ${selectedDevice?.name ?? 'selected Simulator'}`}
							size="sm"
							variant="danger"
							onPress={() =>
								void cancelJob(recordingJob.id, {
									successMessage: 'Stop requested. Finalizing the recording…',
								})
							}
						>
							<CircleStop className="h-3.5 w-3.5" /> Stop recording
						</Button>
						<span className="sim-toolbar-meta" role="status">
							Recording {selectedDevice?.name ?? recordingJob.deviceUdid}
						</span>
					</>
				) : (
					<Button
						isDisabled={!canCapture}
						size="sm"
						variant="secondary"
						onPress={() =>
							selectedDevice
								? void runAction(
										{
											kind: 'capture.video',
											udid: selectedDevice.udid,
											codec: 'h264',
											mask: 'black',
										},
										{ successMessage: 'Recording started.' }
									)
								: undefined
						}
					>
						<Film className="h-3.5 w-3.5" /> Record
					</Button>
				)}
				<div className="sim-toolbar-separator" />
				<SearchControl
					ariaLabel="Search captures"
					placeholder="Search captures"
					value={query}
					onChange={setQuery}
				/>
				<span className="sim-toolbar-meta">{captures.length} matching</span>
			</Toolbar>
			<div className="sim-captures-layout">
				<section className="sim-list-pane">
					<DenseVirtualList
						ariaLabel="Capture gallery"
						emptyDescription="Boot a target and take a screenshot or start a recording."
						emptyTitle="No captures yet"
						items={captures}
						getId={(capture) => capture.id}
						rowHeight={62}
						selectedId={selectedCapture?.id}
						textValue={(capture) =>
							`${captureDisplayName(capture)} ${capture.status}`
						}
						onSelect={(capture) => setSelectedCaptureId(capture.id)}
						renderItem={(capture) => <CaptureRow capture={capture} />}
					/>
				</section>
				<section className="sim-capture-preview panel-scroll">
					<CapturePreview
						access={access}
						capture={selectedCapture}
						compositionFields={compositionFields}
						isBridgeAvailable={isBridgeAvailable}
						key={
							access.kind === 'available'
								? access.url
								: `${selectedCapture?.id ?? 'none'}-${access.kind}`
						}
						onRetry={() =>
							selectedCapture
								? void loadCaptureAccess(selectedCapture.id)
								: undefined
						}
						{...(secondaryAccess.kind === 'available'
							? { secondaryUrl: secondaryAccess.url }
							: {})}
					/>
				</section>
				<aside className="sim-capture-inspector panel-scroll">
					<header>
						<h2>Selected capture</h2>
					</header>
					<div className="sim-inspector-actions sim-capture-primary-actions">
						<Button
							isDisabled={!canReadSelectedCapture}
							size="sm"
							variant="primary"
							onPress={() =>
								selectedCapture
									? void executeOperation(
											{
												kind: 'capture.export',
												captureId: selectedCapture.id,
											},
											{
												pending: 'Waiting for an export destination…',
												success: 'The original capture was exported.',
											}
										)
									: undefined
							}
						>
							<Download className="h-3.5 w-3.5" />
							{pendingOperation === 'capture.export' ? 'Exporting…' : 'Export'}
						</Button>
						<Button
							isDisabled={!canReadSelectedCapture}
							size="sm"
							variant="secondary"
							onPress={() =>
								selectedCapture
									? void executeOperation(
											{
												kind: 'capture.reveal',
												captureId: selectedCapture.id,
											},
											{
												pending: 'Revealing the capture in Finder…',
												success: 'The capture was revealed in Finder.',
											}
										)
									: undefined
							}
						>
							<FolderOpen className="h-3.5 w-3.5" /> Show file
						</Button>
						<ConfirmAction
							confirmLabel="Delete capture"
							description={`Permanently delete ${selectedCapture?.name ?? 'this capture'} from the desktop capture store. This cannot be undone.`}
							isDisabled={!selectedCapture || pendingOperation !== null}
							title="Delete local capture?"
							triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
							triggerLabel="Delete"
							triggerVariant="ghost"
							tone="danger"
							onConfirm={() =>
								selectedCapture
									? void executeOperation(
											{
												kind: 'capture.delete',
												captureId: selectedCapture.id,
											},
											{
												pending: 'Deleting the local capture…',
												success: 'The local capture was deleted.',
											}
										)
									: undefined
							}
						/>
					</div>

					{selectedCapture?.kind === 'screenshot' ? (
						<CaptureCompositionEditor
							fields={compositionFields}
							isRendering={isRenderingComposition}
							nativeAvailable={state.native.imageComposition === true}
							primaryCapture={selectedCapture}
							screenshots={screenshotCaptures}
							onChange={setCompositionFields}
							onRender={() => void renderComposition()}
						/>
					) : null}

					<Disclosure title="Storage & cleanup">
						<CaptureRetentionControls
							fields={retentionFields}
							isPolicyValid={parsedRetentionPolicy !== null}
							isSaving={pendingOperation === 'capture.retention.update'}
							retention={retention}
							onChange={editRetentionFields}
							onRefresh={() => void loadRetention()}
							onSave={() =>
								parsedRetentionPolicy
									? void executeOperation(
											{
												kind: 'capture.retention.update',
												policy: parsedRetentionPolicy,
											},
											{
												pending: 'Applying capture retention policy…',
												success: 'Capture retention policy was updated.',
											}
										)
									: undefined
							}
							retentionChanged={retentionChanged}
						/>
					</Disclosure>
				</aside>
			</div>
		</section>
	);
}

function captureDisplayName(capture: SimulatorCapture): string {
	if (!/^(?:screenshot|recording|video)-\d+-/.test(capture.name))
		return capture.name;
	return `${capture.kind === 'video' ? 'Recording' : 'Screenshot'} · ${new Date(capture.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function CaptureRow({ capture }: { capture: SimulatorCapture }) {
	return (
		<>
			<div className="sim-capture-thumb">
				{capture.kind === 'video' ? (
					<Play className="h-3.5 w-3.5" />
				) : (
					<Camera className="h-3.5 w-3.5" />
				)}
			</div>
			<div className="sim-list-copy">
				<strong>{captureDisplayName(capture)}</strong>
				<span>
					{new Date(capture.createdAt).toLocaleString()} ·{' '}
					{formatBytes(capture.bytes)}
				</span>
			</div>
			<div className="sim-capture-row-tags">
				{capture.status === 'partial' ? (
					<Badge tone="warning">Recovered</Badge>
				) : null}
			</div>
		</>
	);
}

function CapturePreview({
	capture,
	access,
	compositionFields,
	isBridgeAvailable,
	onRetry,
	secondaryUrl,
}: {
	capture: SimulatorCapture | null;
	access: CaptureAccessState;
	compositionFields: CaptureCompositionFields;
	isBridgeAvailable: boolean;
	onRetry: () => void;
	secondaryUrl?: string;
}) {
	const [mediaState, setMediaState] = useState<'loading' | 'ready' | 'error'>(
		'loading'
	);
	const isDesignPreview = Boolean(
		compositionFields.enabled && capture?.kind === 'screenshot'
	);
	if (!capture) {
		return (
			<div className="sim-empty-preview">
				<Camera className="h-5 w-5" />
				<strong>Select a capture</strong>
				<span>Captured media stays local until you explicitly export it.</span>
			</div>
		);
	}

	return (
		<div className="sim-preview-stage">
			{capture.status === 'partial' ? (
				<div className="sim-capture-recovery" role="status">
					<AlertTriangle className="h-3.5 w-3.5" />
					<span>
						<strong>Recovered partial capture.</strong> Finalization stopped
						unexpectedly; preview and export may end early, but the recovered
						original is preserved.
					</span>
				</div>
			) : null}
			<div
				className={`sim-preview-device ${isDesignPreview ? 'is-design' : ''}`}
				style={
					isDesignPreview
						? { aspectRatio: captureCompositionAspectRatio(compositionFields) }
						: undefined
				}
			>
				{access.kind === 'available' ? (
					isDesignPreview ? (
						<CaptureCompositionPreview
							fields={compositionFields}
							primaryUrl={access.url}
							{...(secondaryUrl ? { secondaryUrl } : {})}
						/>
					) : (
						<>
							{mediaState === 'loading' ? (
								<div className="sim-preview-loading" role="status">
									<LoaderCircle className="h-5 w-5 animate-spin" />
									<span>Loading private capture preview…</span>
								</div>
							) : null}
							{mediaState === 'error' ? (
								<CapturePreviewFailure
									description="The private media response could not be decoded. The original can still be revealed or exported."
									onRetry={onRetry}
									title="Preview decoding failed"
								/>
							) : null}
							{capture.kind === 'video' ? (
								<video
									aria-label={`Video capture: ${capture.name}`}
									className={`sim-capture-media is-${mediaState}`}
									controls
									muted
									playsInline
									preload="metadata"
									src={access.url}
									onError={() => setMediaState('error')}
									onLoadedMetadata={() => setMediaState('ready')}
								/>
							) : (
								<img
									alt={`Simulator capture: ${capture.name}`}
									className={`sim-capture-media is-${mediaState}`}
									src={access.url}
									onError={() => setMediaState('error')}
									onLoad={() => setMediaState('ready')}
								/>
							)}
						</>
					)
				) : access.kind === 'loading' ? (
					<div className="sim-preview-placeholder" role="status">
						<LoaderCircle className="h-6 w-6 animate-spin" />
						<span>Requesting private capture access…</span>
					</div>
				) : access.kind === 'error' ? (
					<CapturePreviewFailure
						description={access.error}
						onRetry={onRetry}
						title="Preview access failed"
					/>
				) : access.kind === 'unavailable' ? (
					<CapturePreviewFailure
						description="The catalog entry remains, but its media file is unavailable. Delete the stale entry or refresh discovery after recovery."
						onRetry={onRetry}
						title="Capture media is missing"
					/>
				) : (
					<div className="sim-preview-placeholder">
						<Camera className="h-6 w-6" />
						<span>
							{isBridgeAvailable
								? 'Select a capture to request private preview access.'
								: 'Open Captures in the desktop app to preview local media.'}
						</span>
					</div>
				)}
			</div>
			<div className="sim-preview-meta">
				<div>
					<strong>{captureDisplayName(capture)}</strong>
					<InfoPopover label="Capture details">
						{capture.name}
						<br />
						{capture.mimeType}
						<br />
						Simulator {capture.deviceUdid}
					</InfoPopover>
				</div>
				<code>{formatBytes(capture.bytes)}</code>
			</div>
		</div>
	);
}

function CapturePreviewFailure({
	title,
	description,
	onRetry,
}: {
	title: string;
	description: string;
	onRetry: () => void;
}) {
	return (
		<div className="sim-preview-placeholder is-error" role="alert">
			<AlertTriangle className="h-6 w-6" />
			<strong>{title}</strong>
			<span>{description}</span>
			<Button size="sm" variant="ghost" onPress={onRetry}>
				<RefreshCw className="h-3.5 w-3.5" /> Retry preview
			</Button>
		</div>
	);
}

function CaptureRetentionControls({
	retention,
	fields,
	isPolicyValid,
	retentionChanged,
	isSaving,
	onChange,
	onRefresh,
	onSave,
}: {
	retention: RetentionState;
	fields: CaptureRetentionFields;
	isPolicyValid: boolean;
	retentionChanged: boolean;
	isSaving: boolean;
	onChange: (fields: CaptureRetentionFields) => void;
	onRefresh: () => void;
	onSave: () => void;
}) {
	return (
		<section className="sim-capture-inspector-section sim-retention-section">
			<header>
				<div>
					<p className="sim-eyebrow">Local storage</p>
					<h2>Retention</h2>
				</div>
				<Button
					aria-label="Refresh capture retention"
					isDisabled={retention.kind === 'loading' || isSaving}
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={onRefresh}
				>
					<RefreshCw
						className={`h-3.5 w-3.5 ${retention.kind === 'loading' ? 'animate-spin' : ''}`}
					/>
				</Button>
			</header>
			{retention.kind === 'ready' ? (
				<dl className="sim-retention-summary">
					<KeyValue
						label="Stored captures"
						value={retention.value.captureCount}
					/>
					<KeyValue
						label="Storage used"
						value={formatBytes(retention.value.totalBytes)}
					/>
					<KeyValue
						label="Last cleanup"
						value={
							retention.value.lastPrunedAt
								? new Date(retention.value.lastPrunedAt).toLocaleString()
								: 'Not run yet'
						}
					/>
				</dl>
			) : retention.kind === 'error' ? (
				<div className="sim-retention-status is-error" role="alert">
					<AlertTriangle className="h-3.5 w-3.5" />
					<span>{retention.error}</span>
				</div>
			) : (
				<div className="sim-retention-status" role="status">
					{retention.kind === 'loading' ? (
						<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Database className="h-3.5 w-3.5" />
					)}
					<span>
						{retention.kind === 'loading'
							? 'Loading retention policy…'
							: 'Desktop capture retention is unavailable.'}
					</span>
				</div>
			)}
			<div className="sim-retention-fields">
				<div>
					<span>Maximum age</span>
					<Input
						aria-label="Maximum capture age in days"
						inputMode="numeric"
						disabled={retention.kind !== 'ready' || isSaving}
						max={3_650}
						min={1}
						type="number"
						value={fields.maxAgeDays}
						onChange={(event) =>
							onChange({ ...fields, maxAgeDays: event.currentTarget.value })
						}
					/>
					<small>days · 1–3,650</small>
				</div>
				<div>
					<span>Storage ceiling</span>
					<Input
						aria-label="Maximum capture storage in GiB"
						inputMode="decimal"
						disabled={retention.kind !== 'ready' || isSaving}
						max={100}
						min={2}
						step={0.25}
						type="number"
						value={fields.maxTotalGiB}
						onChange={(event) =>
							onChange({ ...fields, maxTotalGiB: event.currentTarget.value })
						}
					/>
					<small>GiB · 2–100</small>
				</div>
			</div>
			<Button
				isDisabled={!isPolicyValid || !retentionChanged || isSaving}
				size="sm"
				variant="secondary"
				onPress={onSave}
			>
				{isSaving ? (
					<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
				) : (
					<CircleCheck className="h-3.5 w-3.5" />
				)}
				{isSaving ? 'Applying…' : 'Apply retention'}
			</Button>
			<p className="sim-inline-note">
				Lower limits can prune existing captures immediately. The desktop app
				asks for confirmation before applying the policy.
			</p>
			{isPolicyValid ? null : (
				<p className="sim-field-error" role="alert">
					Use 1–3,650 whole days and a 2–100 GiB storage ceiling.
				</p>
			)}
		</section>
	);
}
