# Cristian's Robofil 100 V2 candidate machine package

This machine-specific regression fixture is retained for installation, controller-output and browser tests. It is not a default package or a template for other machines. Its identities, evidence, hashes and golden output must remain intact when reorganizing tests. For a new user's machine, start with the hosted [package authoring guide](https://brocad-m.visionforge.cc/documentation/authoring/).

The human-installable artifact is `cristian-robofil-100-v2.wireedm-package`. In Workbench Settings, open **Machines & setups**, choose **Install machine package**, review the detected machine and post, then confirm the installation. Do not install the loose machine or post JSON files separately; they are reproducible authoring inputs.

The package includes:

- the complete physical definition for Cristian's Charmilles Robofil 100, including evidenced 150 mm X and 200 mm Y travel;
- the exact `cristian.robofil-100.v2-candidate@2.6.0` post;
- the `Robofil V2 candidate 2.6.0` setup with `coordinatePrecision: 3` and `offsetIndex: 0`;
- all machine and controller evidence plus the post's exact fixtures;
- post-owned `.iso`, CRLF, ASCII, final-newline, leading `%`, and sequential `N10` block-numbering rules.

Package version 2.3.0 adds the operator-reported cut-on-rapid/manual-rethread route. The workbench checks the straight route against finished-part solid regions, including holes and islands, before allowing a continuous transition. Finished DXF contours do not describe the stock outside the part or fixtures. Existing installations and saved revisions are not rewritten. The new sequence remains a candidate for controller graphics and a supervised dry run; M00 and physical wire separation have not been verified by a known-good program.

Package version 2.4.0 retains modal compensation across clear rapid moves and manual rethreading. It emits no offset commands when the next contour uses the same side, or emits the new `G41`/`G42` and `G38 D0` for a side change. The adjacent [Charmilles CT-Millennium programming manual](https://www.scribd.com/document/459168666/FIX40-cc-SL-program-vH-en-pdf) documents `G40`/`G41`/`G42` as mutually replacing modal commands. Its behavior is evidence for the candidate, not proof of this exact Robofil 100 firmware. The [Robofil 190/290P/310P/510P manual](https://pdfcoffee.com/robofil-190-290p-310p-510p-part-2-3-pdf-free.html) and the local historical multi-contour program also support retaining offset state across contour travel; neither verifies this exact mixed-side sequence.

Package version 2.6.0 adds app 0.0.686 authoring provenance and a versioned documentation link. Controller source, dialect, output rules and golden fixtures are unchanged from 2.5.0. The new metadata requires an app that understands `manifest.authoredFor`; keep using 2.5.0 until app 0.0.686 is deployed.

Package version 2.5.0 declares only the separation mechanism its source handles: automatic separation during positioning, followed by manual rethreading. Manual separation before positioning remains unsupported; host preflight now reports that limitation before posting.

The post emits `G92` for program setup. Compensation starts with `G41` or `G42`, followed by `G38 D0`, and finishes with `G40`, `G39`, then final `M02`. Same-side contours may share one compensation lifecycle through a continuous `G0` only if the route does not cross known finished material. For manual rethread, the post emits the separating `G0` and `M00` at the destination, then changes the side only when needed. Manual threading inserts this M00 automatically; adding a user-authored stop at the same point would insert another M00. Manual separation before positioning and automatic threading remain unsupported.

For direct contour entry and exit, leave transition geometry absent or use the reviewed no-entry and no-exit choices. The package emits no geometric lead in that case. Generated programs remain candidates for controller graphics, simulation, and a supervised dry run; the setup is deliberately `unverified`.

The [2026-09-22 compatibility assessment](../../../../docs/maintainers/2026-09-22-robofil-assessment.md) confirms that the simulation and UPID correctness work requires no package upgrade. Simulation waste removal is an assumed operator action and emits no controller stop. A distinct repositioning move using manual threading with an already-separated wire is also unsupported by this candidate: its runtime guard rejects the move while compensation is active, even though generic capability preflight accepts that precondition.

To reproduce the package:

```text
npm run post:conformance -- tests/fixtures/machine-packages/robofil-100-v2/cristian-robofil-100-v2.wireedm-post.json
npm run machine-package:validate-source -- tests/fixtures/machine-packages/robofil-100-v2
npm run machine-package:build -- tests/fixtures/machine-packages/robofil-100-v2 tests/fixtures/machine-packages/robofil-100-v2/cristian-robofil-100-v2.wireedm-package
npm run machine-package:validate -- tests/fixtures/machine-packages/robofil-100-v2/cristian-robofil-100-v2.wireedm-package
npm run machine-package:inspect -- tests/fixtures/machine-packages/robofil-100-v2/cristian-robofil-100-v2.wireedm-package
```

`no-lead-rectangle.dxf` is a 10 × 10 mm closed-contour browser fixture. Import it as millimeters, set finished-contour geometry and controller compensation, and leave entry and exit geometry absent to exercise the direct no-lead flow.
