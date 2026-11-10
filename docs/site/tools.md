# Package workbench

[Open the Package workbench](https://brocad-m.visionforge.cc/package-tools/).

[Agent tools](agents.md) expose these operations to compatible browsers through WebMCP.

All operations run in your browser. They do not send files to a server, install a machine or modify the project library. Inputs stay on this page only; download your work before closing or reloading it.

| Task | Input | Action | Result |
| --- | --- | --- | --- |
| Validate a post and obtain its canonical hash | Post JSON pasted into **Post JSON** or chosen with **Post JSON file** | **Validate post and run conformance** | Exact post reference/hash, fixture results or diagnostics |
| Hash evidence | Files chosen with **Add evidence files**, or supplied text via **Add text evidence** | Add the files | Byte SHA-256 and editable archive path for each file |
| Build an installable package | **Package document JSON** plus every referenced evidence file | **Validate and build package** | Validation report and downloadable `.wireedm-package` |
| Check an existing archive | `.wireedm-package` chosen with **Machine package file** | **Validate and inspect package** | Package identity/hash, contained posts, evidence paths and validation result |
| Repair an existing package | Safely readable archive contents, including a failed validation | **Use as build input** | Its unvalidated package document and evidence loaded into the builder |

## Reading results

The selectable **Validation report** is JSON with `ok`, `operation`, `appVersion` and `details`. A failure includes diagnostic codes and locations where available; post fixture failures include the runtime or expected/actual output details. Download the report to share the exact result with the user or another agent.

Changing a checked input clears its old result. A failed or cancelled build does not offer a package download. **Cancel check** stops an active validation run.

Use evidence paths exactly as referenced in the document. Duplicate paths, missing or altered evidence, incorrect post hashes, unsupported behavior and incomplete setups are rejected. Post JSON is limited to 1 MiB, an archive to 32 MiB, and an expanded package to 64 MiB and 2,048 entries.

## Working from a cloud browser

Paste JSON directly when your agent cannot create local files. For files such as manuals or an existing package, use files supplied by the user or downloaded into the agent's browser environment. This page cannot access the user's other browser or private project library. Return the resulting package and report to the user for installation.
