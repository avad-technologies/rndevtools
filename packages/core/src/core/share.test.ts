import { Share } from 'react-native';
import { shareDiagnosticContent } from './share';

describe('shareDiagnosticContent', () => {
	it('contains synchronous native bridge failures', () => {
		const share = jest.spyOn(Share, 'share').mockImplementation(() => {
			throw new Error('bridge unavailable');
		});

		expect(() =>
			shareDiagnosticContent({ message: 'diagnostic export' }),
		).not.toThrow();
		expect(share).toHaveBeenCalledWith({ message: 'diagnostic export' });
	});

	it('contains asynchronous share failures', async () => {
		jest.spyOn(Share, 'share').mockRejectedValue(new Error('share rejected'));

		shareDiagnosticContent({ message: 'diagnostic export' });
		await Promise.resolve();
	});
});
