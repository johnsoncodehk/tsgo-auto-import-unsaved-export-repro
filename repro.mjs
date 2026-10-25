// Reproduces: TypeScript 7 drops an export that only exists as unsaved content from its auto-import data.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API } from 'typescript/async';

const require = createRequire(import.meta.url);
const tsVersion = require('typescript/package.json').version;
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const project = path.join(path.dirname(fileURLToPath(import.meta.url)), 'project').replace(/\\/g, '/');
const ITERATIONS = Number(process.env.ITERATIONS ?? 5);

// not on disk: a file created in the editor and not saved yet
const importer = `${project}/importer.ts`;
if (fs.existsSync(importer)) throw new Error(`${importer} must not exist on disk`);
// empty on disk; opened with `export function unsavedFn() {}`
const exporter = { file: `${project}/exporter.ts`, name: 'unsavedFn', text: 'export function unsavedFn() {}\n' };
// the same kind of export, saved on disk and opened unchanged
const saved = { file: `${project}/saved.ts`, name: 'savedFn', text: fs.readFileSync(`${project}/saved.ts`, 'utf8') };
const uri = file => pathToFileURL(file).href;

function startServer() {
	const proc = spawn(process.execPath, [tsc, '--lsp', '--stdio'], { cwd: project, stdio: ['pipe', 'pipe', process.env.TSGO_STDERR ? 'inherit' : 'ignore'] });
	const pending = new Map();
	let buffer = Buffer.alloc(0);
	let nextId = 0;
	const send = message => {
		const text = JSON.stringify({ jsonrpc: '2.0', ...message });
		proc.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
	};
	proc.stdout.on('data', chunk => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
			if (buffer.length < headerEnd + 4 + length) return;
			const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
			buffer = buffer.subarray(headerEnd + 4 + length);
			if (message.method === undefined) {
				pending.get(message.id)?.(message);
				pending.delete(message.id);
			}
			else if (message.id !== undefined) {
				// requests from the server, e.g. workspace/configuration
				send({ id: message.id, result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null });
			}
		}
	});
	const server = {
		request: (method, params) =>
			new Promise((resolve, reject) => {
				const id = ++nextId;
				pending.set(id, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
				send({ id, method, params });
			}),
		notify: (method, params) => send({ method, params }),
		// a round trip guarantees the notifications sent before it were read
		sync: () => server.request('repro/sync', {}).catch(() => {}),
		open: (file, text) => server.notify('textDocument/didOpen', { textDocument: { uri: uri(file), languageId: 'typescript', version: 1, text } }),
		close: file => server.notify('textDocument/didClose', { textDocument: { uri: uri(file) } }),
		completionLabels: async (file, line, character) => {
			const list = await server.request('textDocument/completion', { textDocument: { uri: uri(file) }, position: { line, character } });
			return (Array.isArray(list) ? list : list?.items ?? []).map(item => item.label);
		},
		shutdown: async () => {
			await server.request('shutdown', null).catch(() => {});
			server.notify('exit', null);
			proc.stdin.end();
			const exited = new Promise(resolve => proc.once('exit', resolve));
			const timer = setTimeout(() => proc.kill(), 2000);
			await exited;
			clearTimeout(timer);
		},
	};
	return server.request('initialize', {
		processId: process.pid,
		rootUri: uri(project),
		capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } } } },
	}).then(() => {
		server.notify('initialized', {});
		return server;
	});
}

/** One case on a fresh server: `ITERATIONS` times the editor sequence, then whether `target`'s export can be auto-imported. */
async function runCase({ path: via, warmUp, target }) {
	const server = await startServer();
	const { pipe } = await server.request('custom/initializeAPISession', {});
	const api = await API.fromLSPConnection({ pipe });
	let ok = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		// 1. open the importer (unsaved)
		server.open(importer, 'export {};\n');
		await server.sync();
		// 2. compute auto-imports once (any completion in the importer does)
		if (warmUp) {
			await server.completionLabels(importer, 0, 0);
		}
		// 3. close the importer
		server.close(importer);
		// 4. open the exporter (unsaved content differing from disk, or saved content unchanged)
		server.open(target.file, target.text);
		await server.sync();
		// 5. reopen the importer using the export, and ask for its auto-import
		server.open(importer, `${target.name};\n`);
		await server.sync();
		if (via === 'API') {
			const snapshot = await api.getCurrentLanguageServerSnapshot({ openFiles: [importer] });
			try {
				const p = await snapshot.getDefaultProjectForFile(importer);
				const moduleSymbol = await p.checker.getSymbolOfSourceFile(target.file);
				const symbol = moduleSymbol && await p.checker.getMemberInModuleExports(moduleSymbol, target.name);
				if (!symbol) throw new Error(`symbol ${target.name} not found`);
				const edits = await p.languageService.getImportEditsForSymbols(importer, [symbol]);
				if (edits.length) ok++;
			}
			finally {
				await snapshot.dispose();
			}
		}
		else {
			const labels = await server.completionLabels(importer, 0, target.name.length);
			if (labels.includes(target.name)) ok++;
		}
		server.close(target.file);
		server.close(importer);
		await server.sync();
	}
	await api.close();
	await server.shutdown();
	return ok;
}

const cases = [
	{ bug: true, path: 'API', warmUp: true, target: exporter, title: 'getImportEditsForSymbols, unsaved export, auto-imports computed before' },
	{ bug: true, path: 'LSP', warmUp: true, target: exporter, title: 'completion,               unsaved export, auto-imports computed before' },
	{ bug: false, path: 'API', warmUp: false, target: exporter, title: 'getImportEditsForSymbols, unsaved export, no auto-imports before (control)' },
	{ bug: false, path: 'LSP', warmUp: false, target: exporter, title: 'completion,               unsaved export, no auto-imports before (control)' },
	{ bug: false, path: 'API', warmUp: true, target: saved, title: 'getImportEditsForSymbols, saved export,   auto-imports computed before (control)' },
	{ bug: false, path: 'LSP', warmUp: true, target: saved, title: 'completion,               saved export,   auto-imports computed before (control)' },
];

console.log(`typescript ${tsVersion}, node ${process.version}, ${os.platform()} ${os.arch()}, ${ITERATIONS} iterations per case`);
console.log('PASS = the export is offered for auto-import (an import edit / a completion entry)\n');
let bugFailures = 0;
let controlFailures = 0;
for (const c of cases) {
	const ok = await runCase(c);
	const failed = ITERATIONS - ok;
	if (c.bug) bugFailures += failed;
	else controlFailures += failed;
	console.log(`${failed ? 'FAIL' : 'PASS'} ${ok}/${ITERATIONS}  [${c.path}] ${c.title}`);
}
console.log();
if (controlFailures) {
	console.log(`Controls failed ${controlFailures} times: the setup is broken, the result is inconclusive.`);
	process.exit(2);
}
if (bugFailures) {
	console.log(`Bug reproduced: ${bugFailures} of ${ITERATIONS * 2} requests did not offer the unsaved export; all controls passed.`);
	process.exit(1);
}
console.log('Bug not reproduced: every request offered the export.');
