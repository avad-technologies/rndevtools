import { Button } from '@heroui/react/button';
import { Check, CircleX, X } from 'lucide-react';
import type { ReactNode } from 'react';

type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export const statusToneClassName: Record<Tone, string> = {
	default: 'border-foreground/10 bg-foreground/[0.045] text-(--muted)',
	success: 'border-brand/25 bg-brand/10 text-brand-text',
	warning: 'border-warning/25 bg-warning/10 text-warning-text',
	danger: 'border-danger/25 bg-danger/10 text-danger-text',
	info: 'border-info/25 bg-info/10 text-info-text',
};

export function StatusPill({
	children,
	tone = 'default',
	dot = false,
	className = '',
}: {
	children: ReactNode;
	tone?: Tone;
	dot?: boolean;
	className?: string;
}) {
	return (
		<span
			className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-xs font-medium uppercase tracking-[0.04em] ${statusToneClassName[tone]} ${className}`}
		>
			{dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
			{children}
		</span>
	);
}

export function ActionNotice({
	kind,
	message,
	onDismiss,
}: {
	kind: 'pending' | 'success' | 'error';
	message: string;
	onDismiss: () => void;
}) {
	const hasDetails = message.length > 240 || message.includes('\n');
	const headline = hasDetails
		? kind === 'error'
			? 'The action could not finish. Review the details below.'
			: message.split('\n')[0]?.slice(0, 200)
		: message;
	const icon =
		kind === 'success' ? (
			<Check className="h-3.5 w-3.5" />
		) : kind === 'error' ? (
			<CircleX className="h-3.5 w-3.5" />
		) : (
			<span className="h-2 w-2 animate-pulse rounded-full bg-info" />
		);
	return (
		<div
			aria-live={kind === 'error' ? 'assertive' : 'polite'}
			className={`fixed bottom-5 right-5 z-50 flex min-w-[280px] max-w-[min(560px,calc(100vw-40px))] items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-2xl ${statusToneClassName[kind === 'success' ? 'success' : kind === 'error' ? 'danger' : 'info']}`}
			role={kind === 'error' ? 'alert' : 'status'}
		>
			{icon}
			<div className="min-w-0 flex-1 break-words">
				<span>{headline}</span>
				{hasDetails ? (
					<details className="mt-2">
						<summary className="cursor-pointer">Details</summary>
						<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
							{message}
						</pre>
					</details>
				) : null}
			</div>
			<Button
				aria-label="Dismiss"
				className="h-6 min-w-6 rounded p-0 text-current"
				isIconOnly
				variant="ghost"
				onPress={onDismiss}
			>
				<X className="h-3.5 w-3.5" />
			</Button>
		</div>
	);
}
