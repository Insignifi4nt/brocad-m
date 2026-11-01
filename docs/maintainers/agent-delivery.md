# Agent delivery workflow

This is how changes are planned, built, reviewed and merged when agents do the work. It records the loop that has worked on this repository: a coordinator, an implementer and an independent reviewer per change, with a draft pull request so CI carries the heavy checks.

[`AGENTS.md`](../../AGENTS.md) still owns the product, style and naming rules. This page covers only the process.

## Roles

- **Owner.** Decides scope and priorities, and approves anything that changes a product rule. Once the owner has granted merge permission, routine merges proceed without asking again.
- **Coordinator.** The agent session the owner talks to. It plans, writes briefs, starts implementers and reviewers, rules on findings, opens and merges pull requests, and keeps the owner informed.
  - It does not implement large changes itself.
  - It fixes small review findings itself, such as wording or a one-line guard, rather than starting another agent.
- **Implementer.** One per change, working in its own worktree. It builds, tests and commits locally, then reports.
  - It fixes later review findings for the same change, so the context stays in one place.
  - It may start the next change on the same topic afterwards.
- **Reviewer.** Independent of the implementer: a different model, preferably from a different provider. Read-only.
  - A fresh reviewer is started for each round, with a brief that names the earlier findings.
- **Planners.** For a design decision or a large plan, two independent planners from different providers get the same brief. The coordinator merges their answers and records where they differed and why one view was chosen.

### Current defaults

| Role | Model and setting |
|---|---|
| Implementer | Claude Opus 5.5, effort `xhigh` |
| Reviewer | Codex `gpt-6.1-sol`, reasoning effort `xhigh` |
| Planners | Both of the above, with the same brief |

If a default model is unavailable, pause and ask the owner. Never substitute another model silently.

### In T3 Code

- Start implementers and reviewers with `delegate_task`:
  - implementers with role `implementation` and `isolation: "worktree"`;
  - reviewers with role `review`.
- Send a finding to the implementer that built the change with `t3_thread_send` to its thread, rather than starting a new agent.
- Don't poll a running agent; its completion wakes the coordinator.

## The loop for one change

1. **Plan.** The change has a row in the current plan, with a branch name, a title and its dependencies. One coherent change per pull request.
2. **Brief.** The coordinator writes the implementation brief (see [Briefs](#briefs)) in a scratch folder outside every checkout. Briefs, review files and PR body drafts are not committed.
3. **Implement.** The implementer:
   - creates `<type>/<topic>` from `origin/main`;
   - bumps the version once;
   - writes tests with the code;
   - runs the cheapest reliable checks;
   - goes through the [self-check](#self-check-before-reporting);
   - commits locally, writes the PR body draft, and reports.
4. **Draft pull request.** The coordinator pushes and opens the pull request **as a draft**, so CI runs the full unit suite, every browser journey and the release checks on hosted runners while the review runs. Pushing a draft before the review is allowed; marking it ready and merging are not.
5. **Review.** The coordinator writes a review brief and starts a reviewer. The reviewer reports **every** finding in the first round, blocking or not, with file:line, a concrete failure scenario and a suggested fix.
6. **Rule and fix.** The coordinator rules on disputed findings and sends the rest to the implementer.
   - Small findings the coordinator fixes itself.
   - A non-blocking finding that would need a large change becomes a listed follow-up, not another round.
   - When the implementer commits fixes, it reports the SHA at once. The coordinator starts the next review round in parallel with the implementer's remaining checks.
   - Later rounds re-check only the fixes and anything they touch.
7. **Ready and merge.** Merge only a commit that the review covered and CI passed.
   - The last review round must have reviewed the pull request's current head. Any commit pushed after that review must be reassessed before merging:
     - a merge with main whose own changes touch only the version: `package.json` `version`, the two top `version` fields of `package-lock.json`, and the release record's file name, `version` and `previousVersion`. The coordinator checks this with `git show --remerge-diff <merge-sha>`, which shows only what the merge itself changed beyond an automatic merge. Anything else in that output gets a narrow review;
     - a wording fix the coordinator made itself;
     - either way, the coordinator records the reassessed head SHA in the pull request before merging it;
     - anything else gets another, narrow review round.
   - When nothing blocks and CI is green on that head, mark the pull request ready and merge it, pinned to that commit (see [Pull requests and versions](#pull-requests-and-versions)).
   - Check the branch is deleted, remove the worktree, and record the result.
8. **Next in queue.** Tell the implementer of the next queued change to merge main. Then that change is renumbered if needed.

At most two implementers run heavy local work at once, because the owner's machine is shared. While one implementer waits on review, the other may run its heavy checks.

## Briefs

An implementation brief has these sections:

- **Branch and version:** the branch name, the version and the previous version, and what to merge when.
- **Rules:** the local constraints from [Local machine rules](#local-machine-rules).
- **Why:** the plan item and the user-visible goal.
- **What exists:** files to read first, and the code to reuse instead of writing a second copy.
- **Scope:** numbered parts, each concrete enough to test.
- **Guards:**
  - parity with main, and how it is shown;
  - every behaviour change, listed;
  - robustness cases;
  - mutations to apply, and which tests should catch each;
  - performance limits;
  - the specs to run.
- **Docs and release:** the public pages to update, the release record, and the PR body path and title.
- **Report:** SHAs, the design, behaviour changes, timings, mutations, checks, and the self-check list item by item.

A review brief points at the worktree, branch, HEAD and diff range. It also gives:

- the implementation brief and the PR body;
- what the implementer reports;
- numbered questions, including the earlier rounds' findings to re-check;
- the output format.

It always says the review is read-only: no commits, pushes, installs or tracked-file changes.

## Checks

| Where | What |
|---|---|
| Implementer, while working | Focused Vitest files; the affected specs one at a time |
| Implementer, before reporting | Checks in proportion to the change. For code: the build, lint, `ui:check`, `icons:check` when icons change, the release check, focused tests and the affected specs. Full Vitest when the change crosses systems or shared infrastructure; otherwise CI runs it. For docs only: the release check and the link check. The report marks any check it skipped as not applicable, and says why. |
| CI on the draft pull request | Naming, contracts and release record, all unit shards, all browser journey shards, Firefox storage and the native solver |
| Reviewer | Whatever reproduces its findings: focused tests, scratch tests and single specs |

- A behaviour claim needs evidence: a test that fails without the change, or a measurement.
- **After merging main where only version lines conflicted:** run the release check, the build and focused tests. Don't repeat full Vitest or the specs locally; CI runs them on the merged tree.

### Timing

- Time only the paths a change touches.
- Time once, at the end, on a quiet machine. Run back-to-back, alternating pairs against main's build, and report medians.
- Don't re-time after a review round unless it changed timed code, or after a merge that conflicted only on version lines.
- If the machine is busy with another checkout's work, say so in the report. Don't use numbers taken while it was busy.

## Self-check before reporting

The same kinds of finding kept recurring in reviews. Before reporting, the implementer checks each of these and says what it did:

- **Every entry point:**
  - the toolbar, the menus and right-click;
  - selection-first and tool-first order;
  - the keyboard;
  - undo and redo;
  - agent tools.

  Any path left out is listed, with the reason.
- **Preview, drag and hover vs commit.** Expensive or warning work runs only on accepted edits.
- **Cancellation and input versions.** A stale reply never applies, including late replies after a newer pick.
- **Caches.** Each cache is keyed on the accepted graph, build or document object, never on ids alone.
- **Focus.** Editors, menus and dialogs keep focus while open, and return it to their trigger or the canvas on close. Focus never falls to `body`.
- **Robustness:**
  - far from the origin;
  - tiny and huge sizes;
  - zero length;
  - coincident centres;
  - full circles;
  - redundant but consistent relations;
  - construction and projected geometry;
  - out-of-range expressions.
- **Ambiguity is reported, never guessed.**
- **Mutations.** Each risky change is applied alone, with the failing tests recorded. A surviving mutation means a test is missing or a claim is wrong.
- **Paperwork:**
  - `docs/site/cad.md` and `docs/site/agents.md` match the change;
  - WebMCP discovery stays within its byte budget (measure it when tools, their descriptions or schemas change);
  - the release record lists every behaviour change.

## Pull requests and versions

- Each pull request advances the app version once. Changes waiting in the queue hold the next numbers in merge order. When an earlier one merges, the next merges main and renumbers if needed.
- The PR body follows [`.github/pull_request_template.md`](../../.github/pull_request_template.md), isn't branded with the agent or tool that wrote it, and stays under 40,000 characters. Technical names needed to explain or validate the change are fine. GitHub refuses bodies over 65,536.
- **Merging:** auto-merge is off and main has no branch protection, so `gh pr merge --auto` merges at once.
  1. Merge with `gh pr merge <n> --merge --delete-branch --match-head-commit <sha>`, where `<sha>` is the head that was reviewed (or reassessed) and is green. A push after the check then makes the merge fail instead of slipping in.
  2. Confirm the branch is gone with `git ls-remote --heads origin <branch>`.
- **Stacked pull requests:** merge the bottom one, retarget the next to main, then delete the merged branch.

## Local machine rules

- **Dev server:** only on port 3777 (see `AGENTS.md`).
- **Playwright:** single specs only, never the full suite, because it disrupts the owner's machine. Run with `--workers=2` and `PLAYWRIGHT_USE_EXISTING_BUILD=true`, and only when port 3107 is free. Check first, and wait rather than stopping another session's server.
- **Installs:** never run `npm install` in a worktree, and never change the shared `node_modules`. Each worktree uses a link farm instead: a `node_modules` of links into the main checkout's install, with `@wire-edm/*` linked to the worktree's own `packages/`. The implementer sets it up when it starts and removes it before the worktree is deleted:
  - `node scripts/worktree-modules.mjs link` inside the worktree, then `npm run icons:build`;
  - `node scripts/worktree-modules.mjs status` lists the links;
  - `node scripts/worktree-modules.mjs unlink` before deleting the worktree. It must report 0 links left, or the deletion could follow a link into the shared install.
- **Windows with Git Bash:** call tools through `node node_modules/...`, because `npx` fails in worktrees. Python isn't available.
- **Third-party code:** never copy LGPL or FreeCAD code.
