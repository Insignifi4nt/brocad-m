# CAD feature kinds

Every CAD feature kind is declared once, in `src/domain/cad/features/kinds/`, and registered in `cadFeatureRegistry.ts`. Consumers read
features through the definition rather than switching on kinds. What a kind shows people and agents is kept apart, in
`cadFeaturePresentation.ts`, so the kernel worker never loads its text. The definition owns:

| Declaration | Read by |
| --- | --- |
| `schema`, `fields` | The document schema (`cadFeatureSchemaUnion`), agent schemas and this page. |
| Slots (`cadFeatureReference`, `cadFeatureOptionalReference`) | Reference checks while parsing, and dependencies (`cadFeatureInputs`, `cadFeatureDependencies`). |
| Scalars (`cadFeatureScalarField`, `cadFeatureVectorField`) | Range checks while parsing, parameter traversals (`mapCadFeatureScalars`) and kernel limits (`cadFeatureScalar`). |
| `quantities` of a field holding nested values | What each number inside it measures, by path (`cadFeatureQuantityAt`). |
| `choices`, `condition` | Choice values in forms, and conditional fields such as a target that only exists for join and cut. |
| `outputs`, `body`, `occurrence`, `suppression` | Which features may feed a slot, which body a feature creates, keeps or consumes ([body identity](#body-identity)) and what an inactive feature leaves. |
| `evaluator` | Where the feature is evaluated and the version of that evaluation, for the rebuild cache. |
| `diagnostics` | Every code the kind's own checks and evaluation raise, apart from the steps all kinds share (`CAD_FEATURE_SHARED_DIAGNOSTICS`). |
| `check`, `instances` | Checks beyond the schema while parsing, and the solid count a feature makes. |

Its presentation, one entry per kind in `CAD_FEATURE_PRESENTATION`, owns:

| Declaration | Read by |
| --- | --- |
| `form` | The feature editor: a generic form from its controls, or the kind's own editor. |
| `agent` | Whether agent tools may name the kind, its description and its authoring schema. |

## Adding a kind

1. Add the stored type to the `CadFeature` union in `src/domain/cad/cadDocument.ts`.
2. Declare it in its family's module under `src/domain/cad/features/kinds/`. Build the shape with `cadFeatureShape` and the field helpers in
   `cadFeatureFields.ts`, and end the object with `satisfies CadFeatureDefinition<'your-kind'>`. Give every id-holding field a slot and
   every dimension a scalar; declare a field only when something reads it. A field holding nested numbers declares what each measures in
   `quantities`.
3. Register it in `catalog()` in `cadFeatureRegistry.ts`. The type check fails until every kind is registered with a matching shape. Add
   its schema to the end of `cadFeatureSchemaUnion`: the union order fixes the published document and edit schema hashes.
4. Evaluate it in the kernel (`src/features/cad/kernel/cadKernelModel.ts`), or in the domain for a reference kind.
5. Give it a form in `CAD_FEATURE_PRESENTATION` (`cadFeaturePresentation.ts`); the type check fails until every kind has an entry. A
   list of `controls` is drawn by the shared editor; a kind that needs more declares `editor: 'bespoke'` and adds its case to
   `CadFeatureEditor.tsx`.
6. Decide its agent exposure, in the same entry. Initial agent discovery must stay within 51,200 UTF-8 bytes (`cadAgentJourney.test.tsx`), so keep the
   description short. Update `docs/site/agents.md` if agents gain the kind.
7. List its `diagnostics`. `cadFeatureDiagnostics.test.ts` reads the kind's definition and its kernel case, follows the calls they
   make, and fails unless the list holds exactly the refusal codes found, less the shared ones. A code returned by a call is traced
   through the function's returns. The test also fails on a code it cannot trace to where it was written, and on a new site where it
   takes a caught error's code on trust, until that site is read and listed in the test. `cadFeatureQuantities.test.ts` fails until
   every number its schema accepts has exactly one declared quantity.
8. Regenerate the table below with `UPDATE_CAD_FEATURE_TABLE=1 npm test -- --run src/domain/cad/__tests__/cadFeatureTable.test.ts`.
   Without the variable the test fails while the table differs from the definitions.

Raise `evaluator.version` whenever the same stored feature would evaluate differently.

The kinds modules and the resolvers they call import each other, so none of them may read another while modules load: read schemas and
definitions inside functions, and build the catalog on first use. `cadFeatureModuleOrder.test.ts` loads each module of the cycle first and
fails if any of them does.

## Activity

Read whether a feature takes part in a rebuild with `cadFeatureActive(feature, scope)`. `npm run lint` refuses any other read of the stored
`suppressed` flag that names it: member and element access, destructuring by any literal key, including computed keys and destructuring
assignment, `'suppressed' in` and reflective reads. Code that means the stored value itself, such as the suppression toggle or a check
on an import result, reads it with `cadFeatureSuppressionFlag`. The check cannot see reads that never name the flag (key enumeration,
spreads, serialization) or keys built at run time; `scripts/check-feature-activity.ts` lists what it covers.

## Body identity

`src/domain/cad/cadBodies.ts` derives the bodies after each feature and keys each one by the feature that created it, so a body keeps one
key however often features change it. `createCadBodyLineage()` applies features in history order. Validation, the kernel, the workbench and
the export dialogs each derive the lineage of the history they show. The kernel adds what only geometry knows and returns the states with
every build (`CadBuildResult.bodies`, `CadMesh.bodyKey`). A kind's `body` behaviour decides the key:

| `body` | Key after the feature | What the feature's id leads to (`of`) |
| --- | --- | --- |
| `none` | – | nothing |
| `new` | the feature's id, followed by the kind's `occurrence`: a mirror's is `flip/mirror` | the new body |
| `modify-target` | the key of its target or source | that body |
| `new-or-modify` | as `modify-target` when it names a target, otherwise as `new` | the body made or modified |
| `consume-tools` | the key of its target. Each tool body is consumed and records the feature as `consumedBy` | the target body |

- A body whose solids are told apart has `pieces`: one key for each solid, in `CadMesh.faceSolids` order. A body stays whole, with no
  pieces, until one of its solids may have split, or a pattern leaves a copy apart from the originals. A solid may have split when it leaves
  several solids, or when a solid of the result keeps none of the body's faces, since that solid might be a piece of any of them. A fused
  tool keeps the body whole. A body that has pieces keeps them, even when one solid is left. A new body starts whole, and so does a mirror
  image, whatever parts its source had.
- The kernel traces each solid of a feature's result to every source solid it keeps a face of unchanged (`createCadKernelFaceSources`):
  the solids of the target, of each pattern copy and of a fused tool. A face that two solids of a source, or two sources, share is never
  traced, since which of them it would count for follows the order they are listed in. A key is inherited only when continuity is
  certain. Anything else gets a fresh key, a reported ambiguity or a reported loss, never a guess. Each solid of the result:
  - continues the one target piece it keeps faces of. A Boolean keeps its target's key, whatever tool or copies it absorbs;
  - keeping no target face, continues the one pattern copy it keeps faces of, keyed `inst(i,j)` after the piece copied, such as
    `box/inst(2,0)`. The copied piece itself becomes `inst(0,0)`, and nested patterns nest them. A solid of the fused tool alone gets a
    fresh key;
  - keeping faces of several target pieces, or of several copies and no target, merges them. It gets a fresh key, and the merged pieces are
    reported lost;
  - keeping no face at all, descends from the target's one key when the target has one key and the feature has no tool or copies.
    Otherwise it gets a fresh key. Face provenance is then incomplete: nothing proves that a piece one solid continues did not also split
    into it, or which piece no solid continues it is. So it, the pieces continued by one solid and the pieces no solid continues are
    ambiguous together.
- A key that one solid continues stays. When several solids continue it, each becomes `key/split(q)`, numbered by the first face of the
  body before that it keeps, never by position or size, then the solids that keep no face in the kernel's order. Fresh keys are
  `feature/split(k)`: solids of the tool, then merges, then solids that keep no face. Faces rank within their source in the order the
  kernel lists its solids, and the kernel may list a source's solids, a Boolean's result and a tool in any order for the same input.
  Within one solid the faces keep their order. So where pieces are numbered by faces of different solids, as the several solids of a
  whole body are, by equal ranks, or in the kernel's order, the split is recorded in `CadBodyState.orders`: the sibling keys, in this
  build's order, and for pieces numbered by faces (`by`) the solids each keeps its first faces of, with its first rank in each. Reordering
  the solids moves whole blocks of pieces, not single pieces: the pieces keeping faces of one solid alone keep their order among
  themselves, and only their block moves among the others. From `by` each piece's places, the indices some order gives it, are found
  exactly (`cadBodyOrderPlaces`); tied pieces trade places among themselves. A piece with more than one place is ambiguous. Past
  `MAX_CAD_BODY_SHARED_SOLIDS` (10) solids that pieces share, or `MAX_CAD_BODY_ORDER_WORK` (2^22) steps of work, the order is recorded
  without `by`, so any of its pieces may take any of its indices: a stated superset of the true places.
- A key resolves among the pieces it names in some kernel order. Reading it from its first step, each split step the body's orders record
  may be any sibling that some order places at that index, and every other step stays: a split whose pieces the faces ordered, a copy and
  an image follow their solid. Different splits are decided independently: a split of one solid orders its pieces by that solid's faces,
  and only whole bodies, tools and merges, which start fresh keys, mix solids. So a key resolves to its piece when it names that piece in
  every order, as ambiguous among exactly the pieces it names in some order otherwise, and as missing when it names none. A later
  feature's key with the same steps, such as the copy of a join that merged the originals, is never a substitute. An order stays while
  one of its keys is, or leads to, a piece or a group's key.
- Ambiguity from incomplete provenance is kept in groups (`CadBodyState.ambiguous`): a solid keeping no face may continue any of the keys
  it is grouped with, which no order shows, so a key resolves also to the pieces of any group a key it may be is in. The keys that
  descend from one group through one source form a group, so each pattern copy's pieces stay apart from every other copy's, until K5 can
  establish identity. A group's earlier keys that are no longer pieces stay in it while a solid descends from the group through the
  target. Orders never join groups.
- A key that named a piece before a feature, in some order, and names none after it is lost, and references to it resolve as missing,
  unless a solid it could name continues: then that solid split or was copied, and the key is an old one. So a piece the feature removed
  is not lost while another order gives its key a solid that is left. Every such key is reported, including keys that neither this
  build's pieces nor its orders list but that another order gives a removed or merged solid, sorted with runs of digits by value, so
  every order reports the same lost keys. They are found by reading each removed or merged solid's keys step by step, before the feature
  and after it together, over the indices each order may give it, and the work grows with the keys found. Past `MAX_CAD_BODY_LIST`
  (4,096) lost keys, or `MAX_CAD_BODY_ORDER_WORK` steps of that search, the body's parts are untracked, since any shorter list would
  depend on the order.
- `cadBodyOrders.test.ts` checks the rule over generated histories. It builds each history under every combination of the orders the
  kernel may choose, the body's first solids', each Boolean's result's and each tool's, while there are at most 2,000, and checks every
  key listed, or formed by changing split indices, against what the builds show: missing when no build has it as a piece, resolved when
  every build has it as the same piece, and otherwise ambiguous among exactly the solids it is a piece as in some build, plus only the
  pieces of the provenance groups it can reach: a group holding it, or holding a key that some build had as the same solid as it at that
  feature or before. Larger histories are built in a sample of combinations, where each key must resolve the same way in all of them
  and stand for every solid the sample shows. Every build must report the same lost keys, each resolving before its feature and missing
  after it, and where every combination is built and none has groups, exactly the keys some build had as a piece before and none has after, whose solids no solid
  of the result continues. Kernel cases check the same on real builds in every order of their Booleans.
- Each feature reports these in `CadBuildResult.bodyIssues` for D1 to adopt: `ambiguous-body-parts` for keys it makes ambiguous,
  `lost-body-parts` for keys it leaves naming nothing, by removing or merging their solids, and `untracked-body-parts` when a body tracks
  more than `MAX_CAD_BODY_LIST` (4,096) distinct part keys: its pieces, the keys its groups keep and the keys its orders keep, together, and the worker check holds a reply to the same count, or
  when a feature leaves more lost keys than that, or its search for them passes the work bound. The body's parts are then untracked for the rest of the history, and
  references to them resolve as missing. Since groups keep every former member's key while a solid descends from them,
  the keys grow with the history, not the solid count: a body of 100 ambiguous solids that loses one piece and splits another at each
  feature adds two keys a feature and passes the limit at the 1,999th such feature. That limit is separate from an issue's 4,096 keys
  below. Collapsing a group's kept keys to a common prefix was not done: removed and merged keys leave no descendant to imply them, so it
  would at most halve the growth while adding a third way to resolve a key. A key ambiguous only
  because it descends from an ambiguous key is added to the issue that reported that key instead of being reported again, until that
  issue lists 4,096 keys. The later feature then reports the keys that did not fit in an `ambiguous-body-parts` issue of its own, which
  later descendants extend in turn. A message gives counts,
  never keys; `pieces` lists the keys, at most 4,096. A build lists at most `MAX_CAD_BODY_ISSUES` (512) issues, and the last becomes
  `more-body-issues`, which counts the rest. Two cases are reported today: a fillet or chamfer of every edge rebuilds every face, so the
  pieces it changes keep none; and the kernel simplifies the result of a Boolean, which can merge faces, so a solid that continues a piece
  can keep none of its faces. Precise lineage through Booleans and splits waits for the kernel's own history (K3: modified, generated and
  deleted shapes).
- An inactive feature changes no body. Under `pass-through` its id leads to the body it would have changed, so selecting it selects that
  body; under `no-output` it leads nowhere. Validation and the kernel resolve a stored target strictly (`at`): it names the feature whose
  result the body now is, as before.
- Keys are derived on every rebuild and never stored, so the stored document is unchanged and targets still hold feature ids. S8's format
  cut stores targets as `CadBodyRef` (`{ kind: 'body', key }`, resolved by `resolveCadBodyRef` to a body, a part of one, a missing body
  with the feature that consumed it, or an ambiguous piece) and body metadata as `CadBodyMetadata` (`{ name, role, appearance?, material? }`)
  keyed by body key. Until then `resolveCadBodyMetadata` names each body after its creating feature, in the `part` role.
- Consumers choose a body by key. A selected feature leads to its body wherever it sits in that body's history (`cadSelectedBody`), and
  the latest body is chosen only when the selection leads to none. Worker requests and agent tools still pass the `featureId` of a body's
  current state as `bodyId`.

## Not yet slots

Revolve, circular pattern and mirror store their axis or plane as a choice of world axes and planes. K4 turns these into slots that
reference datum axes and planes. Pattern counts are scalars with `literal: true` until a format change lets them hold expressions.

## Kinds

<!-- cad-feature-table:start -->
| Kind | Family | Inputs | Dimensions | Gives | Bodies | When inactive | Evaluator | Form | Agents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `datum-plane` | reference | – | – | plane | none | no-output | domain 1 | bespoke | yes |
| `curve` | reference | `plane` support plane, optional | `offset` length | curve | none | no-output | domain 1 | bespoke | yes |
| `sketch` | reference | `plane` support plane, optional; `graph` linked sketches | `offset` length | sketch | none | no-output | domain 1 | bespoke | yes |
| `imported` | solid | – | – | body | new | no-output | kernel 1 | bespoke | yes |
| `extrude` | solid | `sketchId` profile sketch; `targetId` target body, optional | `distance` length > 1e-7, ≤ 1000000 | body | new-or-modify | pass-through | kernel 1 | bespoke | yes |
| `pocket` | solid | `sketchId` profile sketch; `targetId` target body | – | body | modify-target | pass-through | kernel 1 | bespoke | yes |
| `revolve` | solid | `sketchId` profile sketch; `targetId` target body, optional | `angle` angle > 1e-7, ≤ 360 | body | new-or-modify | pass-through | kernel 1 | fields | yes |
| `loft` | solid | `sketchIds` sections sketches, ordered; `targetId` target body, optional | – | body | new-or-modify | pass-through | kernel 1 | fields | yes |
| `sweep` | solid | `sketchId` profile sketch; `curveId` path curve; `targetId` target body, optional | – | body | new-or-modify | pass-through | kernel 1 | fields | yes |
| `fillet` | dress-up | `targetId` target body | `radius` length > 1e-7, ≤ 1000000 | body | modify-target | pass-through | kernel 1 | fields | yes |
| `chamfer` | dress-up | `targetId` target body | `radius` length > 1e-7, ≤ 1000000 | body | modify-target | pass-through | kernel 1 | fields | yes |
| `shell` | dress-up | `targetId` target body | `thickness` length > 1e-7, ≤ 1000000 | body | modify-target | pass-through | kernel 1 | fields | yes |
| `boolean` | body | `targetId` target body; `toolId` tool body | – | body | consume-tools | pass-through | kernel 1 | fields | yes |
| `transform` | body | `sourceId` source body | `translation` length ×3; `rotation` angle ×3 | body | modify-target | pass-through | kernel 1 | fields | yes |
| `linear-pattern` | body | `sourceId` source body | `count` count ≥ 2, ≤ 100, literal; `spacing` length ×3 | body | modify-target | pass-through | kernel 1 | fields | yes |
| `circular-pattern` | body | `sourceId` source body | `count` count ≥ 2, ≤ 100, literal; `center` length ×3; `angle` angle | body | modify-target | pass-through | kernel 1 | fields | yes |
| `mirror` | body | `sourceId` source body | – | body | new | no-output | kernel 1 | fields | yes |
<!-- cad-feature-table:end -->
