import { describe, expect, it } from 'vitest';
import { simulatorJobCancellationStatus } from './simulator-runtime';

describe('Simulator job cancellation feedback', () => {
	it('uses recording-specific accepted feedback when the caller supplies it', () => {
		expect(
			simulatorJobCancellationStatus(true, {
				successMessage: 'Stop requested. Finalizing the recording…',
			})
		).toEqual({
			kind: 'success',
			message: 'Stop requested. Finalizing the recording…',
		});
	});

	it('preserves generic cancellation feedback for other jobs', () => {
		expect(simulatorJobCancellationStatus(true)).toEqual({
			kind: 'success',
			message: 'Job cancelled.',
		});
		expect(simulatorJobCancellationStatus(false)).toEqual({
			kind: 'error',
			message: 'The job could not be cancelled.',
		});
	});
});
