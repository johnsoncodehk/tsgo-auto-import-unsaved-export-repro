# TypeScript 7: an unsaved new export is not offered for auto-import

After auto-imports have been computed once, TypeScript 7 leaves out an export that only exists as unsaved editor content when the following sequence happens. The importing file is a new file that is not saved on disk. It is closed, the exporting file is opened with content that differs from disk, and the importing file is opened again. After that, the API's `getImportEditsForSymbols` returns `[]` for the export, and LSP completion in the importer has no auto-import entry for it. This stays the same until the exporting file changes again. Real editors are affected: a new export that has not been saved yet is not offered for auto-import. (Found while investigating a flaky Vue language tools test, vuejs/language-tools#5847.)

## Versions tested

- `typescript` 7.1.0-beta (pinned in `package.json` and `package-lock.json`)
- Node v24.15.0
- macOS 26.3 (arm64)

## Steps

```sh
npm ci
npm run repro   # exits with code 1 when the bug reproduces
```

`repro.mjs` starts `tsc --lsp --stdio` in `project/` and opens an API session on it (`custom/initializeAPISession`). Each case runs on a fresh server and repeats the following 5 times (`ITERATIONS=n` to change):

1. Open `importer.ts`, which does not exist on disk, with `export {};`.
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

If `importer.ts` exists on disk (for example as an empty file), the failure becomes intermittent instead of deterministic. `TSGO_STDERR=1` shows the server log.
