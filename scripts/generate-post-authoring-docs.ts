import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { compile } from 'json-schema-to-typescript';

import { PostLibraryDocumentSchema } from '../src/domain/post-processor/postLibraryStorage.ts';
import {
  parseWireEdmPostPackage,
  type PostPackageDiagnosticCode
} from '../src/domain/post-processor/postPackage.ts';
import { WireEdmPostPackageSchema } from '../src/domain/post-processor/postPackageSchema.ts';
import { MachineDefinitionSchema } from '../src/domain/machine-definition/machineDefinition.ts';
import { MachineLibraryDocumentSchema } from '../src/domain/machine-definition/machineLibraryStorage.ts';
import { WorkbenchCatalogManifestSchema } from '../src/domain/workbench-catalog/workbenchCatalog.ts';
import { WorkbenchProjectDocumentSchema } from '../src/domain/workbench-catalog/workbenchProject.ts';
import {
  MachinePackageDocumentSchema,
  MachinePackageSourceDocumentSchema,
  MAX_MACHINE_PACKAGE_ARCHIVE_BYTES,
  MAX_MACHINE_PACKAGE_ENTRIES,
  MAX_MACHINE_PACKAGE_EXPANDED_BYTES
} from '../src/domain/machine-package/machinePackage.ts';
import {
  CUSTOM_POST_DIAGNOSTIC_CODES,
  DEFAULT_CUSTOM_POST_RUNTIME_LIMITS
} from '../src/domain/post-processor/custom-runtime/customPostRuntime.ts';
import {
  CUSTOM_POST_CONFORMANCE_DIAGNOSTIC_CODES,
  runCustomPostConformance,
} from '../src/domain/post-processor/custom-runtime/customPostConformance.ts';
import { CANONICAL_POST_PLAN_FIXTURES } from '../src/domain/post-processor/custom-runtime/canonicalPostConformanceFixtures.ts';
import {
  CUSTOM_POST_EVENT_KINDS,
  CUSTOM_POST_SDK_DECLARATION
} from '../src/domain/post-processor/custom-runtime/postAuthoringContract.ts';

const root = process.cwd();
const examplePath = path.join(root, 'docs/post-authoring/v1/examples/minimal.wireedm-post.json');
const packageDiagnosticCodes = [
  'POST_PACKAGE_FILE_TOO_LARGE',
  'POST_PACKAGE_JSON_INVALID',
  'POST_PACKAGE_SCHEMA_INVALID',
  'POST_PACKAGE_RECORD_KEY_INVALID',
  'POST_PACKAGE_DUPLICATE_ID',
  'POST_PACKAGE_SOURCE_NOT_FOUND',
  'POST_PACKAGE_EVIDENCE_NOT_FOUND',
  'POST_PACKAGE_EVIDENCE_TARGET_NOT_FOUND',
  'POST_PACKAGE_EVIDENCE_SCOPE_MISMATCH',
  'POST_PACKAGE_EXECUTION_CONTRACT_INVALID',
  'POST_PACKAGE_PROPERTY_DEFINITION_INVALID',
  'POST_PACKAGE_COMMAND_PARAMETER_INVALID',
  'POST_PACKAGE_FIXTURE_PROPERTY_INVALID'
] as const satisfies readonly PostPackageDiagnosticCode[];
const allPackageDiagnosticCodesPublished: Exclude<
  PostPackageDiagnosticCode,
  typeof packageDiagnosticCodes[number]
> extends never ? true : false = true;
void allPackageDiagnosticCodesPublished;
const declarationOptions = {
  bannerComment: '/* Generated from the authoritative Wire EDM JSON Schema. Do not edit by hand. */',
  unknownAny: false
} as const;
const canonicalInstallationScenarioFixtures = {
  registryVersion: '1',
  pathBase: 'authoring-kit-root',
  mutationDocument: 'resolved-machine-package-document',
  baseSourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2',
  scenarios: [
    {
      id: 'valid-new-machine',
      purpose: 'A complete valid package enters an empty machine and post catalog.',
      installed: [],
      incoming: { sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2', mutations: [] },
      expected: { previewMachineKind: 'new', commit: 'accepted', machineCount: 1, postCount: 1 }
    },
    {
      id: 'invalid-target',
      purpose: 'A setup cannot bind a post whose declared controller target differs from the machine.',
      installed: [],
      incoming: {
        sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2',
        mutations: [{ jsonPointer: '/machine/identity/controller/model', value: 'Different Controller' }]
      },
      expected: { validation: 'rejected', diagnosticCode: 'MACHINE_PACKAGE_TARGET_MISMATCH' }
    },
    {
      id: 'same-id-machine-update',
      purpose: 'The same machine ID with changed physical data requires an explicit reviewed replacement.',
      installed: [{ sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2' }],
      incoming: {
        sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2',
        mutations: [{ jsonPointer: '/machine/limits/xTravel/millimeters', value: 401 }]
      },
      expected: { previewMachineKind: 'changed', automaticMerge: false, requiresResolution: 'replace-existing' }
    },
    {
      id: 'post-version-content-conflict',
      purpose: 'Different post content cannot claim an already installed post ID and version.',
      installed: [{ sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2' }],
      incoming: {
        sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2',
        mutations: [{ jsonPointer: '/posts/0/manifest/description', value: 'Different content under the same version.' }],
        recomputePostHashAndBindingReference: true
      },
      expected: { prepare: 'rejected', diagnosticCode: 'POST_LIBRARY_VERSION_CONFLICT' }
    },
    {
      id: 'same-machine-new-post',
      purpose: 'An exact physical machine is reused while a separately versioned post and setup are added.',
      installed: [{ sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2' }],
      incoming: {
        sourceDirectory: '../../../tests/fixtures/machine-packages/robofil-100-v2',
        mutations: [
          { jsonPointer: '/posts/0/manifest/id', value: 'cristian.robofil-100.alternate' },
          { jsonPointer: '/posts/0/manifest/version', value: '1.0.0' },
          { jsonPointer: '/machine/bindings/0/id', value: 'alternate' },
          { jsonPointer: '/activeBindingId', value: 'alternate' }
        ],
        recomputePostHashAndBindingReference: true
      },
      expected: { previewMachineKind: 'exact', requiresResolution: 'reuse-existing', machineCount: 1, postCount: 2, setupCount: 2 }
    }
  ]
} as const;
const machinePackageDeclarations = await compile(
  withoutSchemaId(MachinePackageDocumentSchema),
  'WireEdmMachinePackageDocument',
  declarationOptions
);
const machinePackageSourceDeclarations = await compile(
  withoutSchemaId(MachinePackageSourceDocumentSchema),
  'WireEdmMachinePackageSourceDocument',
  declarationOptions
);
const generatedFiles = [
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/machine-package.schema.json'),
    contents: `${JSON.stringify(MachinePackageDocumentSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/machine-package-source.schema.json'),
    contents: `${JSON.stringify(MachinePackageSourceDocumentSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/post-package.schema.json'),
    contents: `${JSON.stringify(WireEdmPostPackageSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/post-library.schema.json'),
    contents: `${JSON.stringify(PostLibraryDocumentSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/machine-definition.schema.json'),
    contents: `${JSON.stringify(MachineDefinitionSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/machine-library.schema.json'),
    contents: `${JSON.stringify(MachineLibraryDocumentSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/workbench.schema.json'),
    contents: `${JSON.stringify(WorkbenchCatalogManifestSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/schema/workbench-project.schema.json'),
    contents: `${JSON.stringify(WorkbenchProjectDocumentSchema, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/sdk/wire-edm-post-sdk.d.ts'),
    contents: CUSTOM_POST_SDK_DECLARATION
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/sdk/wire-edm-machine-package.d.ts'),
    contents: machinePackageDeclarations
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/sdk/wire-edm-machine-package-source.d.ts'),
    contents: machinePackageSourceDeclarations
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/sdk/event-diagnostic-catalog.json'),
    contents: `${JSON.stringify({
      engineApiVersion: '1',
      eventKinds: CUSTOM_POST_EVENT_KINDS,
      packageDiagnosticCodes,
      conformanceDiagnosticCodes: CUSTOM_POST_CONFORMANCE_DIAGNOSTIC_CODES,
      runtimeDiagnosticCodes: CUSTOM_POST_DIAGNOSTIC_CODES,
      cliDiagnosticCodes: [
        'POST_CONFORMANCE_ARGUMENT_INVALID',
        'POST_CONFORMANCE_INPUT_UNREADABLE'
      ],
      cliReport: {
        discriminator: 'ok',
        commonFields: ['conformanceRunnerVersion', 'ok', 'stage'],
        stages: ['invocation', 'input', 'package-validation', 'conformance'],
        failureField: 'diagnostics',
        successFields: ['package', 'fixtures']
      },
      defaultRuntimeLimits: DEFAULT_CUSTOM_POST_RUNTIME_LIMITS,
      deniedGuestGlobals: [
        'Date',
        'eval',
        'Function',
        'WebAssembly',
        'performance',
        'crypto',
        'fetch',
        'XMLHttpRequest',
        'WebSocket',
        'navigator',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'caches',
        'document',
        'window',
        'self',
        'Intl',
        'WeakRef',
        'FinalizationRegistry',
        'Atomics',
        'SharedArrayBuffer',
        'Temporal',
        'Math.random'
      ]
    }, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/sdk/canonical-plan-fixtures.json'),
    contents: `${JSON.stringify({
      registryVersion: '1',
      fixtures: CANONICAL_POST_PLAN_FIXTURES
    }, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/sdk/canonical-installation-scenarios.json'),
    contents: `${JSON.stringify(canonicalInstallationScenarioFixtures, null, 2)}\n`
  },
  {
    path: path.join(root, 'docs/post-authoring/v1/compatibility.json'),
    contents: `${JSON.stringify({
      authoringKitVersion: '1',
      postPackageSchemaVersions: WireEdmPostPackageSchema.properties.schemaVersion.anyOf.map((schema) => schema.const),
      upidSchemaVersions: [1, 2, 3],
      appProvenance: {
        field: 'manifest.authoredFor',
        requiredForNewAuthoring: true,
        legacyPackages: 'readable-without-rewrite; absence-means-unknown',
        meaning: 'authoring-target-only; not-controller-verification-or-a-compatible-version-range'
      },
      machinePackageSchemaVersions: [1],
      engineApiVersions: ['1'],
      motionAudit: {
        coordinates: 'formatted-quantized-values',
        arcDirection: 'selected-command-declaration',
        legacyArcPackages: 'readable-without-rewrite; explicit-direction-required-for-execution',
        storedLibraryReopen: 'validate-structure-semantics-and-exact-canonical-hash; no-installation-conformance'
      },
      installation: {
        artifactExtension: '.wireedm-package',
        archiveLimits: {
          compressedBytes: MAX_MACHINE_PACKAGE_ARCHIVE_BYTES,
          expandedBytes: MAX_MACHINE_PACKAGE_EXPANDED_BYTES,
          entries: MAX_MACHINE_PACKAGE_ENTRIES
        },
        canonicalScenarioFile: 'sdk/canonical-installation-scenarios.json',
        declarationFiles: [
          'sdk/wire-edm-machine-package.d.ts',
          'sdk/wire-edm-machine-package-source.d.ts'
        ],
        browserWorkbench: 'https://brocad-m.visionforge.cc/package-tools/',
        buildAction: 'Build package: Validate and build package',
        inspectAction: 'Inspect package: Validate and inspect package'
      },
      conformance: {
        runnerVersion: '1',
        browserAction: 'Check post: Validate post and run conformance',
        canonicalFixtureRegistryVersion: '1',
        canonicalFixtureIds: Object.keys(CANONICAL_POST_PLAN_FIXTURES)
      }
    }, null, 2)}\n`
  }
];

const example = parseWireEdmPostPackage(await readFile(examplePath, 'utf8'));
if (!example.ok) {
  throw new Error(`Minimal post example is invalid: ${JSON.stringify(example.diagnostics)}`);
}
const exampleConformance = await runCustomPostConformance({
  packageValue: example.package,
  planFixtures: CANONICAL_POST_PLAN_FIXTURES
});
if (!exampleConformance.ok) {
  throw new Error(`Minimal post example is nonconformant: ${JSON.stringify(exampleConformance.diagnostics)}`);
}

if (process.argv.includes('--check')) {
  const stale: string[] = [];
  for (const file of generatedFiles) {
    const existing = await readExisting(file.path);
    if (existing !== file.contents) stale.push(path.relative(root, file.path));
  }
  if (stale.length > 0) {
    throw new Error(`Generated post-authoring files are stale: ${stale.join(', ')}. Run npm run post:docs:generate.`);
  }
} else {
  for (const file of generatedFiles) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, 'utf8');
  }
}

async function readExisting(filePath: string) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function withoutSchemaId<Schema extends object>(schema: Schema) {
  const clone = structuredClone(schema) as Schema & { $id?: string };
  delete clone.$id;
  return clone;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
