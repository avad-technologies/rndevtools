import { Card } from '@heroui/react/card';
import {
	ArrowRight,
	History,
	RotateCcw,
	ShieldAlert,
	UserRoundCheck,
} from 'lucide-react';
import {
	Badge,
	ConfirmAction,
	EmptyPanel,
	PanelHeader,
	PanelNotice,
	StatusPill,
} from '@/components/ui';
import { formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';

export function IdentityPanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const session = selectedDevice?.tools.identitySession ?? {
		running: false,
		history: [],
		personas: [],
	};
	const active = session.active;
	const startReason = actionUnavailableReason('identity', 'start');
	const stopReason = actionUnavailableReason('identity', 'stop');

	return (
		<section className="panel-root">
			<PanelHeader
				actions={
					active ? (
						<ConfirmAction
							confirmLabel="Restore actor"
							description={`Stop ${active.target.label}, clear its owner-bound caches, and restore ${active.actor.label} from the device-only recovery session.`}
							isDisabled={!canRunAction('identity', 'stop')}
							onConfirm={() =>
								void runAction(
									'identity',
									'stop',
									{},
									'Original actor restored.'
								)
							}
							title={`Restore ${active.actor.label}?`}
							tone="warning"
							triggerIcon={<RotateCcw className="h-3.5 w-3.5" />}
							triggerLabel="Stop identity"
							triggerVariant="secondary"
						/>
					) : null
				}
				description="Run allowlisted seeded identities as reversible sessions while keeping the original actor recoverable on the device."
				meta={
					<StatusPill
						dot
						tone={
							active?.status === 'needs-attention'
								? 'danger'
								: active
									? 'warning'
									: 'success'
						}
					>
						{active?.status === 'needs-attention'
							? 'Recovery needs attention'
							: active
								? `${active.target.label} active`
								: 'Original actor active'}
					</StatusPill>
				}
				title="Test Identities"
			/>
			<PanelNotice title="Seeded identities only." tone="info">
				The desktop receives redacted actor/target labels and bounded history.
				Account emails, passwords, access tokens, refresh tokens, and
				arbitrary-user lookup are never projected.
			</PanelNotice>
			{active ? (
				<div
					className={`flex shrink-0 items-center gap-4 border-b px-5 py-4 ${active.status === 'needs-attention' ? 'border-(--danger)/25 bg-(--danger)/[0.06]' : 'border-(--warning)/25 bg-(--warning)/[0.06]'}`}
				>
					<div className="grid h-9 w-9 place-items-center rounded-full border border-foreground/10 bg-background/30">
						{active.status === 'needs-attention' ? (
							<ShieldAlert className="h-4 w-4 text-(--danger-text)" />
						) : (
							<UserRoundCheck className="h-4 w-4 text-(--warning-text)" />
						)}
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2 text-sm font-semibold text-(--foreground)">
							<span>{active.actor.label}</span>
							<ArrowRight className="h-3.5 w-3.5 text-(--text-3)" />
							<span>{active.target.label}</span>
						</div>
						<p className="mb-0 mt-1 text-xs text-(--muted)">
							Started {formatRelativeTime(active.startedAt)}. Stop restores the
							exact original actor session.
						</p>
						{active.error ? (
							<p className="mb-0 mt-1 text-xs text-(--danger-text)">
								{active.error}
							</p>
						) : null}
						{stopReason ? (
							<p className="mb-0 mt-1 text-xs text-(--text-3)">
								Stop unavailable: {stopReason}
							</p>
						) : null}
					</div>
				</div>
			) : null}
			<div className="panel-scroll p-5">
				<h2 className="mb-3 mt-0 text-xs font-medium uppercase tracking-[0.08em] text-(--text-3)">
					Seeded identities
				</h2>
				{session.personas.length === 0 ? (
					<EmptyPanel
						compact
						description="Connect a development build of your app that advertises identity sessions."
						icon={<UserRoundCheck className="h-5 w-5" />}
						title="No test identities advertised"
					/>
				) : (
					<>
						<div className="grid grid-cols-2 gap-3 max-[1100px]:grid-cols-1">
							{session.personas.map((persona) => {
								const selected = active?.target.personaId === persona.id;
								return (
									<Card
										className="rounded-lg border border-foreground/8 bg-foreground/[0.025] shadow-none"
										key={persona.id}
										variant="secondary"
									>
										<Card.Content className="flex items-center gap-3 p-4">
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<strong className="text-xs text-(--foreground)">
														{persona.label}
													</strong>
													{selected ? (
														<Badge tone="warning">Active</Badge>
													) : null}
												</div>
												<p className="mb-0 mt-1 text-xs text-(--muted)">
													{persona.note}
												</p>
											</div>
											<ConfirmAction
												confirmLabel="Start identity"
												description={`Secure the current actor on-device, clear owner-bound caches, and continue as ${persona.label}.`}
												isDisabled={
													selected || !canRunAction('identity', 'start')
												}
												onConfirm={() =>
													void runAction(
														'identity',
														'start',
														{ personaId: persona.id },
														`Testing as ${persona.label}.`
													)
												}
												title={`Start ${persona.label}?`}
												tone="warning"
												triggerLabel={selected ? 'Active' : 'Start'}
												triggerVariant="secondary"
											/>
										</Card.Content>
									</Card>
								);
							})}
						</div>
						{!active && startReason ? (
							<p className="mt-3 text-xs text-(--text-3)">
								Starting an identity is unavailable: {startReason}
							</p>
						) : null}
					</>
				)}

				<h2 className="mb-3 mt-6 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-(--text-3)">
					<History className="h-3.5 w-3.5" /> Recent sessions
				</h2>
				{session.history.length === 0 ? (
					<p className="text-xs text-(--text-3)">
						No managed identity sessions yet.
					</p>
				) : (
					<div className="overflow-hidden rounded-lg border border-foreground/8">
						{session.history.map((entry) => (
							<div
								className="flex items-center gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-0"
								key={entry.id}
							>
								<div className="min-w-0 flex-1 text-xs text-(--foreground)">
									{`${entry.actor.label} → ${entry.target.label}`}
								</div>
								<span className="text-xs text-(--text-3)">
									{formatRelativeTime(entry.startedAt)}
								</span>
								<StatusPill
									tone={
										entry.status === 'stopped'
											? 'success'
											: entry.status === 'needs-attention'
												? 'danger'
												: 'warning'
									}
								>
									{entry.status === 'stopped'
										? 'RESTORED'
										: entry.status.toUpperCase()}
								</StatusPill>
							</div>
						))}
					</div>
				)}
			</div>
		</section>
	);
}
