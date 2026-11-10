# App versions and package compatibility

The app version appears in Settings, the export dialog and the Package workbench. A package's `manifest.authoredFor.appVersion` records the release used when writing it. Its `documentationUrl` points to that release's authoring contract.

Check the **current release** link in the navigation for compatibility changes and the versioned documentation link. The [release records](https://brocad-m.visionforge.cc/documentation/releases.json) are also available as JSON.

## Before updating a package

1. Compare its authoring target with the app release you will use.
2. Read the relevant compatibility changes. Nearby version numbers do not prove compatibility.
3. Use **Inspect package** in the [Package workbench](tools.md) to validate the archive with the current app.
4. If changes are needed, publish a new post version and exact setup reference; preserve the original package.

Packages without an authoring version have unknown provenance. They may still work; current validation and their exact capabilities determine what they can generate.

An app update does not replace packages already installed in a user's browser. Install and activate a new machine setup explicitly when an update is required.
