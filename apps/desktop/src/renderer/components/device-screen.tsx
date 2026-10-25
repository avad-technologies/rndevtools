import { MonitorOff, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLiveScreen } from '@/state/simulator-stream-runtime';
import type { SimulatorStreamQuality } from '../../shared/simulator-stream-protocol';

/**
 * Tracks whether an element is on screen. Hidden screens (scrolled away, in a
 * collapsed section) report false and stop their stream. The element needs a
 * box of its own: one with `display: contents` never intersects.
 */
function useVisible<T extends Element>(
	ref: React.RefObject<T | null>,
	{ rootMargin = '200px' }: { rootMargin?: string } = {}
): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return undefined;
		if (typeof IntersectionObserver === 'undefined') {
			setVisible(true);
			return undefined;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) setVisible(entry.isIntersecting);
			},
			{ rootMargin }
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, rootMargin]);
	return visible;
}

/**
 * A live Simulator screen. Streams only while it is on screen, renders the
 * latest JPEG frame, keeps the previous one while a new capture is in flight,
 * and shows a quiet placeholder for a Simulator that is shut down or has not
 * produced a frame yet.
 */
export function DeviceScreen({
	udid,
	live,
	quality,
	name,
	className = '',
	size = 'default',
	onActivate,
}: {
	udid: string;
	/** Whether the Simulator is booted; shut-down devices never subscribe. */
	live: boolean;
	quality: SimulatorStreamQuality;
	name: string;
	className?: string;
	/** `thumb` shrinks the placeholder for 44px lane thumbnails. */
	size?: 'default' | 'thumb';
	onActivate?: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const visible = useVisible(ref);
	const { screen, status } = useLiveScreen(udid, quality, live && visible);
	const stalled = status?.status === 'stalled';
	const content = screen ? (
		<img
			alt={`${name} screen`}
			className="device-screen-frame"
			draggable={false}
			height={screen.frame.height}
			src={screen.url}
			width={screen.frame.width}
		/>
	) : (
		<div className="device-screen-placeholder" aria-hidden="true">
			{live ? (
				<span className="device-screen-spinner" />
			) : (
				<Smartphone className="h-5 w-5" />
			)}
			<span>{live ? 'Waiting for first frame' : 'Shut down'}</span>
		</div>
	);
	const inner = onActivate ? (
		<button
			type="button"
			className="device-screen-activate"
			aria-label={`Open ${name}`}
			onClick={onActivate}
		>
			{content}
		</button>
	) : (
		content
	);
	return (
		<div
			ref={ref}
			className={`device-screen ${screen ? 'has-frame' : ''} ${stalled ? 'is-stalled' : ''} ${className}`}
			data-quality={quality}
			data-size={size}
		>
			{inner}
			{stalled ? (
				<span className="device-screen-badge" title={status?.error}>
					<MonitorOff className="h-3 w-3" /> stalled
				</span>
			) : screen && quality === 'focus' ? (
				<span className="device-screen-badge is-live">
					live · {screen.frame.captureMs} ms
				</span>
			) : null}
		</div>
	);
}
