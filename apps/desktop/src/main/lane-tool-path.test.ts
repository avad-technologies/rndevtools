import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolPathResolver, readLoginShellPath } from './lane-tool-path';

describe('createToolPathResolver', () => {
	let root: string;
	let empty: string;
	let tools: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-tool-path-'));
		empty = path.join(root, 'empty');
		tools = path.join(root, 'tools');
		await mkdir(empty);
		await mkdir(tools);
		await writeFile(path.join(tools, 'node'), '#!/bin/sh\n', { mode: 0o755 });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('asks the shell when nothing on the inherited PATH can run as node', async () => {
		// A directory, or a file without its execute bit, is no Node to env.
		await mkdir(path.join(empty, 'node'));
		const other = path.join(root, 'other');
		await mkdir(other);
		await writeFile(path.join(other, 'node'), '', { mode: 0o644 });
		let reads = 0;
		const resolve = createToolPathResolver({
			readShellPath: async () => {
				reads += 1;
				return tools;
			},
		});
		expect(await resolve(`${empty}${path.delimiter}${other}`)).toBe(
			[tools, empty, other].join(path.delimiter)
		);
		expect(reads).toBe(1);
	});

	it('keeps an inherited PATH that already finds Node and never asks the shell', async () => {
		let reads = 0;
		const resolve = createToolPathResolver({
			readShellPath: async () => {
				reads += 1;
				return '/opt/example/bin';
			},
		});
		const inherited = `${empty}${path.delimiter}${tools}`;
		expect(await resolve(inherited)).toBe(inherited);
		expect(reads).toBe(0);
	});

	it("puts the login shell's PATH ahead of a launchd PATH, asking the shell once", async () => {
		let reads = 0;
		const resolve = createToolPathResolver({
			readShellPath: async () => {
				reads += 1;
				return `${tools}:relative/bin:${empty}`;
			},
		});
		// Relative entries are dropped and an entry is listed once.
		expect(await resolve(empty)).toBe(`${tools}${path.delimiter}${empty}`);
		expect(await resolve(`${empty}:/usr/bin`)).toBe(
			[tools, empty, '/usr/bin'].join(path.delimiter)
		);
		expect(reads).toBe(1);
	});

	it('leaves the inherited PATH when the shell gave nothing, and asks again next time', async () => {
		const answers: Array<string | undefined> = [undefined, tools];
		let reads = 0;
		const resolve = createToolPathResolver({
			readShellPath: async () => {
				reads += 1;
				return answers.shift();
			},
		});
		expect(await resolve(empty)).toBe(empty);
		expect(await resolve(empty)).toBe(`${tools}${path.delimiter}${empty}`);
		expect(reads).toBe(2);
	});
});

describe('readLoginShellPath', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-login-shell-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function fakeShell(body: string): Promise<string> {
		// Named like a real shell so it is the one asked; `$2` is the command.
		const shell = path.join(root, 'zsh');
		await writeFile(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		return shell;
	}

	it('takes only PATH from what the rc files print', async () => {
		const shell = await fakeShell(
			[
				'echo "Welcome back from an rc file"',
				'PATH=/opt/example/bin:/usr/bin:/bin',
				'export PATH',
				'eval "$2"',
				'echo "a goodbye nobody reads"',
			].join('\n')
		);
		expect(
			await readLoginShellPath({ env: { SHELL: shell, HOME: root } })
		).toBe('/opt/example/bin:/usr/bin:/bin');
	});

	it('gives up on a shell that hangs, and kills it', async () => {
		const pidFile = path.join(root, 'pid');
		const shell = await fakeShell(`echo $$ > '${pidFile}'\nexec sleep 30`);
		const started = Date.now();
		expect(
			await readLoginShellPath({
				env: { SHELL: shell, HOME: root },
				timeoutMs: 1_000,
			})
		).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(5_000);
		const pid = Number((await readFile(pidFile, 'utf8')).trim());
		const deadline = Date.now() + 5_000;
		let alive = true;
		while (alive && Date.now() < deadline) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
	});

	it('reads a shell that exits without printing the value as undefined', async () => {
		const shell = await fakeShell('exit 0');
		expect(
			await readLoginShellPath({ env: { SHELL: shell, HOME: root } })
		).toBeUndefined();
	});
});
