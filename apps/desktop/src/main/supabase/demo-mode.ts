/**
 * Whether the Supabase tab serves the in-memory demo stacks instead of the
 * real service: only an unpackaged build started with RNDEVTOOLS_DEMO=true.
 * A packaged app never shows fixture state, whatever its environment says,
 * the same rule as trustedDevelopmentRendererUrl.
 */
export function shouldUseSupabaseDemo(
	value: string | undefined,
	isPackaged: boolean
): boolean {
	return !isPackaged && value === 'true';
}
