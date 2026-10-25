import type { DevToolsPresentationMode } from '../types';
import { PanelSegmentedControl } from './panel-controls';

const MODES: ReadonlyArray<{
	mode: DevToolsPresentationMode;
	label: string;
}> = [
	{ mode: 'sheet', label: 'Sheet' },
	{ mode: 'window', label: 'Window' },
	{ mode: 'pill', label: 'Pill' },
];

type PresentationSwitcherProps = {
	mode: DevToolsPresentationMode;
	onModeChange: (mode: DevToolsPresentationMode) => void;
};

export function PresentationSwitcher({
	mode,
	onModeChange,
}: PresentationSwitcherProps) {
	return (
		<PanelSegmentedControl
			accessibilityLabel="Tool presentation"
			onChange={onModeChange}
			options={MODES.map((item) => ({ id: item.mode, label: item.label }))}
			selected={mode}
		/>
	);
}
