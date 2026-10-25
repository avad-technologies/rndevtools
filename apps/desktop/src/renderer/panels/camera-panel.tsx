import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Input } from '@heroui/react/input';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Camera,
	ChevronDown,
	CircleOff,
	FileImage,
	FileVideo,
	QrCode,
	Trash2,
	TriangleAlert,
	Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	Badge,
	KeyValue,
	PanelHeader,
	PanelNotice,
	Toolbar,
} from '@/components/ui';
import {
	assertFixtureSize,
	IMAGE_MIME_TYPES,
	inspectImageFixture,
	inspectVideoFixture,
	readFixtureBase64,
	VIDEO_MIME_TYPES,
} from '@/lib/camera-fixture-file';
import { formatBytes, formatDuration } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';

type FixtureKind = 'still' | 'qr' | 'video';

export function CameraPanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const fixture = selectedDevice?.tools.cameraFixture ?? {
		active: false as const,
	};
	const [kind, setKind] = useState<FixtureKind>('still');
	const [label, setLabel] = useState('Desktop fixture');
	const [errorMessage, setErrorMessage] = useState(
		'Camera is unavailable in this test.'
	);
	const [file, setFile] = useState<File | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);
	const [isPreparing, setIsPreparing] = useState(false);
	const acceptedTypes = useMemo(
		() => (kind === 'video' ? VIDEO_MIME_TYPES : IMAGE_MIME_TYPES).join(','),
		[kind]
	);
	const setFixtureReason = actionUnavailableReason('camera', 'setFixture');
	const clearFixtureReason = fixture.active
		? actionUnavailableReason('camera', 'clearFixture')
		: 'No fixture is currently active.';

	const setFixture = async () => {
		if (!file) return;
		setLocalError(null);
		setIsPreparing(true);
		try {
			assertFixtureSize(file);
			const media =
				kind === 'video'
					? await inspectVideoFixture(file)
					: await inspectImageFixture(file);
			const dataBase64 = await readFixtureBase64(file, 'action');
			await runAction(
				'camera',
				'setFixture',
				{
					kind,
					label: label.trim() || undefined,
					mimeType: file.type,
					dataBase64,
					width: media.width,
					height: media.height,
					...('durationMs' in media ? { durationMs: media.durationMs } : {}),
				},
				`${kind === 'qr' ? 'QR' : kind === 'video' ? 'Video' : 'Still-image'} camera fixture applied.`
			);
		} catch (error) {
			setLocalError(
				error instanceof Error ? error.message : 'Could not prepare fixture.'
			);
		} finally {
			setIsPreparing(false);
		}
	};

	return (
		<section className="panel-root">
			<PanelHeader
				actions={
					<Button
						isDisabled={
							!fixture.active || !canRunAction('camera', 'clearFixture')
						}
						size="sm"
						variant="secondary"
						onPress={() =>
							void runAction(
								'camera',
								'clearFixture',
								{},
								'Camera fixture cleared.'
							)
						}
					>
						<Trash2 className="h-3.5 w-3.5" /> Clear fixture
					</Button>
				}
				description="Send an explicit still, QR, video, unavailable, or error fixture to the app's instrumented development camera provider."
				meta={
					<Badge tone={fixture.active ? 'success' : 'default'}>
						{fixture.active ? 'Fixture active' : 'Live provider'}
					</Badge>
				}
				title="Camera Fixtures"
			/>
			<PanelNotice title="App-scoped camera simulation." tone="info">
				This controls only the app's instrumented development camera provider.
				It does not replace the macOS camera, Simulator system camera, or camera
				input in third-party libraries.
			</PanelNotice>
			{setFixtureReason ? (
				<PanelNotice title="Fixture actions are unavailable." tone="warning">
					{setFixtureReason} Fixtures can be prepared and validated here, but
					cannot be sent until the connected device advertises the camera
					fixture capability.
				</PanelNotice>
			) : null}
			{localError ? (
				<PanelNotice title="Fixture could not be prepared." tone="danger">
					{localError}
				</PanelNotice>
			) : null}
			<Toolbar>
				<div className="sim-toolbar-field">
					<span>Fixture kind</span>
					<NativeSelect className="sim-filter-select" fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="Camera fixture kind"
							value={kind}
							onChange={(event) => {
								setKind(event.currentTarget.value as FixtureKind);
								setFile(null);
								setLocalError(null);
							}}
						>
							<NativeSelect.Option value="still">
								Still image
							</NativeSelect.Option>
							<NativeSelect.Option value="qr">QR image</NativeSelect.Option>
							<NativeSelect.Option value="video">Video</NativeSelect.Option>
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<span className="sim-toolbar-meta">
					384 KiB raw / 512 KiB encoded · renderer never receives a file path
				</span>
			</Toolbar>
			<div className="camera-fixture-layout panel-scroll">
				<section className="camera-fixture-main">
					<Card className="camera-drop-card" variant="secondary">
						<Card.Content>
							<span className="camera-drop-icon">
								{kind === 'video' ? (
									<FileVideo />
								) : kind === 'qr' ? (
									<QrCode />
								) : (
									<FileImage />
								)}
							</span>
							<h2>
								{file?.name ??
									`Choose a ${kind === 'video' ? 'video' : 'still image'}`}
							</h2>
							<p>
								{file
									? `${file.type || 'unknown media'} · ${formatBytes(file.size)}`
									: 'The file is validated and converted in the sandboxed renderer before a bounded payload is sent.'}
							</p>
							<label className="camera-file-label">
								<Upload className="h-3.5 w-3.5" /> Choose file
								<input
									accept={acceptedTypes}
									type="file"
									onChange={(event) => {
										setFile(event.currentTarget.files?.[0] ?? null);
										setLocalError(null);
									}}
								/>
							</label>
						</Card.Content>
					</Card>
					<div className="camera-fixture-fields">
						<Input
							aria-label="Camera fixture label"
							placeholder="Fixture label"
							value={label}
							onChange={(event) => setLabel(event.currentTarget.value)}
						/>
						<Button
							isDisabled={
								!file || isPreparing || !canRunAction('camera', 'setFixture')
							}
							isPending={isPreparing}
							variant="primary"
							onPress={() => void setFixture()}
						>
							<Camera className="h-3.5 w-3.5" /> Apply fixture
						</Button>
					</div>
					<section className="camera-preset-grid">
						<Card variant="secondary">
							<Card.Content>
								<CircleOff className="h-4 w-4" />
								<div>
									<strong>Unavailable</strong>
									<span>Exercise permission and no-device UI.</span>
								</div>
								<Button
									isDisabled={!canRunAction('camera', 'setFixture')}
									size="sm"
									variant="secondary"
									onPress={() =>
										void runAction(
											'camera',
											'setFixture',
											{ kind: 'unavailable', label: label.trim() || undefined },
											'Unavailable camera fixture applied.'
										)
									}
								>
									Set
								</Button>
							</Card.Content>
						</Card>
						<Card variant="secondary">
							<Card.Content>
								<TriangleAlert className="h-4 w-4" />
								<div>
									<strong>Provider error</strong>
									<span>Return an explicit development error.</span>
								</div>
								<Input
									aria-label="Simulated camera error"
									value={errorMessage}
									onChange={(event) =>
										setErrorMessage(event.currentTarget.value)
									}
								/>
								<Button
									isDisabled={
										!canRunAction('camera', 'setFixture') ||
										errorMessage.trim().length === 0
									}
									size="sm"
									variant="secondary"
									onPress={() =>
										void runAction(
											'camera',
											'setFixture',
											{
												kind: 'error',
												label: label.trim() || undefined,
												errorMessage: errorMessage.trim(),
											},
											'Camera error fixture applied.'
										)
									}
								>
									Set
								</Button>
							</Card.Content>
						</Card>
					</section>
				</section>
				<aside className="camera-fixture-aside">
					<header>
						<p className="sim-eyebrow">Current projection</p>
						<h2>
							{fixture.active
								? (fixture.label ?? fixture.kind ?? 'Fixture')
								: 'No fixture'}
						</h2>
					</header>
					<dl>
						<KeyValue
							label="Status"
							value={
								<Badge tone={fixture.active ? 'success' : 'default'}>
									{fixture.active ? 'Active' : 'Inactive'}
								</Badge>
							}
						/>
						<KeyValue label="Kind" value={fixture.kind ?? '—'} />
						<KeyValue label="Media type" value={fixture.mimeType ?? '—'} mono />
						<KeyValue
							label="Dimensions"
							value={
								fixture.width && fixture.height
									? `${fixture.width} × ${fixture.height}`
									: '—'
							}
						/>
						<KeyValue
							label="Payload"
							value={
								fixture.bytes === undefined ? '—' : formatBytes(fixture.bytes)
							}
						/>
						<KeyValue
							label="Duration"
							value={
								fixture.durationMs === undefined
									? '—'
									: formatDuration(fixture.durationMs)
							}
						/>
					</dl>
					{clearFixtureReason && fixture.active ? (
						<p className="mb-0 mt-2 text-xs leading-4 text-(--text-3)">
							{clearFixtureReason}
						</p>
					) : null}
					<p>
						The desktop receives metadata only after activation; raw fixture
						bytes remain on the connected development client.
					</p>
				</aside>
			</div>
		</section>
	);
}
