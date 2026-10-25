import { simulatorUdidFromPath } from './simulator-identity';

const UDID = '727CE7B2-CCBA-47A5-8803-1D61DCEBCF44';

describe('simulatorUdidFromPath', () => {
	it('extracts the UDID from a CoreSimulator container path', () => {
		expect(
			simulatorUdidFromPath(
				`/Users/dev/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Data/Application/1234/Documents/`,
			),
		).toBe(UDID);
	});

	it('accepts file URIs and percent-encoded paths, normalizing case', () => {
		expect(
			simulatorUdidFromPath(
				`file:///Users/dev/Library/Developer/CoreSimulator/Devices/${UDID.toLowerCase()}/data/Containers/Data/Application/1234/Library/Caches/`,
			),
		).toBe(UDID);
		expect(
			simulatorUdidFromPath(
				`file:///Users/example%20user/Library/Developer/CoreSimulator/Devices/${UDID}/data/`,
			),
		).toBe(UDID);
	});

	it('returns undefined off the Simulator', () => {
		expect(
			simulatorUdidFromPath(
				'file:///var/mobile/Containers/Data/Application/ABCD/Documents/',
			),
		).toBeUndefined();
		expect(
			simulatorUdidFromPath('file:///data/user/0/com.example.app/files/'),
		).toBeUndefined();
		expect(simulatorUdidFromPath(undefined)).toBeUndefined();
		expect(simulatorUdidFromPath('')).toBeUndefined();
		expect(simulatorUdidFromPath('x'.repeat(5_000))).toBeUndefined();
	});

	it('ignores look-alike segments that are not a UDID', () => {
		expect(
			simulatorUdidFromPath('/CoreSimulator/Devices/not-a-udid/data/'),
		).toBeUndefined();
	});
});
