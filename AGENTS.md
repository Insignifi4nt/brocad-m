# Agent Documentation

## Project Overview

Wire EDM Workbench is being rebuilt as a client-only, local-first Wire EDM app. The scaffold must stay API-first: add tested functionality before exposing UI controls for it. The root app must work without folder permissions by using a browser-cache workbench first, while keeping the File System Access folder flow as an optional persistence upgrade.

## Commands

- `npm run dev` - start Vite on port **3777**
- `npm test -- --run` - run tests once
- `npm test -- --run --project pure-domain` - run pure geometry/planning suites in Node
- `npm test -- --run --project browser` - run browser storage, DOM and app suites
- `PLANEGCS_CORPUS_TALLY=1 npm test -- --run src/features/cad/sketch-solver/__tests__/planeGcsCorpus.test.ts --silent=false` - replay the frozen PlaneGCS corpus natively and print its tally; the corpus is fixed since PlaneGCS was removed in 0.0.757
- `npm run solver:build` / `npm run solver:check` - rebuild the Rust sketch solver module, or test it and verify the committed module matches its source (needs `rustup`)
- `npm run build` - type-check (TypeScript 7 native `tsc`) and build
- `npm run lint` - oxlint correctness rules, the precision literal check (`docs/maintainers/precision.md`) and the feature activity check (`docs/maintainers/cad-features.md`); must stay at zero findings
- `npm run ui:check` - enforce shared controls, menus and tooltip ownership
- `npm run preview` - preview production build on port **3778**

## Dev Server Port

- Always run this app's Vite server on the configured obscure port **3777** (`strictPort`). Preview uses **3778**. Playwright owns **3107**.
- Never start this app on common development ports (`3000`, `3001`, `5173`, `4173`, etc.), even as a temporary fallback when 3777 is busy.
- The app registers browser workers that are not reliably cleaned up after the tab/session ends. A leftover worker bound to a previous port can interfere with other projects that later reuse that same port—which is why this app stays off commonly used ports.
- If 3777 is occupied by this app's own leftover process, stop that WireEDM process and restart on 3777. Do not fall back to another port. Do not kill unrelated projects' servers.

## Stack

- Vite
- React
- TypeScript 7 (`typescript`); AST scripts that need the compiler API import `@typescript/typescript6`
- Tailwind CSS
- shadcn/ui-compatible component structure
- Vitest 5, oxlint, Playwright
- Rust (toolchain pinned in `packages/sketch-solver/rust-toolchain.toml`) for the WebAssembly sketch solver

## Structure

- `src/app/` - shell and app-level composition
- `src/components/ui/` - shadcn-compatible UI primitives
- `src/domain/` - workbench, storage, and G-code output models
- `packages/sketch-solver/` - Rust sketch constraint solver and its committed WebAssembly module
- `src/features/` - dashboard, editor tools, and their UI tests
- `docs/superpowers/` - design and implementation planning notes

## Product Rules

- Warn explicitly about breaking or potentially breaking changes to installed post processors in the PR, release compatibility record, and affected user-facing diagnostics. Cover schemas, capabilities, execution events, audit rules, output, and installation; never silently rewrite installed packages or saved revisions.
- Ship changes through reviewed pull requests. Each merged PR advances the app version once and includes a compatibility checklist; keep the app release number separate from UPID, post schema, and engine API versions. Do not push directly to main.
- Name branches `<type>/<topic>` in lowercase kebab case, where type is one of `feature`, `fix`, `design`, `docs`, `ci`, `refactor`, `perf`, `test`, `deps`, `audit` or `release`, and the topic describes the change (`feature/sketch-trim-extend`, `fix/far-origin-tangency`). Never name a branch or PR after the tool or agent that wrote it (no `claude/`, `codex/` or similar), and do not add dates unless they disambiguate. PR titles are sentence-case summaries of the user-visible result without bracketed tags. `scripts/check-pull-request-naming.mjs` enforces this in review checks.
- Keep one coherent change per PR and fill in `.github/pull_request_template.md`. Continue an open PR's branch rather than opening a parallel one, and delete the branch once it is merged.
- Public documentation and repair prompts serve users and agents with only the hosted app and a cloud browser. Never require a repository checkout, terminal, npm command, or access to another browser's files. Expose needed authoring operations through the hosted UI and shared domain APIs. Keep deployment rationale, release-maintainer procedures and internal roadmap notes out of public authoring pages.
- WebMCP tools reuse application operations and their checks. Keep arguments narrow, distinguish drafts from saved projects, preserve cancellation and input-version checks, and update the public agent-tool guide when changing the exposed tools. Do not bypass UI-only guards by exposing a controller handler directly.
- Keep browser URLs in the shared workbench routing boundary. Route-driven opens use the same cancellable, draft-protected operations as other callers; controller-driven imports, handoffs and saves publish their actual project identity. Preserve the deployment base and static deep-link fallback.
- Storage changes must cover browser cache and folder adapters. Validate proposed migrations before writes, preserve and verify exact originals, reject conflicting backups, and test interrupted upgrades/retries. Never infer that unreferenced files, trash, transaction journals or old package snapshots are safe to delete. See `docs/maintainers/storage-and-migrations.md` for the storage map and remaining recovery work.

- Preserve the old editor behavior before replacing it.
- Do not add mock project names, fake library rows, or buttons that only change screens.
- DXF converted by this app is treated as clean internal geometry.
- Browser-cache and one-off imports must stay supported even when directory picker APIs are unavailable.
- External `.gcode`, `.nc`, `.iso`, and `.txt` files should keep the old cleanup/display pipeline when ported.
- V1 output is generated from a saved revision and the active machine setup supplied by a complete `.wireedm-package`. Do not add feed generation by default.
- Controller-file rules (extension, encoding, line endings, wrappers, and numbering) belong to the exact post processor inside the machine package; do not add workbench-level output preferences.

## Style

- Technical workbench UI: thin bars, small writing, dense but readable panels.
- Keep files focused and typed.
- Prefer explicit domain models over ad hoc strings for project files, output templates, and export formats.
- Follow the component/state, token/scale, help, layout and responsive contract in [`docs/maintainers/ui-components.md`](docs/maintainers/ui-components.md). New UI uses the shared theme and supported components, including `InfoTip` for heading help and `SearchField` for collapsible controlled search. Add reusable behavior in `src/components/ui/` only when a real consumer needs it.
- Feature code owns domain behavior and layout. Shared UI owns control appearance, focus, disabled and invalid states; `theme.css` owns literal control colors. Feature CSS may size/place controls. Preserve deliberate model/status colors and measured technical layouts without creating another control palette.
- Use sentence case for interface content. Preserve acronyms, axes, identifiers, filenames and source text. `npm run ui:check` enforces shared control/menu/help ownership, rejects forced uppercase and title-capitalization styles, keeps shared CSS palette literals in the theme and reserves `.ui-*` appearance for shared CSS. Do not bypass it with aliases, factories or local replacements.
- Use semantic named icons from `@wire-edm/icons-react`, with theme sizes and control-owned color/state. `scripts/icon-source.mjs` is the drawing source; `npm run icons:generate` updates package modules and SVG assets together. Keep full dynamic/catalog imports explicit. `npm run icons:check` verifies generation, purpose mapping, package behavior and isolated packed consumers. See `packages/icons-react/README.md`.
- Preserve native labels, options, refs, forms, edited values, file selection, input methods and keyboard owners. Keep source typography and pending expression precision. Use compact toolbar density, content-driven multiline rows and the shared progressive native picker. Help keeps triggers stable and commands clickable; rich interactive help uses its owning disclosure. Styling preserves operation validation and workflow guards.

## Context, Subagent, and Testing Discipline

- Multi-agent work follows [`docs/maintainers/agent-delivery.md`](docs/maintainers/agent-delivery.md): a coordinator, one implementer and an independent reviewer per change, a draft pull request so CI runs the heavy checks during review, and the self-check every implementer completes before reporting.

- Be deliberate with context usage. Do not spawn subagents reflexively or fragment work into tiny delegated tasks. Complete a meaningful investigation or implementation chunk first; delegate only substantial, separable work or independent review.
- When a subagent finds a valid issue and its proposed fix is sound, prefer letting that same subagent implement and verify it so context is not repeatedly transferred.
- Add tests for meaningful behavior, realistic regressions, edge cases, and data integrity. Do not add tests merely to prove removed UI/code is absent unless that absence is an important invariant.
- Use the cheapest reliable verification first. After localized changes, run focused tests and relevant type/lint/build checks; expand to broader suites when changes cross systems, affect shared infrastructure, or have uncertain blast radius.
- Optimize for reliable implementation with proportionate effort, not maximum tool calls, agent count, or test count.
