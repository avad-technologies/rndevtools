import { Button } from '@heroui/react/button';
import { Modal } from '@heroui/react/modal';
import {
	Cable,
	Check,
	CircleAlert,
	CircleCheck,
	CircleDashed,
	CircleDot,
	FolderGit2,
	Layers3,
	Smartphone,
	TerminalSquare,
	X,
} from 'lucide-react';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { ProgressBar, useGetStarted } from '@/components/get-started';
import { TargetStatePill } from '@/components/simulator-ui';
import { CodePreview } from '@/components/ui';
import {
	adjacentSetupStep,
	closeSetup,
	openSetup,
	SETUP_STEPS,
	type SetupStep,
	setSetupStep,
	useOnboarding,
} from '@/lib/onboarding';
import { shortPath } from '@/simulator/fleet-model';
import { type MacCheck, macChecks } from '@/simulator/get-started-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import { useSupabaseState } from '@/state/supabase-runtime';
import appIcon from '../../../build/icon.svg';

const STEP_COPY: Record<
	SetupStep,
	{ title: string; body: string; primary: string }
> = {
	welcome: {
		title: 'Welcome to RN Devtools',
		body: 'Run each worktree of your React Native app on its own Simulator and Metro port, and inspect the app while it runs.',
		primary: 'Get started',
	},
	mac: {
		title: 'Check your Mac',
		body: 'RN Devtools works with the tools you already have. Nothing is installed without asking.',
		primary: 'Continue',
	},
	project: {
		title: 'Add your project',
		body: 'Pick the repository you work in. Each of its worktrees can run side by side as a lane.',
		primary: 'Continue',
	},
	app: {
		title: 'Connect your app',
		body: 'Add the client to your development build to see its network traffic, logs and state. Release builds leave it out.',
		primary: 'Continue',
	},
	extras: {
		title: 'Choose extras',
		body: 'All optional, and each can be turned on later.',
		primary: 'Continue',
	},
	ready: {
		title: "You're all set",
		body: 'Anything you skipped is waiting in Get started, in the sidebar.',
		primary: 'Open RN Devtools',
	},
};

const STEP_ICONS: Partial<
	Record<SetupStep, ComponentType<{ className?: string }>>
> = {
	mac: TerminalSquare,
	project: FolderGit2,
	app: Cable,
	extras: Layers3,
};

const CLIENT_SNIPPET = `import {
  shouldStartDesktopClient,
  startDesktopClient,
} from '@rndevtools/react-native';

if (shouldStartDesktopClient({ isDevelopmentBuild: __DEV__ })) {
  // host adapts your app; the package README shows one.
  startDesktopClient({ host });
}`;

function isInteractive(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest('button, a, input, select, textarea, [role="button"]') !==
			null
	);
}

/**
 * First-run setup, one idea per step. It opens by itself once, for someone
 * with no repository tracked yet; Get started can reopen it at any step.
 * Closing it at any point keeps what was done and leaves the rest in Get
 * started.
 */
export function SetupFlow() {
	const { setup, setupDone } = useOnboarding();
	const lanes = useLaneRuntime();
	const decided = useRef(false);
	useEffect(() => {
		if (decided.current || lanes.isLoading) return;
		decided.current = true;
		if (
			!setupDone &&
			lanes.state.repositories.length === 0 &&
			lanes.state.lanes.length === 0
		) {
			openSetup();
		}
	}, [
		lanes.isLoading,
		lanes.state.lanes.length,
		lanes.state.repositories.length,
		setupDone,
	]);
	return (
		<Modal.Backdrop
			className="setup-backdrop"
			isDismissable={false}
			isOpen={setup.open}
			onOpenChange={(open) => {
				if (!open) closeSetup();
			}}
		>
			<Modal.Container placement="center">
				<Modal.Dialog aria-labelledby="setup-title" className="setup-dialog">
					<SetupWindow step={setup.step} />
				</Modal.Dialog>
			</Modal.Container>
		</Modal.Backdrop>
	);
}

function SetupWindow({ step }: { step: SetupStep }) {
	const { bootstrap } = useDesktopRuntime();
	const copy = STEP_COPY[step];
	const index = SETUP_STEPS.indexOf(step);
	const Icon = STEP_ICONS[step];
	const primary = useRef<HTMLButtonElement>(null);
	const backKey = bootstrap?.platform === 'darwin' ? '⌘[' : 'Ctrl+[';
	useEffect(() => {
		primary.current?.focus();
	}, [step]);
	const next = () => {
		if (step === 'ready') {
			closeSetup();
			window.location.hash = 'simulator/fleet';
			return;
		}
		setSetupStep(adjacentSetupStep(step, 1));
	};
	const back = () => setSetupStep(adjacentSetupStep(step, -1));
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Enter and ⌘[ are shortcuts for the footer's buttons, which stay the accessible controls.
		<div
			className="setup-window"
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === '[') {
					event.preventDefault();
					if (index > 0) back();
				} else if (event.key === 'Enter' && !isInteractive(event.target)) {
					event.preventDefault();
					next();
				}
			}}
		>
			<Button
				aria-label="Close setup"
				className="setup-close"
				isIconOnly
				size="sm"
				variant="ghost"
				onPress={closeSetup}
			>
				<X className="h-4 w-4" />
			</Button>
			<div className="setup-body">
				<div className="setup-copy">
					{Icon ? (
						<span aria-hidden="true" className="setup-tile">
							<Icon className="h-6 w-6" />
						</span>
					) : (
						<img alt="" className="setup-app-icon" src={appIcon} />
					)}
					<div className="setup-text">
						<h1 id="setup-title">{copy.title}</h1>
						<p>{copy.body}</p>
					</div>
					<SetupAside step={step} />
				</div>
				<div className="setup-stage">
					<div className="setup-stage-card">
						<SetupStage step={step} />
					</div>
				</div>
			</div>
			<footer className="setup-footer">
				<img alt="" className="setup-footer-icon" src={appIcon} />
				<span className="setup-footer-label">Setup</span>
				<span aria-hidden="true" className="setup-dots">
					{SETUP_STEPS.map((dot, dotIndex) => (
						<span
							className={`setup-dot ${
								dotIndex === index
									? 'is-current'
									: dotIndex < index
										? 'is-done'
										: ''
							}`}
							key={dot}
						/>
					))}
				</span>
				<span className="sr-only">
					Step {index + 1} of {SETUP_STEPS.length}
				</span>
				<span className="setup-footer-spacer" />
				{step === 'welcome' ? (
					<Button size="sm" variant="ghost" onPress={closeSetup}>
						Skip setup
					</Button>
				) : (
					<Button size="sm" variant="ghost" onPress={back}>
						Back <kbd className="setup-key">{backKey}</kbd>
					</Button>
				)}
				{step === 'app' ? (
					<Button size="sm" variant="ghost" onPress={next}>
						Skip for now
					</Button>
				) : null}
				<Button ref={primary} size="sm" variant="primary" onPress={next}>
					{copy.primary} <kbd className="setup-key is-primary">↵</kbd>
				</Button>
			</footer>
		</div>
	);
}

/** What sits under the step's title on the left. */
function SetupAside({ step }: { step: SetupStep }) {
	const lanes = useLaneRuntime();
	const simulator = useSimulatorRuntime();
	if (step === 'welcome') {
		return (
			<p className="setup-note">
				Takes about three minutes. Anything you skip stays in Get started.
			</p>
		);
	}
	if (step === 'mac' && !simulator.isBridgeAvailable) {
		return (
			<p className="setup-note">
				Open the installed desktop app to check this Mac.
			</p>
		);
	}
	if (step === 'project') {
		return (
			<div className="setup-aside-actions">
				<Button
					isDisabled={
						!lanes.isBridgeAvailable || lanes.pendingOperation !== null
					}
					size="sm"
					variant="secondary"
					onPress={() =>
						void lanes.runOperation({ kind: 'lane.add-repository' })
					}
				>
					<FolderGit2 className="h-3.5 w-3.5" />
					{lanes.state.repositories.length > 0
						? 'Add another repository…'
						: 'Choose a repository…'}
				</Button>
				<p className="setup-note">
					RN Devtools reads each worktree's app.json and never starts a native
					build.
				</p>
			</div>
		);
	}
	return null;
}

function SetupStage({ step }: { step: SetupStep }) {
	switch (step) {
		case 'welcome':
			return <WelcomePreview />;
		case 'mac':
			return <MacStage />;
		case 'project':
			return <ProjectStage />;
		case 'app':
			return <ConnectStage />;
		case 'extras':
			return <ExtrasStage />;
		case 'ready':
			return <ReadyStage />;
	}
}

const PREVIEW_ROWS = [
	{
		name: 'iPhone 17 Pro',
		branch: 'feat-checkout',
		port: 8102,
		backend: 'db :21734',
	},
	{ name: 'iPhone 17', branch: 'fix-auth-redirect', port: 8106 },
	{ name: 'iPad Pro 11-inch', branch: 'main', port: 8104 },
] as const;

/** The product at work, as an illustration: example lanes, not your data. */
function WelcomePreview() {
	return (
		<div aria-hidden="true" className="setup-preview">
			<div className="setup-stage-head">
				<strong>Simulators</strong>
				<span>3 booted</span>
			</div>
			{PREVIEW_ROWS.map((row) => (
				<div className="setup-preview-row" key={row.name}>
					<span className="sim-list-leading">
						<Smartphone className="h-4 w-4" />
					</span>
					<span className="sim-list-copy">
						<span className="fleet-row-line">
							<strong className="fleet-row-name">{row.name}</strong>
							<span className="fleet-row-meta">iOS 27.0</span>
						</span>
						<span className="fleet-row-facts">
							<code className="fleet-row-branch">{row.branch}</code>
							<span className="fleet-row-metro is-ready">
								<span className="fleet-row-dot" />:{row.port} ready
							</span>
							{'backend' in row ? <span>{row.backend}</span> : null}
						</span>
					</span>
					<TargetStatePill state="booted" />
				</div>
			))}
			<div className="setup-stage-foot">
				<span className="network-live-dot" />
				ExampleApp connected · 5 requests captured
			</div>
		</div>
	);
}

const CHECK_ICONS: Record<
	MacCheck['state'],
	ComponentType<{ className?: string }>
> = {
	ready: CircleCheck,
	check: CircleAlert,
	checking: CircleDashed,
	optional: CircleDot,
};

const CHECK_LABELS: Record<MacCheck['state'], string> = {
	ready: 'Ready',
	check: 'Check',
	checking: 'Checking',
	optional: 'Optional',
};

function MacStage() {
	const { state, isBridgeAvailable, runOnboardingOperation } =
		useSimulatorRuntime();
	const checks = macChecks({
		capability: state.capability,
		runtimes: state.runtimes,
		native: state.native,
	});
	return (
		<ul className="setup-checks">
			{checks.map((check) => {
				const Icon = CHECK_ICONS[check.state];
				return (
					<li className={`setup-check is-${check.state}`} key={check.id}>
						<Icon aria-hidden="true" className="setup-check-icon" />
						<span className="setup-row-copy">
							<strong>{check.name}</strong>
							<span>{check.detail}</span>
						</span>
						<span className="setup-check-state">
							{CHECK_LABELS[check.state]}
						</span>
						{check.fix === 'select-xcode' ? (
							<Button
								isDisabled={!isBridgeAvailable}
								size="sm"
								variant="secondary"
								onPress={() =>
									void runOnboardingOperation({
										kind: 'toolchain.selectXcode',
									})
								}
							>
								Select Xcode…
							</Button>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function ProjectStage() {
	const { state } = useLaneRuntime();
	if (state.repositories.length === 0) {
		return (
			<div className="setup-empty">
				<FolderGit2 aria-hidden="true" className="h-5 w-5" />
				<strong>No repository yet</strong>
				<span>
					RN Devtools lists every worktree of the repository you choose.
				</span>
			</div>
		);
	}
	return (
		<div>
			{state.repositories.map((repository) => {
				const worktrees = state.worktrees.filter(
					(worktree) => worktree.repositoryRoot === repository
				);
				return (
					<section className="setup-repository" key={repository}>
						<div className="setup-stage-head">
							<FolderGit2
								aria-hidden="true"
								className="h-4 w-4 text-(--muted)"
							/>
							<strong className="font-mono" title={repository}>
								{shortPath(repository)}
							</strong>
							<span>
								{worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}
							</span>
						</div>
						<ul>
							{worktrees.map((worktree) => {
								const lane = state.lanes.find(
									(candidate) => candidate.worktreePath === worktree.path
								);
								return (
									<li className="setup-worktree" key={worktree.path}>
										<span className="setup-row-copy">
											<strong className="font-mono">{worktree.branch}</strong>
											<span title={worktree.path}>
												{shortPath(worktree.path)}
											</span>
										</span>
										<span className="setup-worktree-state">
											{lane
												? `lane :${lane.port}`
												: worktree.dirty
													? 'uncommitted changes'
													: 'no lane yet'}
										</span>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
			<p className="setup-stage-foot">
				Start a lane for any worktree from Lanes: its own Simulator and Metro
				port.
			</p>
		</div>
	);
}

function ConnectStage() {
	const { state } = useDesktopRuntime();
	const app = state?.devices.find((device) => device.status !== 'simulated');
	const broker = state?.broker;
	return (
		<div>
			<ol className="setup-steps">
				<li>
					<strong>1. Install the packages</strong>
					<CodePreview
						label="Terminal"
						value="pnpm add -D @rndevtools/core @rndevtools/react-native"
					/>
				</li>
				<li>
					<strong>2. Start the client in development builds</strong>
					<CodePreview label="App entry" value={CLIENT_SNIPPET} />
				</li>
				<li>
					<strong>3. Keep it out of release builds</strong>
					<span>
						Wrap metro.config.js with withDevtoolsPruning and run
						rndevtools-verify-bundle in CI.
					</span>
				</li>
			</ol>
			<p className="setup-stage-foot" role="status">
				{app ? (
					<>
						<span className="network-live-dot" />
						{app.info.name} is connected
					</>
				) : broker?.status === 'error' ? (
					<>
						<CircleAlert aria-hidden="true" className="h-4 w-4" />
						The device broker could not start
					</>
				) : (
					<>
						<CircleDashed aria-hidden="true" className="setup-waiting" />
						Waiting for your app on{' '}
						<code>
							{broker ? `${broker.host}:${broker.port}` : '127.0.0.1'}
						</code>
					</>
				)}
			</p>
		</div>
	);
}

function ExtrasStage() {
	const { state: supabase } = useSupabaseState();
	const slimming = useSlimmingRuntime();
	const { isBridgeAvailable, runOnboardingOperation } = useSimulatorRuntime();
	const [agents, setAgents] = useState<{ busy: boolean; lines: string[] }>({
		busy: false,
		lines: [],
	});
	const supabaseStatus = !supabase.availability.platform.supported
		? 'Not on this Mac'
		: supabase.feature.enabled
			? 'On'
			: 'Off';
	return (
		<div>
			<ul className="setup-extras">
				<li>
					<span className="setup-row-copy">
						<strong>
							Local Supabase per lane <span className="tool-tag">Alpha</span>
						</strong>
						<span>
							Each lane gets its own stack from the worktree's own Supabase CLI.
						</span>
					</span>
					<span className="setup-extra-state">{supabaseStatus}</span>
				</li>
				<li>
					<span className="setup-row-copy">
						<strong>
							SimSlim <span className="tool-tag">Experimental</span>
						</strong>
						<span>
							Trims background Simulator services; each change keeps a restore
							point.
						</span>
					</span>
					<span className="setup-extra-state">
						{slimming.state.setting.experimentalMutationsEnabled ? 'On' : 'Off'}
					</span>
				</li>
				<li>
					<span className="setup-row-copy">
						<strong>Coding agents</strong>
						<span>
							Registers the bundled rndevtools CLI with your coding agents, so
							they can drive Simulators and lanes.
						</span>
						{agents.lines.length > 0 ? (
							<ul className="setup-outcome">
								{agents.lines.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						) : null}
					</span>
					<Button
						isDisabled={!isBridgeAvailable || agents.busy}
						size="sm"
						variant="secondary"
						onPress={async () => {
							setAgents({ busy: true, lines: [] });
							const receipt = await runOnboardingOperation({
								kind: 'agentCli.setup',
							});
							setAgents({
								busy: false,
								lines: receipt.completed
									? (receipt.summary ?? ['Setup completed.'])
									: [receipt.error ?? 'Setup failed.'],
							});
						}}
					>
						{agents.busy ? 'Setting up…' : 'Set up'}
					</Button>
				</li>
			</ul>
			<p className="setup-stage-foot">
				Turn on local Supabase and SimSlim from their tabs whenever you want
				them.
			</p>
		</div>
	);
}

function ReadyStage() {
	const { tasks, progress } = useGetStarted();
	return (
		<div>
			<div className="setup-ready-head">
				<span className="setup-row-copy">
					<strong>Get started</strong>
					<span>Stays in the sidebar until you finish it.</span>
				</span>
				<span className="get-started-progress">
					<span>
						<strong className="get-started-count">
							{progress.done} of {progress.total}
						</strong>{' '}
						tasks done
					</span>
					<ProgressBar done={progress.done} total={progress.total} />
				</span>
			</div>
			<ul className="setup-ready-tasks">
				{tasks
					.filter((task) => task.group === 'start')
					.map((task) => (
						<li className={task.done ? 'is-done' : ''} key={task.id}>
							<span>{task.title}</span>
							<span
								aria-label={task.done ? 'Done' : 'Not done'}
								className="get-started-task-mark"
								role="img"
							>
								{task.done ? (
									<Check className="h-3 w-3" strokeWidth={3} />
								) : null}
							</span>
						</li>
					))}
			</ul>
		</div>
	);
}
