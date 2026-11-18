# Contributing to EEG Workbench

Thank you for helping. This guide gets you from a fresh clone to a merged change.

## Ways to help

- **Report a problem.** Open an issue with what you did, what you expected and what happened. If a recording fails to open, say which format and which system recorded it (please do not attach identifiable data).
- **Improve an explanation.** Every step has a plain-language description in `src/steps.ts`. Clearer wording is a valuable contribution.
- **Add a processing step or an analysis.** See below.
- **Translate.** Translation support is on the roadmap; say so in an issue if you want to help shape it.

## Setup

```bash
npm install
npm run dev
```

Before opening a pull request, run the same three checks that CI runs:

```bash
npm run lint          # static checks
npm run build         # type-check and build
npm run test:engine   # run the engine tests under Pyodide (first run downloads ~40 MB into .cache/)
```

## Branches and pull requests

- Fork the repository and create a branch from `main` with a short descriptive name (`fix-notch-harmonics`, `add-psd-export`).
- Keep each pull request to one change. Small, focused pull requests are reviewed and merged faster.
- Describe what changed and how to try it; the pull request template will prompt you.
- If you are unsure whether an idea fits, open an issue first.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## How the pieces fit

- `src/engine/python/engine.py` holds all signal processing and session state. The interface never does signal maths; it sends commands and draws the arrays that come back.
- The **pipeline** is an ordered list of steps (`{ id, type, params, enabled }`). The engine replays it from the original data, so undo, redo, enable/disable and code export all come from the same list.
- Results reach the interface as JSON plus flat arrays (`Out.arr`), which arrive as typed arrays with a shape.

## Adding a pipeline step

1. **Define it** in `src/steps.ts`: label, explanation, tip, fields, defaults, summary and validation. The form is generated from the fields.
2. **Implement it** in `engine.py` inside `_apply_step`. Modify `raw` in place using MNE-Python.
3. **Export it** in `_step_code`: return a title, a one-line reason and the Python code that reproduces the step.
4. **Add its type** to `StepType` in `src/types.ts` and to `ADD_ORDER` in `src/steps.ts`.
5. **Test it** by adding a case to `scripts/engine-test.mjs`.

## Adding an analysis

1. Write a `cmd_<name>` function in `engine.py` and register it in `COMMANDS`.
2. Add a result type in `src/types.ts`.
3. Call it from a component with `engine.call("<name>", args)` and draw the result with the helpers in `src/components/charts.tsx`.
4. If it has settings worth reproducing, record them on the session and emit code in `_sections`.

## Style

- TypeScript in strict mode; no signal processing in the interface.
- Python: clear names, short functions, and a docstring wherever behaviour is not obvious.
- User-facing text: plain language, no jargon without an explanation, and no claims the tool cannot support.
- Every explanation, default and rule of thumb should be defensible. Add a reference in the pull request when you introduce one.

## Scope

EEG Workbench is for research and education. Features that present output as a diagnosis or clinical decision are out of scope.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0.
