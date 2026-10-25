#!/usr/bin/env node
// Re-scores saved runs with the current leak rule and merges several results
// directories into one summary. Usage: node rescore.mjs <out.md> <dir> [<dir>...]
import fs from 'node:fs';
import path from 'node:path';
import { isLeak } from './leak-rule.mjs';

const [, , outFile, ...dirs] = process.argv;
const prompts = JSON.parse(fs.readFileSync(new URL('./prompts.json', import.meta.url), 'utf8'));
const all = [];
for (const dir of dirs) {
	for (const row of JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'))) {
		const bashLog = path.join(dir, `${row.id}.bash.jsonl`);
		const commands = fs.existsSync(bashLog)
			? fs.readFileSync(bashLog, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line).command]; } catch { return []; } })
			: [];
		all.push({ ...row, leakedCommands: commands.filter(isLeak), source: path.basename(dir) });
	}
}
const agents = [...new Set(all.map((r) => r.agent))].sort();
const conditions = ['none', 'skill', 'mcp', 'both'].filter((c) => all.some((r) => r.condition === c));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const lines = ['# Skill vs MCP: combined results', '', `Runs: ${all.length}. Adopted = at least one request reached the RN Devtools socket. Leaked = at least one Simulator-driving command that bypassed RN Devtools (mutating simctl, hand-started Metro, or a third-party driver such as idb/axe).`, '', '| agent | condition | runs | adopted | leaked | rndevtools calls (mcp / cli) | mean time | timeouts |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
for (const agent of agents) for (const condition of conditions) {
	const items = all.filter((r) => r.agent === agent && r.condition === condition);
	if (!items.length) continue;
	const adopted = items.filter((r) => r.adopted).length;
	const leaked = items.filter((r) => r.leakedCommands.length).length;
	const calls = items.reduce((n, r) => n + r.rndevtoolsRequests.length, 0);
	const mcp = items.reduce((n, r) => n + (r.viaMcp ?? 0), 0);
	const cli = items.reduce((n, r) => n + (r.viaCli ?? 0), 0);
	const seconds = Math.round(items.reduce((n, r) => n + r.seconds, 0) / items.length);
	const timeouts = items.filter((r) => r.error).length;
	lines.push(`| ${agent} | ${condition} | ${items.length} | ${adopted} (${pct(adopted, items.length)}) | ${leaked} (${pct(leaked, items.length)}) | ${calls} (${mcp} / ${cli}) | ${seconds}s | ${timeouts} |`);
}
lines.push('', '## Per prompt: adopted / runs (⚠ leaked, ⏱ timeout)', '');
const header = conditions.flatMap((c) => agents.map((a) => `${a}/${c}`));
lines.push(`| prompt | ${header.join(' | ')} |`, `| --- | ${header.map(() => '---').join(' | ')} |`);
for (const prompt of prompts) {
	const cells = conditions.flatMap((c) => agents.map((a) => {
		const items = all.filter((r) => r.prompt === prompt.id && r.condition === c && r.agent === a);
		if (!items.length) return '–';
		return `${items.filter((r) => r.adopted).length}/${items.length}${items.some((r) => r.leakedCommands.length) ? ' ⚠' : ''}${items.some((r) => r.error) ? ' ⏱' : ''}`;
	}));
	lines.push(`| ${prompt.id} | ${cells.join(' | ')} |`);
}
lines.push('', '## Every run', '', '| run | adopted | rndevtools calls | leaked commands | s |', '| --- | --- | --- | --- | --- |');
for (const r of all.sort((x, y) => x.id.localeCompare(y.id))) {
	lines.push(`| ${r.id} | ${r.adopted ? 'yes' : 'no'} | ${r.rndevtoolsRequests.join(', ') || '–'} | ${r.leakedCommands.map((c) => `\`${c.replace(/\|/g, '\\|').slice(0, 90)}\``).join('<br>') || '–'} | ${r.seconds}${r.error ? ' ⏱' : ''} |`);
}
fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
console.log(fs.readFileSync(outFile, 'utf8').split('\n').slice(0, 16).join('\n'));
