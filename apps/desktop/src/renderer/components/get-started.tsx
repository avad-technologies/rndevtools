import { Button } from '@heroui/react/button';
import { Popover } from '@heroui/react/popover';
import {
	Bot,
	Cable,
	Camera,
	Check,
	DatabaseZap,
	FolderGit2,
	Play,
	TerminalSquare,
	Waypoints,
} from 'lucide-react';
import { type ComponentType, useMemo, useState } from 'react';
import { openSetup, setChecklistHidden, useOnboarding } from '@/lib/onboarding';
import {
	type GetStartedTask,
	type GetStartedTaskId,
	getStartedProgress,
	getStartedTasks,
} from '@/simulator/get-started-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useRecipeRuntime } from '@/state/recipe-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSupabaseState } from '@/state/supabase-runtime';

const TASK_ICONS: Record<
	GetStartedTaskId,
	ComponentType<{ className?: string }>
> = {
	'check-mac': TerminalSquare,
	'add-project': FolderGit2,
	'boot-simulator': Play,
	'connect-app': Cable,
	'start-lane': Waypoints,
	'local-supabase': DatabaseZap,
	'record-capture': Camera,
	'automate-recipe': Bot,
};

/** Setup covers the first steps; the rest open the tab that does them. */
function runTask(id: GetStartedTaskId): void {
	switch (id) {
		case 'check-mac':
			openSetup('mac');
			return;
		case 'add-project':
			openSetup('project');
			return;
		case 'connect-app':
			openSetup('app');
			return;
		case 'boot-simulator':
			window.location.hash = 'simulator/fleet';
			return;
		case 'start-lane':
			window.location.hash = 'simulator/lanes';
			return;
		case 'local-supabase':
			window.location.hash = 'simulator/supabase';
			return;
		case 'record-capture':
			window.location.hash = 'simulator/captures';
			return;
		case 'automate-recipe':
			window.location.hash = 'simulator/automation';
			return;
	}
}

/** The checklist, read from the runtimes: nothing is ticked by hand. */
export function useGetStarted() {
	const simulator = useSimulatorRuntime();
	const lanes = useLaneRuntime();
	const desktop = useDesktopRuntime();
	const { state: supabase } = useSupabaseState();
	const recipe = useRecipeRuntime();
	const tasks = useMemo(
		() =>
			getStartedTasks({
				capability: simulator.state.capability,
				repositories: lanes.state.repositories,
				worktreeCount: lanes.state.worktrees.length,
				bootedCount: simulator.state.devices.filter(
					(device) => device.state === 'booted'
				).length,
				// The browser preview's in-memory device is not an app of yours.
				appSessionCount:
					desktop.state?.devices.filter(
						(device) => device.status !== 'simulated'
					).length ?? 0,
				laneCount: lanes.state.lanes.length,
				supabase: supabase.availability.platform.supported
					? { running: supabase.capacity.running }
					: undefined,
				captureCount: simulator.state.captures.length,
				recipeCount: recipe.state.recipes.length,
			}),
		[
			simulator.state.capability,
			simulator.state.devices,
			simulator.state.captures.length,
			lanes.state.repositories,
			lanes.state.worktrees.length,
			lanes.state.lanes.length,
			desktop.state?.devices,
			supabase.availability.platform.supported,
			supabase.capacity.running,
			recipe.state.recipes.length,
		]
	);
	return { tasks, progress: getStartedProgress(tasks) };
}

function TaskRow({
	task,
	onRun,
}: {
	task: GetStartedTask;
	onRun: (id: GetStartedTaskId) => void;
}) {
	const Icon = TASK_ICONS[task.id];
	return (
		<li>
			<button
				className={`get-started-task ${task.done ? 'is-done' : ''}`}
				type="button"
				onClick={() => onRun(task.id)}
			>
				<span aria-hidden="true" className="get-started-task-icon">
					<Icon className="h-3.5 w-3.5" />
				</span>
				<span className="get-started-task-copy">
					<span className="get-started-task-title">
						{task.title}
						{task.tag ? <span className="tool-tag">{task.tag}</span> : null}
					</span>
					<span className="get-started-task-detail">{task.detail}</span>
				</span>
				<span
					aria-label={task.done ? 'Done' : 'Not done'}
					className="get-started-task-mark"
					role="img"
				>
					{task.done ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
				</span>
			</button>
		</li>
	);
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
	return (
		<span aria-hidden="true" className="get-started-bar">
			<span
				className="get-started-bar-fill"
				style={{ width: `${total ? (done / total) * 100 : 0}%` }}
			/>
		</span>
	);
}

/**
 * The Get started checklist: Getting started first, then Beyond the basics.
 * Inline it greets an empty Simulators tab; in the sidebar it opens from the
 * progress card.
 */
export function GetStartedChecklist({
	inline = false,
	onRun,
}: {
	inline?: boolean;
	/** Called after a task starts, such as to close the popover it is in. */
	onRun?: () => void;
}) {
	const { tasks, progress } = useGetStarted();
	const run = (id: GetStartedTaskId) => {
		runTask(id);
		onRun?.();
	};
	const groups = [
		{ id: 'start', label: 'Getting started' },
		{ id: 'beyond', label: 'Beyond the basics' },
	] as const;
	return (
		<section
			aria-label="Get started"
			className={`get-started ${inline ? 'is-inline' : ''}`}
		>
			<header className="get-started-header">
				<div>
					<h2>{inline ? 'Welcome to RN Devtools' : 'Get started'}</h2>
					<p>A few steps get your first app running on its own Simulator.</p>
				</div>
				<div className="get-started-progress">
					<span>
						<strong className="get-started-count">
							{progress.done} of {progress.total}
						</strong>{' '}
						tasks done
					</span>
					<ProgressBar done={progress.done} total={progress.total} />
				</div>
			</header>
			{groups.map((group) => {
				const groupTasks = tasks.filter((task) => task.group === group.id);
				return (
					<div className="get-started-group" key={group.id}>
						<h3>
							{group.label}
							<span className="get-started-group-count">
								{groupTasks.filter((task) => task.done).length} of{' '}
								{groupTasks.length}
							</span>
						</h3>
						<ul>
							{groupTasks.map((task) => (
								<TaskRow key={task.id} task={task} onRun={run} />
							))}
						</ul>
					</div>
				);
			})}
			<footer className="get-started-footer">
				<Button
					size="sm"
					variant="secondary"
					onPress={() => {
						openSetup();
						onRun?.();
					}}
				>
					Run setup again
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onPress={() => {
						setChecklistHidden(true);
						onRun?.();
					}}
				>
					Hide Get started
				</Button>
			</footer>
		</section>
	);
}

/** The sidebar's progress card; it opens the checklist until every task is done. */
export function GetStartedCard() {
	const { checklistHidden } = useOnboarding();
	const { progress } = useGetStarted();
	const [open, setOpen] = useState(false);
	if (checklistHidden || progress.complete) return null;
	return (
		<Popover isOpen={open} onOpenChange={setOpen}>
			<Button
				aria-label={`Get started, ${progress.done} of ${progress.total} tasks done${progress.next ? `. Next: ${progress.next.title}` : ''}`}
				className="get-started-card"
				variant="ghost"
			>
				<span className="get-started-card-title">
					Get started
					<span className="get-started-card-count">
						{progress.done} of {progress.total}
					</span>
				</span>
				<ProgressBar done={progress.done} total={progress.total} />
				{progress.next ? (
					<span className="get-started-card-next">
						Next: {progress.next.title.charAt(0).toLowerCase()}
						{progress.next.title.slice(1)}
					</span>
				) : null}
			</Button>
			<Popover.Content className="get-started-popover" placement="right bottom">
				<Popover.Dialog aria-label="Get started">
					<GetStartedChecklist onRun={() => setOpen(false)} />
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
}
