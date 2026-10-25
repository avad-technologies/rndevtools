import { Button } from '@heroui/react/button';
import { Home, Keyboard, Lock, Mic, Volume1, Volume2 } from 'lucide-react';
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import { DeviceScreen } from '@/components/device-screen';
import type {
	SimulatorHardwareButton,
	SimulatorInput,
	SimulatorInputBridge,
} from '../../shared/simulator-input-protocol';
import { simulatorKeyFromEvent } from '../../shared/simulator-input-protocol';

/**
 * The live screen you can drive. Click taps, drag swipes, Enter takes the
 * keyboard (every key goes to the device until Esc), and the strip below
 * presses the hardware buttons. Everything is sent through the native host's
 * HID path, so it works on Springboard and system alerts, not just the app.
 */

const SWIPE_THRESHOLD_PX = 8;
/** A press held this long on one spot is a long press. */
const LONG_PRESS_MS = 500;

function inputBridge(): SimulatorInputBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<SimulatorInputBridge>)
		| undefined;
	return candidate && typeof candidate.sendSimulatorInput === 'function'
		? (candidate as SimulatorInputBridge)
		: null;
}

/**
 * Maps a pointer position to a 0…1 screen ratio using the rendered frame's
 * box, not the container's, so letterboxing around a tall screen does not
 * skew the tap. Returns undefined when the pointer is outside the frame.
 */
export function pointerToRatio(
	frame: { left: number; top: number; width: number; height: number },
	clientX: number,
	clientY: number
): { x: number; y: number } | undefined {
	if (frame.width <= 0 || frame.height <= 0) return undefined;
	const x = (clientX - frame.left) / frame.width;
	const y = (clientY - frame.top) / frame.height;
	if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
	return {
		x: Math.round(x * 10_000) / 10_000,
		y: Math.round(y * 10_000) / 10_000,
	};
}

type Gesture = {
	start: { x: number; y: number };
	startClient: { x: number; y: number };
	startedAt: number;
	last: { x: number; y: number };
	moved: boolean;
};

export function ControllableScreen({
	udid,
	name,
	live,
}: {
	udid: string;
	name: string;
	live: boolean;
}) {
	const bridge = inputBridge();
	const surface = useRef<HTMLDivElement>(null);
	const gesture = useRef<Gesture | null>(null);
	const [controlling, setControlling] = useState(false);
	const [busy, setBusy] = useState(false);
	const [lastError, setLastError] = useState<string | null>(null);

	const send = useCallback(
		async (input: SimulatorInput) => {
			if (!bridge) return;
			setBusy(true);
			try {
				await bridge.sendSimulatorInput(input);
				setLastError(null);
			} catch (error) {
				setLastError(error instanceof Error ? error.message : String(error));
			} finally {
				setBusy(false);
			}
		},
		[bridge]
	);

	const frameBox = () => {
		const image = surface.current?.querySelector('img');
		if (!image) return undefined;
		const rect = image.getBoundingClientRect();
		return {
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!live || !bridge || event.button !== 0) return;
		const box = frameBox();
		const ratio = box
			? pointerToRatio(box, event.clientX, event.clientY)
			: undefined;
		if (!ratio) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		gesture.current = {
			start: ratio,
			startClient: { x: event.clientX, y: event.clientY },
			startedAt: Date.now(),
			last: ratio,
			moved: false,
		};
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		if (!current) return;
		const box = frameBox();
		const ratio = box
			? pointerToRatio(box, event.clientX, event.clientY)
			: undefined;
		if (!ratio) return;
		if (
			Math.hypot(
				event.clientX - current.startClient.x,
				event.clientY - current.startClient.y
			) > SWIPE_THRESHOLD_PX
		) {
			current.moved = true;
		}
		current.last = ratio;
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current) return;
		event.currentTarget.releasePointerCapture(event.pointerId);
		const held = Date.now() - current.startedAt;
		if (current.moved) {
			void send({
				kind: 'swipe',
				udid,
				fromX: current.start.x,
				fromY: current.start.y,
				toX: current.last.x,
				toY: current.last.y,
				durationMilliseconds: Math.min(10_000, Math.max(80, held)),
				steps: 16,
			});
		} else {
			void send({
				kind: 'tap',
				udid,
				x: current.start.x,
				y: current.start.y,
				holdMilliseconds: held >= LONG_PRESS_MS ? Math.min(10_000, held) : 40,
			});
		}
	};

	// Keyboard capture: Enter to take, Esc to release; while captured every key
	// the Simulator can represent is forwarded and swallowed here.
	useEffect(() => {
		if (!controlling) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.code === 'Escape') {
				event.preventDefault();
				setControlling(false);
				return;
			}
			const key = simulatorKeyFromEvent(event);
			if (!key) return;
			event.preventDefault();
			event.stopPropagation();
			void send({
				kind: 'key',
				udid,
				usage: key.usage,
				modifiers: key.modifiers,
			});
		};
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [controlling, send, udid]);

	useEffect(() => {
		if (!live) setControlling(false);
	}, [live]);

	const press = (button: SimulatorHardwareButton) =>
		void send({ kind: 'button', udid, button });

	return (
		<div
			className={`controllable-screen ${controlling ? 'is-controlling' : ''}`}
		>
			<div
				ref={surface}
				className="controllable-screen-surface"
				onPointerCancel={() => {
					gesture.current = null;
				}}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
			>
				<DeviceScreen
					className="sim-focus-screen-frame"
					live={live}
					name={name}
					quality="focus"
					udid={udid}
				/>
				{controlling ? (
					<span className="controllable-screen-badge">
						<Keyboard className="h-3 w-3" /> keyboard captured · Esc releases
					</span>
				) : null}
			</div>
			<div className="controllable-screen-controls">
				<Button
					aria-pressed={controlling}
					isDisabled={!live || !bridge}
					size="sm"
					variant={controlling ? 'primary' : 'secondary'}
					onPress={() => setControlling((value) => !value)}
				>
					<Keyboard className="h-3.5 w-3.5" />
					{controlling ? 'Release keyboard' : 'Type on device'}
				</Button>
				<span className="controllable-screen-buttons">
					{(
						[
							['home', Home, 'Home'],
							['lock', Lock, 'Lock'],
							['volume-up', Volume2, 'Volume up'],
							['volume-down', Volume1, 'Volume down'],
							['siri', Mic, 'Siri'],
						] as const
					).map(([button, Icon, label]) => (
						<Button
							key={button}
							aria-label={label}
							className="sim-icon-button"
							isDisabled={!live || !bridge || busy}
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={() => press(button)}
						>
							<Icon className="h-3.5 w-3.5" />
						</Button>
					))}
				</span>
			</div>
			<p className="sim-inline-note">
				{!bridge
					? 'Native input needs the desktop bridge.'
					: !live
						? 'Boot the Simulator to drive it.'
						: lastError
							? lastError
							: 'Click to tap, drag to swipe, hold for a long press. Input goes through SimulatorKit, so it works on any screen, connected app or not.'}
			</p>
		</div>
	);
}
