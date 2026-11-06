/** Agent-owned CLI/MCP connections can outlive the Electron desktop. */
export function isProductDesktopProcess(
	command,
	executable,
	productName,
	userDataDirectory
) {
	const marker = `/${productName}.app/Contents/`;
	const offset = executable.indexOf(marker);
	if (offset >= 0) {
		const withinBundle = executable.slice(offset + marker.length);
		// Exempt only the CLI, not the simulator/native-host helpers or any
		// Electron child. Those indicate an app that has not fully shut down.
		return !/^Resources\/native\/rndevtools(?:\s|$)/.test(withinBundle);
	}
	const name = executable.slice(executable.lastIndexOf('/') + 1);
	const desktop =
		name === productName ||
		name === 'Electron' ||
		name.startsWith(`${productName} Helper`) ||
		name.startsWith('Electron Helper');
	return desktop && command.includes(`--user-data-dir=${userDataDirectory}`);
}
