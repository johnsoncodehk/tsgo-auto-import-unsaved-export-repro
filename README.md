# TypeScript 7: an unsaved new export is not offered for auto-import

In this sequence, `importer.ts` is an open `file:` document that does not exist on disk. After auto-imports have been computed once, `importer.ts` is closed. Then `exporter.ts` is opened with content that differs from disk, and `importer.ts` is opened again. After that, TypeScript 7 does not offer the new export for auto-import. The API's `getImportEditsForSymbols` returns `[]` for it, and LSP completion in `importer.ts` has no auto-import entry for it. In our runs, the export was still missing after waiting 5 seconds and after editing `importer.ts`. It was offered again only after `exporter.ts` was edited.

Found while investigating a Vue language tools test (vuejs/language-tools#5847).

## Versions tested

- `typescript` 7.1.0-beta (pinned in `package.json` and `package-lock.json`): reproduces
- `typescript` 7.1.0-dev.20261024.1: reproduces
- `typescript` 7.0.2: reproduces (LSP case only; this version has no `typescript/async` API, so the API cases cannot run)
- Node v24.15.0
- macOS 26.3 (arm64)

## Steps

```sh
npm ci
npm run repro   # exits with code 1 when the bug reproduces
```

`repro.mjs` starts `tsc --lsp --stdio` in `project/` and opens an API session on it (`custom/initializeAPISession`). Each case runs on a fresh server and repeats the following 5 times (`ITERATIONS=n` to change):

1. Open `importer.ts` with `export {};`. It is a `file:` document that does not exist on disk.
2. Compute auto-imports once, with a completion request in `importer.ts`.
3. Close `importer.ts`.
4. Open `exporter.ts`, which is empty on disk, with `export function unsavedFn() {}`.
5. Open `importer.ts` again with `unsavedFn;`. Then request either the API's `getImportEditsForSymbols(importer, [unsavedFn])` or an LSP completion at the end of `unsavedFn`.

## Expected

`getImportEditsForSymbols` returns an import edit, and the completion list contains `unsavedFn` as an auto-import.

## Actual

```
FAIL 0/5  [API] getImportEditsForSymbols, unsaved export, auto-imports computed before
FAIL 0/5  [LSP] completion,               unsaved export, auto-imports computed before
PASS 5/5  [API] getImportEditsForSymbols, unsaved export, no auto-imports before (control)
PASS 5/5  [LSP] completion,               unsaved export, no auto-imports before (control)
PASS 5/5  [API] getImportEditsForSymbols, saved export,   auto-imports computed before (control)
PASS 5/5  [LSP] completion,               saved export,   auto-imports computed before (control)
```

Controls, which run the same sequence:

- Without step 2, the export is offered every time.
- With an export that is saved on disk (`saved.ts`, opened unchanged) instead of `exporter.ts`, the export is offered every time.

If `importer.ts` exists on disk as an empty file, the result is different. With 20 iterations on 7.1.0-dev.20261024.1, LSP completion did not fail (0 of 20), and the API's `getImportEditsForSymbols` failed occasionally (1 to 2 of 20 per run).

`TSGO_STDERR=1` shows the server log.
