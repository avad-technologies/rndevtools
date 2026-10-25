#!/usr/bin/env node
// Claude Code PreToolUse hook used by the experiment: records every Bash command
// to the given JSONL file and ALLOWS it (exit 0). Measurement only.
import fs from 'node:fs';
const [, , logPath] = process.argv;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
	try {
		const payload = JSON.parse(input);
		if (payload.tool_name === 'Bash' && payload.tool_input?.command) {
			fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), command: payload.tool_input.command })}\n`);
		}
	} catch { /* fail open */ }
	process.exit(0);
});
