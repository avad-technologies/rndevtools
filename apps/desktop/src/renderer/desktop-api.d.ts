import type { AgentBridge } from '../shared/agent-protocol';
import type { AppearanceBridge } from '../shared/appearance-protocol';
import type { BuildInsightsBridge } from '../shared/build-insights-protocol';
import type { LaneBridge } from '../shared/lane-protocol';
import type { DesktopBridge } from '../shared/protocol';
import type { RecipeBridge } from '../shared/recipe-protocol';
import type { SimulatorInputBridge } from '../shared/simulator-input-protocol';
import type { SimulatorBridge } from '../shared/simulator-protocol';
import type { SimulatorStreamBridge } from '../shared/simulator-stream-protocol';
import type { SlimmingBridge } from '../shared/slimming-protocol';
import type { SupabaseBridge } from '../shared/supabase-protocol';

declare global {
	interface Window {
		rnDevtools?: DesktopBridge &
			AppearanceBridge &
			SimulatorBridge &
			SlimmingBridge &
			RecipeBridge &
			BuildInsightsBridge &
			LaneBridge &
			AgentBridge &
			SimulatorInputBridge &
			SimulatorStreamBridge &
			SupabaseBridge;
	}
}
