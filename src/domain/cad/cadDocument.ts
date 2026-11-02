import type { CadEdgeSelection, CadFaceQuery } from './cadTopology';
import type { CadSolidImportSource } from './cadImports';
import type { CadDxfImportSource } from './cadDxfSource';
import type { CadPluginProfile } from './plugins/cadPlugins';
import type { CadParameterGroup, CadParameterMetadata } from './cadParameters';
import type { CadSketchDimensionConstraint } from './cadSketchConstraints';
import type { CadSketchRegionSelection } from './cadSketchRegionSelection';
import type { CadSketchGraph } from './cadSketchGraph';
import type { CadBodyIssue, CadBodyKey, CadBodyState } from './cadBodies';

/** Millimetres and degrees. Strings are arithmetic expressions over named parameters. */
export type CadScalar = number | string;
export type CadPoint2 = readonly [CadScalar, CadScalar];
export type CadPoint3 = readonly [CadScalar, CadScalar, CadScalar];
export type CadPlane = 'XY' | 'XZ' | 'YZ';
export type CadSketchPlane = CadPlane | { readonly kind: 'datum-plane'; readonly featureId: string };
export type CadPathSegment =
  | { readonly kind: 'line'; readonly start: CadPoint2; readonly end: CadPoint2 }
  | { readonly kind: 'arc'; readonly center: CadPoint2; readonly radius: CadScalar; readonly startAngle: CadScalar; readonly sweep: CadScalar };

export type CadProfile =
  | CadPluginProfile
  | { readonly kind: 'rectangle'; readonly x: CadScalar; readonly y: CadScalar; readonly width: CadScalar; readonly height: CadScalar; readonly cornerRadius: CadScalar }
  | { readonly kind: 'circle'; readonly x: CadScalar; readonly y: CadScalar; readonly radius: CadScalar }
  | { readonly kind: 'polygon'; readonly points: readonly CadPoint2[] }
  | { readonly kind: 'path'; readonly segments: readonly CadPathSegment[] }
  | { readonly kind: 'slot'; readonly x: CadScalar; readonly y: CadScalar; readonly length: CadScalar; readonly width: CadScalar; readonly angle: CadScalar };

export interface CadSketchProfile {
  readonly id: string;
  readonly name: string;
  readonly construction: boolean;
  /** Legacy save constraint only. New contours omit this; material regions derive from nesting. */
  readonly role?: 'outer' | 'hole';
  readonly geometry: CadProfile;
  /** Explicit dimensions are opt-in. Existing construction scalars and saved expressions remain authoritative. */
  readonly constraints?: readonly CadSketchDimensionConstraint[];
}
export interface CadFeatureBase { readonly id: string; readonly name: string; readonly suppressed: boolean }
export interface CadDatumPlaneFeature extends CadFeatureBase {
  readonly kind: 'datum-plane';
  readonly definition: { readonly kind: 'world'; readonly basePlane: CadPlane; readonly origin: CadPoint3; readonly rotation: CadPoint3 };
}
export interface CadSketchFeature extends CadFeatureBase {
  readonly kind: 'sketch'; readonly plane: CadSketchPlane; readonly offset: CadScalar; readonly profiles: readonly CadSketchProfile[];
  /** Original import lineage remains exact even after editable geometry changes. */
  readonly source?: CadDxfImportSource;
  /** Schema 2 source for stable open/closed entities. Legacy profiles remain separate owners. */
  readonly graph?: CadSketchGraph;
}
/** Ordered open reference geometry. It produces no material or solid body. */
export interface CadCurveFeature extends CadFeatureBase {
  readonly kind: 'curve'; readonly plane: CadSketchPlane; readonly offset: CadScalar;
  readonly segments: readonly CadPathSegment[];
  readonly source?: CadDxfImportSource;
}
export interface CadSweepFeature extends CadFeatureBase {
  readonly kind: 'sweep'; readonly sketchId: string; readonly curveId: string;
  readonly operation: 'new' | 'join' | 'cut'; readonly targetId: string | null;
}
export interface CadPocketFeature extends CadFeatureBase {
  readonly kind: 'pocket'; readonly sketchId: string; readonly targetId: string;
  readonly regionSelection?: CadSketchRegionSelection;
  readonly extent: { readonly kind: 'through-all'; readonly direction: 'positive' | 'negative' | 'both' };
}
export type CadFeature = CadDatumPlaneFeature | CadSketchFeature | CadCurveFeature | CadSweepFeature | CadPocketFeature
  | (CadFeatureBase & { readonly kind: 'imported'; readonly source: CadSolidImportSource })
  | (CadFeatureBase & { readonly kind: 'extrude'; readonly sketchId: string; readonly distance: CadScalar; readonly symmetric: boolean; readonly operation: 'new' | 'join' | 'cut'; readonly targetId: string | null; readonly regionSelection?: CadSketchRegionSelection })
  | (CadFeatureBase & { readonly kind: 'revolve'; readonly sketchId: string; readonly angle: CadScalar; readonly axis: 'x' | 'y'; readonly operation: 'new' | 'join' | 'cut'; readonly targetId: string | null })
  | (CadFeatureBase & { readonly kind: 'loft'; readonly sketchIds: readonly string[]; readonly ruled: boolean; readonly operation: 'new' | 'join' | 'cut'; readonly targetId: string | null })
  | (CadFeatureBase & { readonly kind: 'fillet' | 'chamfer'; readonly targetId: string; readonly radius: CadScalar; readonly selection?: CadEdgeSelection | null;
    /** Explicitly allow native tangent continuation from selected seed edges. Absent means strict selection. */
    readonly tangentPropagation?: boolean })
  | (CadFeatureBase & { readonly kind: 'shell'; readonly targetId: string; readonly thickness: CadScalar; readonly opening: CadFaceQuery })
  | (CadFeatureBase & { readonly kind: 'boolean'; readonly targetId: string; readonly toolId: string; readonly operation: 'union' | 'cut' | 'intersect' })
  | (CadFeatureBase & { readonly kind: 'transform'; readonly sourceId: string; readonly translation: CadPoint3; readonly rotation: CadPoint3 })
  | (CadFeatureBase & { readonly kind: 'linear-pattern'; readonly sourceId: string; readonly count: number; readonly spacing: CadPoint3 })
  | (CadFeatureBase & { readonly kind: 'circular-pattern'; readonly sourceId: string; readonly count: number; readonly axis: 'x' | 'y' | 'z'; readonly center: CadPoint3; readonly angle: CadScalar })
  | (CadFeatureBase & { readonly kind: 'mirror'; readonly sourceId: string; readonly plane: CadPlane });

export interface CadDocument {
  readonly format: 'wireedm-cad';
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly name: string;
  readonly units: 'mm';
  readonly parameters: Readonly<Record<string, number>>;
  readonly parameterGroups?: readonly CadParameterGroup[];
  readonly parameterMetadata?: Readonly<Record<string, CadParameterMetadata>>;
  readonly features: readonly CadFeature[];
}

export interface CadDiagnostic { readonly code: string; readonly message: string; readonly featureId?: string }
export interface CadMeshTopologyGroup { readonly start: number; readonly count: number; readonly key: string }
export interface CadMesh {
  readonly featureId: string; readonly name: string;
  /** The key of the body drawn (`cadBodies.ts`), which stays the same while features modify it; absent in older build DTOs. */
  readonly bodyKey?: CadBodyKey;
  readonly positions: readonly number[]; readonly normals: readonly number[]; readonly indices: readonly number[];
  readonly edges: readonly number[];
  readonly faceGroups: readonly CadMeshTopologyGroup[]; readonly edgeGroups: readonly CadMeshTopologyGroup[];
  readonly volume: number;
  /** Native solid components in this validated body; absent in older build DTOs. */
  readonly solidCount?: number;
  /**
   * For each of `faceGroups`, the native solid of this body its face bounds, numbered from 0 below `solidCount`. Given for a body of
   * more than one solid whose faces each bound one solid; absent otherwise and in older build DTOs.
   */
  readonly faceSolids?: readonly number[];
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
}
export interface CadBuildResult {
  readonly buildId: string;
  readonly meshes: readonly CadMesh[];
  readonly diagnostics: readonly CadDiagnostic[];
  /** The identity of each current body, in mesh order: key, kind, creator, modifiers and pieces; absent in older build DTOs. */
  readonly bodies?: readonly CadBodyState[];
  /** Body parts the rebuild could not tell apart, lost or stopped tracking, feature by feature; absent in older build DTOs. */
  readonly bodyIssues?: readonly CadBodyIssue[];
  readonly durationMs: number;
}
