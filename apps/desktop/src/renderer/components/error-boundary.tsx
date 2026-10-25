import { Button } from '@heroui/react/button';
import { CircleAlert, RotateCcw, Smartphone } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { errorText } from '@/lib/runtime-action';
import { panelRecovery, SIMULATORS_PANEL } from '@/lib/shell-navigation';

type ErrorBoundaryState = {
	// Boxed, so a thrown `undefined` or `null` still shows the fallback.
	failure: { error: unknown } | null;
};

// The hash names the view that just failed, and a plain reload would render
// it again, so the app reloads into the Simulators panel.
function reloadIntoSimulators(): void {
	window.history.replaceState(null, '', `#${SIMULATORS_PANEL}`);
	window.location.reload();
}

/**
 * The root fallback. It is intentionally local: renderer details never cross
 * into the device broker or an external telemetry service automatically.
 */
export class DesktopErrorBoundary extends Component<
	{ children: ReactNode },
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { failure: null };

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		return { failure: { error } };
	}

	override render(): ReactNode {
		if (!this.state.failure) return this.props.children;
		return (
			<main className="fatal-error" role="alert">
				<div className="fatal-error-icon">
					<CircleAlert className="h-5 w-5" />
				</div>
				<p className="fatal-error-eyebrow">Renderer failure</p>
				<h1>RN Devtools could not render this view</h1>
				<p>{errorText(this.state.failure.error)}</p>
				<Button variant="secondary" onPress={reloadIntoSimulators}>
					<RotateCcw className="h-3.5 w-3.5" /> Reload desktop app
				</Button>
			</main>
		);
	}
}

/**
 * Keeps a tool panel's render or chunk-load failure inside the panel, so the
 * titlebar and sidebar stay usable. App mounts one per panel, keyed by its
 * route, so opening another panel always starts clean. Like the root, it
 * keeps renderer details local.
 */
export class PanelErrorBoundary extends Component<
	{
		children: ReactNode;
		/** The panel's route, such as `simulator/lanes`. */
		panel: string;
		/** The tool's name as the sidebar shows it. */
		label: string;
	},
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { failure: null };

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		return { failure: { error } };
	}

	#recover = (): void => {
		const recovery = panelRecovery(this.props.panel);
		if (recovery.kind === 'retry') this.setState({ failure: null });
		else window.location.hash = recovery.hash;
	};

	override render(): ReactNode {
		if (!this.state.failure) return this.props.children;
		const recovery = panelRecovery(this.props.panel);
		return (
			<div className="fatal-error" role="alert">
				<div className="fatal-error-icon">
					<CircleAlert className="h-5 w-5" />
				</div>
				<p className="fatal-error-eyebrow">Panel failure</p>
				<h1>{this.props.label} could not render</h1>
				<p>{errorText(this.state.failure.error)}</p>
				<Button variant="secondary" onPress={this.#recover}>
					{recovery.kind === 'retry' ? (
						<RotateCcw className="h-3.5 w-3.5" />
					) : (
						<Smartphone className="h-3.5 w-3.5" />
					)}{' '}
					{recovery.label}
				</Button>
			</div>
		);
	}
}
