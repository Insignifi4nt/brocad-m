# Simulate a saved UPID process

Open a path project in the [main app](https://brocad-m.visionforge.cc/), save it, then choose **Simulation** in the app header's **Editor / Simulation** switch. Finish any active editor tool first. Simulation follows the saved UPID's reviewed machining intent; it does not need a generated controller file or an installed postprocessor.

The scene fills the workspace. **Stock**, **Machine** and **Checks** open a focused panel; close it or press Escape to return to the scene. The information button contains the **SAVED UPID** source, saved time and assumptions. Unsaved editor changes are excluded, with a notice linking back to the editor. Save those changes before using them in simulation. An external G-code text project does not provide this UPID simulation. If the saved job has incomplete machining intent, use **Review in editor**, resolve the listed diagnostics and save again. Use **Simulation operation** to jump to an operation from the saved process.

## Set up the viewing scenario

Open **Stock** to enter the rough material's width, depth and height in millimeters. Expand **Placement & wire** for stock origin X/Y, bottom Z, wire diameter and **Support Z**. Dimensions and wire diameter must be positive. Position values may be negative; the support plane must be at or below the stock bottom. Choose **Apply stock** to rebuild the scenario and restart its timeline. Unapplied values remain when switching setup panels.

**Released pieces** offers two assumptions:

- **Fall under gravity** moves a fully separated piece vertically downward until its bottom reaches Support Z.
- **Retained in place** keeps separated pieces at the stock's original height, representing a retention assumption you supply.

The app starts with rough stock around the drawing, a 20 mm height and a 0.25 mm wire. The support surface starts at the lower wire end, 20 mm below the stock bottom. The Stock panel accepts a support height between that lower wire end and the stock bottom. Adjust these to the scenario you want to inspect. Stock, wire, support and retention settings belong to this viewing session; they do not change the saved UPID, machine setup or controller output.

**Waste handling** defaults to **Remove between cuts**. Completed waste cutouts are assumed to be removed before the next operation, so they do not remain as obstructions during that operation. Waste from the last operation is removed after settling at program end. This is an operator-removal assumption, not a machine action or a generated program stop. Choose **Keep for interference** to inspect a process where those pieces remain. Kept parts are not automatically removed with waste.

**Show remaining stock** and **Show waste material** control visibility immediately. Waste is hidden by default. Hiding geometry does not remove it from collision checks; Waste handling controls that assumption. A removed piece cannot be restored by making waste visible: select Keep for interference and Apply stock to compare that scenario.

The preview uses constant-thickness material and sampled contour boundaries. Cut progress appears along the path; a separate piece and stock opening appear only after a closed boundary has been fully cut. Open cuts and retained bridges do not release a complete piece. Nested cutouts are tracked, but a later through-cut is not predicted when enclosing material has already fallen below the wire. These cases produce diagnostics.

Gravity is vertical, with no tilting, bouncing, fluid forces, clamps, piece stacking or rigid-body contact solver. Support Z is a simple horizontal stopping plane, independent of any imported machine geometry. Controller compensation offsets, kerf removal and spark gap are not solved; the preview displays nominal UPID paths. A contour touching the stock edge or producing intersecting sampled boundaries cannot be represented as an interior stock hole. **Checks** reports these omitted material shapes; exact wire playback remains available. Increase the rough stock margin for edge contact. Very close curved boundaries may exceed the supported sampled topology.

## Inspect the sequence

Choose **Final part** to inspect only the final kept material at its original stock height. The surrounding stock, waste, table, wire, paths and imported machine are hidden. This view includes retained islands and, for a job that only cuts holes, the remaining plate. It uses reviewed kept-side intent and completed boundaries; incomplete or ambiguous jobs display a partial-result or unavailable message instead of guessing a finished part. These are nominal surfaces without kerf or controller compensation.

Return to **Process** to resume at the same paused timeline position and camera. Final-part inspection does not fast-forward the process or change the removal scenario. Camera fit, top and front controls also work in the final-part view.

Use **Play**, **Pause**, **Restart**, or drag the timeline to inspect the wire and released material at a time. **Previous simulation event** and **Next simulation event** jump between operation starts, program stops and timeline endpoints. The scene reports cutting, positioning, wire transitions and piece settling. Leaving the Simulation tab pauses playback.

**Simulation playback speed** changes the viewing rate from 0.25× to 10×. Timeline times use assumed motion speeds and illustrative stop/rethread holds; they are not machine feeds or cycle-time estimates. Program stops are shown as timed holds rather than requiring an operator acknowledgement to continue playback.

Drag to orbit, scroll to zoom, or right-drag to pan. The camera controls provide an isometric view fitted to the stock, wire, guides and falling pieces, a top view and a front view. Fitting this process area does not fit an entire imported assembly; use **Fit machine model** for that.

## Add and align machine geometry

Open **Machine**, choose **Import STEP model** and select a `.step` or `.stp` file from this browser. The parser runs locally after loading its app assets. The file must declare its length units; supported unit declarations are converted to millimeters. Geometry retains its source origin and is not silently centered or scaled to fit the job.

| Import limit | Maximum |
| --- | --- |
| File size | 25 MiB |
| Meshes | 1,000 |
| Vertices | 1,000,000 |
| Triangles | 500,000 |
| Parsing time | 90 seconds |

Progress shows reading, parser loading, tessellation and validation. **Cancel STEP import** stops the parser. If replacement fails or is cancelled, the existing model and alignment remain. A successful replacement starts at zero translation and rotation. Simplify an assembly if its import exceeds the limits.

Expand **Align machine model**, enter X/Y/Z offsets in millimeters and rotation about Z in degrees, then choose **Apply alignment**. Rotation is about the STEP source origin and is followed by translation. Negative coordinates are supported. Offsets must be within ±10,000,000 mm and rotation within ±360,000°. **Remove machine model** removes it from the scene.

The imported model, alignment and viewing settings stay only while this job remains open. Switching between Editor and Simulation preserves them; leaving the job or reloading the page clears them. They are not included in UPID exports or workbench backups. STEP geometry does not install a machine package or configure a controller. **STEP importer licenses & source** links the local LGPL notices, Open CASCADE exception and exact upstream source.

Use **Fit machine model** to frame the assembly and stock together. **Hide machine model** temporarily removes the imported geometry from view while collision checks stay active; **Show machine model** restores it.

## Interpret observations

**Checks** lists material and imported-machine findings across the saved process. Its badge counts findings, actionable preparation diagnostics and failed or incomplete machine scans. Select a timed finding to pause and seek directly to it, including findings later in the process.

| Finding | What is checked | Limits |
| --- | --- | --- |
| Rough stock or released material | Approximate wire and guide envelopes against simulated material and openings | Sampled geometry and the selected support/retention assumptions; no physical contact response. |
| Imported machine surface | A zero-radius vertical wire and its straight-motion sweep against STEP triangle surfaces | No finite wire thickness, guide clearance, solid containment or released-piece collision against the assembly. |
| Curved-path machine envelope | Chord sweeps expanded by the arc's maximum deviation | Conservative possible-contact warnings; their position and time are approximate. |

Read **Assumptions & limitations** under the information button and **Machine scan limits** under Checks. A scan that reaches a geometry, sample or warning limit reports incomplete coverage. No findings is not evidence of verified machine clearance: missing STEP surfaces, omitted fixtures and these approximations remain relevant. The simulation does not certify machine fit, cut quality or controller output.

Process preparation and machine checking run in background workers, each with a 60-second limit. Changing the source or scenario cancels outdated work. If preparation times out, simplify the active geometry and try again. If machine checking times out, the page reports incomplete coverage; it cannot recover partial contacts from the stopped worker.

## Rendering and preview images

The scene uses WebGPU where available and can fall back to WebGL2. If neither renderer can start, the page shows **3D preview unavailable** with **Retry renderer**. The editor remains available.

A compatible agent can call `edm_capture_preview` for the active view. A Simulation capture contains actual rendered scene pixels from the saved project, including the current camera, scenario and imported model. An Editor capture contains the current 2D draft view. The receipt identifies `contentSource` as `saved-project` or `editor-draft`, along with the draft version, dirty status, dimensions and image hash. Dirty status describes the editor even when the captured simulation excludes those edits.

Captures are bounded to 1600 pixels per dimension and 1 MiB. Open the notification bell and select **Agent** to find **Preview PNG** after capture, or request a download through the tool. The local image URL is temporary; save the image before leaving the page or replacing the capture. Capture does not save scenario settings or prove which settings were used later. See [Agent tools](agents.md#capture-the-current-preview) for exact arguments, result handling and provenance limits.
