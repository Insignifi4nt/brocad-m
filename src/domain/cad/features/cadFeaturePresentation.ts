import { Type } from '@sinclair/typebox';
import { CadIdentifierSchema, CadScalarSchema } from '../cadPrimitives';
import { CadSketchDimensionAnnotationSchema } from '../cadSketchGraph';
import { CAD_SKETCH_ELEMENT_ID_PATTERN } from '../sketch-relations/cadSketchVirtualElements';
import type { CadAnyFeaturePresentation, CadFeatureForm, CadFeatureFormComponent, CadFeatureKind, CadFeaturePresentation, CadFeaturePresentations } from './cadFeatureDefinitionTypes';
import { CadProfileSchema, CadSketchFeatureSchema, CadSketchProfileSchema } from './kinds/references';

// What each kind shows people and agents: its form and its agent description. The definitions in `kinds/` hold what the kernel and the
// parser read; only the feature editor, the agent tools and the docs read these, so the kernel worker never loads their text.

const strict = { additionalProperties: false };
const pascal = (kind: string) => kind.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join('');
const xyz = (label: (axis: string) => CadFeatureFormComponent) =>
  [label('X'), label('Y'), label('Z')] as const satisfies readonly [CadFeatureFormComponent, CadFeatureFormComponent, CadFeatureFormComponent];
const edgeTreatmentForm = (title: string, size: string): CadFeatureForm<'targetId' | 'radius'> => ({ editor: 'fields', title, controls: [
  { control: 'body', field: 'targetId', label: 'Body' },
  { control: 'part', part: 'edge-scope' },
  { control: 'part', part: 'topology-picker' },
  { control: 'scalar', field: 'radius', label: size },
  { control: 'part', part: 'tangent-chain' }] });

// Reference geometry.

const datumPlane = {
  form: { editor: 'bespoke', title: 'Plane' },
  agent: { exposed: true, description: 'An independent world reference plane. definition.kind=world uses basePlane XY/XZ/YZ, world origin in mm and rotation in degrees around world X then Y then Z. Rotation turns its basis without rotating its origin. All coordinates accept parameter expressions. Sketch/Curve plane may reference this preceding active feature with {kind:datum-plane,featureId}; offset remains along its normal. No body, material or CAM role. cad_inspect_plane resolves the frame without loading the solid engine. Datum Pad/Revolve/Loft/Sweep require conservative placement precision. Loft sections must share oriented axes and normal; use cad_inspect_loft before adding one. Sweep preserves authored section and rail frames; its section normal must align with the first rail tangent. Datum Through-all Pocket is not yet supported and is rejected before editing.' }
} satisfies CadFeaturePresentation<'datum-plane'>;

const sketch = {
  form: { editor: 'bespoke', title: 'Sketch' },
  agent: { exposed: true, description: 'Plane-local legacy closed profiles and optional schema-2 graph of stable open/closed line, arc and circle entities on XY/XZ/YZ or a preceding active datum-plane, with optional construction geometry. Offset follows the resolved plane normal; changing placement preserves local coordinates. Nesting automatically determines material, voids and islands. Dimensions accept finite arithmetic over document parameters. Use cad_inspect_plane for world placement.',
    // Saved legacy contour roles remain parseable, but new contours use nesting.
    authoringSchema: Type.Object({ ...CadSketchFeatureSchema.properties, profiles: Type.Array(Type.Omit(CadSketchProfileSchema, ['role'])) }, strict),
    // A sketch definition repeats its scalar, identifier, element reference and dimension placement schemas dozens of times, and its profiles and generators
    // share each profile geometry.
    sharedDefinitions: {
      CadScalar: CadScalarSchema, CadIdentifier: CadIdentifierSchema, CadSketchElementId: Type.String({ pattern: CAD_SKETCH_ELEMENT_ID_PATTERN }),
      ...Object.fromEntries(CadProfileSchema.anyOf.map(variant => [`CadProfile${pascal(variant.properties.kind.const)}`, variant])),
      ...Object.fromEntries(CadSketchDimensionAnnotationSchema.anyOf.map(variant => [`CadSketch${pascal(variant.properties.kind.const)}Annotation`, variant]))
    } }
} satisfies CadFeaturePresentation<'sketch'>;

const curve = {
  form: { editor: 'bespoke', title: 'Curve' },
  agent: { exposed: true, description: 'An ordered open reference chain of exact lines and circular arcs on XY, XZ, YZ or a preceding active datum-plane at a signed normal offset. Dimensions accept parameter expressions. Segments must connect within modeling precision without closing, crossing, touching nonadjacent segments or overlapping. Sharp corners are allowed. Curves are independent references, never solid bodies or closed material profiles. Retains original DXF source when imported; exact open DXF export preserves traversal in local millimeters.' }
} satisfies CadFeaturePresentation<'curve'>;


// Solids.

const imported = {
  form: { editor: 'bespoke', title: 'Imported solid' },
  agent: { exposed: true, description: 'An independent solid from an original STEP or STL file. Original source bytes are preserved in the document. STEP retains exact BRep; STL is faceted and requires explicit mm/inch source units. Native validation rejects open or invalid solids.' }
} satisfies CadFeaturePresentation<'imported'>;

const extrude = {
  form: { editor: 'bespoke', title: 'Pad / pocket' },
  agent: { exposed: true, description: 'Pad the preceding sketch, symmetrically if requested. New creates a body; join/cut consumes and replaces targetId. Absent regionSelection keeps whole-sketch automatic holes. Explicit regionSelection accepts the unchanged nonempty contour-reference array, or a graph-cells envelope packed from inspected cellIds. Contour references retain exact boundaryProfileId, sorted immediate voidProfileIds and complete ordered ancestorProfileIds. Graph cells require schema 2 and deliberate selection; exact source/event witnesses reject topology changes. Neighboring selected cells cancel their shared contour. Changed/missing topology rejects; never infer references from profile names, array indices or points.' }
} satisfies CadFeaturePresentation<'extrude'>;

const pocket = {
  form: { editor: 'bespoke', title: 'Pocket' },
  agent: { exposed: true, description: 'Cut the whole sketch automatic material regions, or explicit bounded regionSelection cells, through a current target body. Obtain complete cell references from cad_inspect_sketch_regions; changed/missing topology rejects instead of substituting another area. extent.kind is through-all; direction positive follows the sketch normal (XY +Z, XZ -Y, YZ +X) from its authored plane, negative follows the opposite side, and both spans the complete target independent of sketch offset. Recomputes finite caps from exact target bounds on each build. Replaces targetId and retains the sketch. No distance, symmetric or operation fields. Rejects no material, complete erasure, uncertain native precision and required spans above one million mm; build and inspect diagnostics before export or CAM handoff.' }
} satisfies CadFeaturePresentation<'pocket'>;

const revolve = {
  form: { editor: 'fields', title: 'Revolve', controls: [
    { control: 'part', part: 'sketch-source' },
    { control: 'scalar', field: 'angle', label: 'Angle', unit: 'deg' },
    { control: 'choice', field: 'axis', label: 'Sketch axis' },
    { control: 'operation', field: 'operation', label: 'Operation', target: 'targetId', targetLabel: 'Target body' }] },
  agent: { exposed: true, description: 'Revolve the preceding sketch around its local x or y axis by degrees. New creates a body; join/cut replaces targetId.' }
} satisfies CadFeaturePresentation<'revolve'>;

const loft = {
  form: { editor: 'fields', title: 'Loft', controls: [
    { control: 'part', part: 'loft-sections' },
    { control: 'choice', field: 'ruled', label: 'Transition' },
    { control: 'operation', field: 'operation', label: 'Operation', target: 'targetId', targetLabel: 'Target body' }] },
  agent: { exposed: true, description: 'Build a solid through 2–16 unique sketchIds in their supplied order. Each active sketch must have one closed material boundary without holes; construction geometry is ignored. All sections share oriented local axes and normal, on a principal plane or compatible datum planes. Effective normal stations must increase or decrease strictly beyond modeling precision; authored origin translations and in-plane shifts are preserved. Call cad_inspect_loft before adding the feature. No sorting or dropped contours. ruled=true connects consecutive sections directly; false uses fitted native smooth surfaces. New creates a body; join/cut replaces targetId while retaining sketches. Invalid solids and end-plane overshoot fail. STEP preserves the resulting BRep; some section curves cannot transfer to analytic-only CAM.' }
} satisfies CadFeaturePresentation<'loft'>;

const sweep = {
  form: { editor: 'fields', title: 'Sweep', controls: [
    { control: 'part', part: 'sweep-sources' },
    { control: 'operation', field: 'operation', label: 'Operation', target: 'targetId', targetLabel: 'Target body' }] },
  agent: { exposed: true, description: 'Transport one preceding sketch along one preceding open Curve with fixed planar binormal, using exact extrusions and signed revolutions. Principal or datum sources must preserve their actual world placement. The sketch must contain one active closed material boundary without holes and lie at the actual curve start, perpendicular to its first tangent. Section roll and parallel or antiparallel normal orientation are retained. Preserves authored position, orientation and traversal; no automatic relocation or reversal. Curve joints require matching tangent directions. Conservative enclosing-radius, global clearance and precision checks may reject otherwise valid sections. Supports up to 64 curve segments and section edges × curve segments <= 2048. Call cad_inspect_sweep before adding the feature; then build and inspect diagnostics. New creates one body; join/cut replaces targetId while retaining both references.' }
} satisfies CadFeaturePresentation<'sweep'>;


// Dress-ups.

const fillet = {
  form: edgeTreatmentForm('Fillet', 'Radius'),
  agent: { exposed: true, description: 'Round current target edges. Absent/null selection means all edges; supplied geometric queries must match their exact expected counts. Selected seeds continue through native tangent chains only with tangentPropagation=true; absent/false requires the complete chain selected explicitly. Replaces targetId; invalid radii report a build diagnostic.' }
} satisfies CadFeaturePresentation<'fillet'>;

const chamfer = {
  form: edgeTreatmentForm('Chamfer', 'Distance'),
  agent: { exposed: true, description: 'Chamfer current target edges. The radius field is the distance in mm. Optional geometric selection must match exact counts; absent/null retains all-edge semantics. Selected seeds continue through native tangent chains only with tangentPropagation=true; absent/false requires the complete chain selected explicitly.' }
} satisfies CadFeaturePresentation<'chamfer'>;

const shell = {
  form: { editor: 'fields', title: 'Shell', controls: [
    { control: 'body', field: 'targetId', label: 'Body' },
    { control: 'part', part: 'topology-picker' },
    { control: 'scalar', field: 'thickness', label: 'Wall thickness' },
    { control: 'part', part: 'opening-summary' }] },
  agent: { exposed: true, description: 'Hollow a current solid inward by positive thickness in mm, opening exactly one planar face selected by geometric predicates. Ambiguous selections and invalid walls fail explicitly.' }
} satisfies CadFeaturePresentation<'shell'>;


// Body operations.

const boolean = {
  form: { editor: 'fields', title: 'Boolean', controls: [
    { control: 'body', field: 'targetId', label: 'Target body' },
    { control: 'body', field: 'toolId', label: 'Tool body' },
    { control: 'choice', field: 'operation', label: 'Operation' }] },
  agent: { exposed: true, description: 'Union/cut/intersect current target and tool bodies. Both inputs are consumed and replaced by this feature.' }
} satisfies CadFeaturePresentation<'boolean'>;

const transform = {
  form: { editor: 'fields', title: 'Move / rotate', controls: [
    { control: 'body', field: 'sourceId', label: 'Body' },
    { control: 'vector', field: 'translation', label: 'Translation', unit: 'mm', components: xyz(axis => ({ label: axis, inputLabel: `Translation ${axis}` })) },
    { control: 'vector', field: 'rotation', label: 'Rotation about world origin', unit: 'deg', components: xyz(axis => ({ label: `Around ${axis}`, unit: 'deg' })) }] },
  agent: { exposed: true, description: 'Translate in mm and rotate in degrees about global axes. Replaces its current source body.' }
} satisfies CadFeaturePresentation<'transform'>;

const linearPattern = {
  form: { editor: 'fields', title: 'Linear pattern', controls: [
    { control: 'body', field: 'sourceId', label: 'Body' },
    { control: 'count', field: 'count', label: 'Instances, including original' },
    { control: 'vector', field: 'spacing', label: 'Spacing between instances', unit: 'mm', components: xyz(axis => ({ label: axis, inputLabel: `Spacing ${axis}` })) }] },
  agent: { exposed: true, description: 'Fuse the original current source and translated copies, retaining disconnected solids where copies do not touch. Count includes the original; spacing is the XYZ translation between instances in mm. Replaces sourceId.' }
} satisfies CadFeaturePresentation<'linear-pattern'>;

const circularPattern = {
  form: { editor: 'fields', title: 'Circular pattern', controls: [
    { control: 'body', field: 'sourceId', label: 'Body' },
    { control: 'count', field: 'count', label: 'Instances, including original' },
    { control: 'choice', field: 'axis', label: 'Axis' },
    { control: 'scalar', field: 'angle', label: 'Angular extent', unit: 'deg' },
    { control: 'vector', field: 'center', label: 'Axis center', unit: 'mm', components: xyz(axis => ({ label: `Center ${axis}` })) }] },
  agent: { exposed: true, description: 'Fuse the original current source and rotated copies, retaining disconnected solids where copies do not touch. Count includes the original (2–100). Rotate about the positive world x/y/z axis through center in mm, following the right-hand rule. angle is the signed total angular extent in degrees, greater than 0.0000001 in magnitude and at most 360. Exactly ±360 distributes count instances without a duplicate endpoint; partial extents include both endpoints. Center and angle accept parameter expressions. Replaces sourceId; combined expanded pattern instances are limited to 1000.' }
} satisfies CadFeaturePresentation<'circular-pattern'>;

const mirror = {
  form: { editor: 'fields', title: 'Mirror', controls: [
    { control: 'body', field: 'sourceId', label: 'Body' },
    { control: 'choice', field: 'plane', label: 'Mirror plane through origin' }] },
  agent: { exposed: true, description: 'Mirror the current source across a global reference plane, preserving the original source as a separate body.' }
} satisfies CadFeaturePresentation<'mirror'>;
/** Every kind's presentation, in catalog order. A kind without one fails to compile. */
export const CAD_FEATURE_PRESENTATION = Object.freeze({
  'datum-plane': datumPlane, curve, sketch,
  imported, extrude, pocket, revolve, loft, sweep,
  fillet, chamfer, shell,
  boolean, transform, 'linear-pattern': linearPattern, 'circular-pattern': circularPattern, mirror
} satisfies CadFeaturePresentations);

/** The form and agent exposure of `kind`. */
export function cadFeaturePresentation(kind: CadFeatureKind): CadAnyFeaturePresentation {
  return (CAD_FEATURE_PRESENTATION as CadFeaturePresentations)[kind];
}
