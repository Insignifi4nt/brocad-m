import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { obtainSourceArchive, verifyPinnedFile } from './distribute-step-sources';

const pinnedCommit = Type.String({ pattern: '^[a-f0-9]{40}$' });
const fileSchema = Type.Object({ fileName: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', maxLength: 160 }), byteLength: Type.Integer({ minimum: 1, maximum: 128 * 1024 * 1024 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false });
const modifiedSourceNames = ['replicad-opencascadejs-1.1.0-wireedm.1.tgz', 'replicad-ownership-backport.patch', 'replicad-ownership-rebuild.tar.gz', 'replicad-ownership-build.json'];
const indexedSourceNames = ['replicad-opencascadejs-1.1.0-wireedm.2.tgz', 'replicad-ownership-backport.patch', 'replicad-indexed-topology.patch', 'replicad-ownership-rebuild.tar.gz', 'replicad-ownership-build.json'];
const modificationProperties = {
  upstreamCommit: Type.Literal('193f3339893c909abdd5e62a6f1dc6742369fa30'),
  toolchainImage: Type.Literal('ghcr.io/taucad/opencascade.js@sha256:215198af0e2ca4c5f308e5540869f2419784dc290062d3eb03d34e4f22e0188c')
};
const manifestProperties = {
  format: Type.Literal('wire-edm-cad-kernel-sources'), schemaVersion: Type.Literal(1),
  packageName: Type.Literal('replicad-opencascadejs'),
  gitHead: pinnedCommit, bindingGeneratorCommit: pinnedCommit, occtCommit: pinnedCommit,
  archives: Type.Array(Type.Composite([fileSchema, Type.Object({ url: Type.String() })]), { minItems: 5, maxItems: 5 })
};
const manifestSchema = Type.Union([
  Type.Object({ ...manifestProperties, packageVersion: Type.Literal('1.1.0'), installedArtifacts: Type.Array(fileSchema, { minItems: 2, maxItems: 2 }) }, { additionalProperties: false }),
  Type.Object({ ...manifestProperties, packageVersion: Type.Literal('1.1.0-wireedm.1'), installedArtifacts: Type.Array(fileSchema, { minItems: 2, maxItems: 2 }), modification: Type.Object({
    kind: Type.Literal('native-ownership-backport'), ...modificationProperties,
    files: Type.Array(fileSchema, { minItems: 4, maxItems: 4 })
  }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ ...manifestProperties, packageVersion: Type.Literal('1.1.0-wireedm.2'), installedArtifacts: Type.Array(fileSchema, { minItems: 3, maxItems: 3 }), modification: Type.Object({
    kind: Type.Literal('native-ownership-and-topology'), ...modificationProperties,
    files: Type.Array(fileSchema, { minItems: 5, maxItems: 5 })
  }, { additionalProperties: false }) }, { additionalProperties: false })
]);
const nativeBuildProperties = {
  format: Type.Literal('wireedm-cad-native-ownership-build'), schemaVersion: Type.Literal(1),
  packageName: Type.Literal('replicad-opencascadejs'),
  upstreamOwnershipCommit: pinnedCommit, bindingGeneratorCommit: pinnedCommit, replicadCommit: pinnedCommit, occtCommit: pinnedCommit,
  toolchainImage: Type.String(), emscriptenVersion: Type.Literal('5.0.1'), variant: Type.Literal('single-threaded')
};
const nativeBuildSchema = Type.Union([
  Type.Object({ ...nativeBuildProperties, packageVersion: Type.Literal('1.1.0-wireedm.1'), repairedArtifacts: Type.Array(fileSchema, { minItems: 2, maxItems: 2 }), artifacts: Type.Array(fileSchema, { minItems: 3, maxItems: 3 }) }),
  Type.Object({ ...nativeBuildProperties, packageVersion: Type.Literal('1.1.0-wireedm.2'), repairedArtifacts: Type.Array(fileSchema, { minItems: 3, maxItems: 3 }), topologyIdentity: Type.Literal('indexed-map'), artifacts: Type.Array(fileSchema, { minItems: 4, maxItems: 4 }) })
]);
const repositories = ['sgenoud/replicad', 'tauCAD/opencascade.js', 'Open-Cascade-SAS/OCCT', 'Tencent/rapidjson', 'freetype/freetype'];
const notices = ['replicad-MIT.txt', 'replicad-opencascadejs-LGPL-2.1.txt', 'OCCT-LGPL-2.1.txt', 'OCCT-LGPL-exception.txt', 'rapidjson-license.txt', 'freetype-FTL.txt', 'flatbush-ISC.txt', 'flatqueue-ISC.txt', 'opentype-MIT.txt', 'tiny-inflate-MIT.txt', 'codepointat-MIT.txt'];
const manifestPath = 'docs/thirdparty/replicad-sources.json';

async function inputs(root: string) {
  const manifestText = await readFile(path.join(root, manifestPath), 'utf8');
  const value: unknown = JSON.parse(manifestText);
  if (!Value.Check(manifestSchema, value)) throw new Error('Invalid CAD corresponding source manifest.');
  const installed: unknown = JSON.parse(await readFile(path.join(root, 'node_modules/replicad-opencascadejs/package.json'), 'utf8'));
  if (!Value.Check(Type.Object({ name: Type.Literal(value.packageName), version: Type.Literal(value.packageVersion), gitHead: Type.Literal(value.gitHead) }), installed)) throw new Error('Installed CAD kernel differs from its source manifest.');
  const expectedCommits = [value.gitHead, value.bindingGeneratorCommit, value.occtCommit];
  value.archives.forEach((archive, index) => {
    const prefix = `https://codeload.github.com/${repositories[index]}/tar.gz/`;
    if (!archive.url.startsWith(prefix) || !/^[a-f0-9]{40}$/.test(archive.url.slice(prefix.length))
      || index < 3 && archive.url !== prefix + expectedCommits[index]) throw new Error('CAD source URL does not match its pinned repository and commit.');
  });
  const expectedArtifactNames = value.packageVersion === '1.1.0-wireedm.2' ? 'replicad_single.js,replicad_single.wasm,replicad_single.d.ts' : 'replicad_single.js,replicad_single.wasm';
  if (value.installedArtifacts.map(file => file.fileName).join(',') !== expectedArtifactNames) throw new Error('CAD kernel artifact manifest does not match the single-thread build.');
  for (const file of value.installedArtifacts) await verifyPinnedFile(path.join(root, 'node_modules/replicad-opencascadejs/dist', file.fileName), file);
  const modification = 'modification' in value ? value.modification : null;
  const localSources = modification?.files ?? [];
  const expectedSourceNames = value.packageVersion === '1.1.0-wireedm.2' ? indexedSourceNames : modifiedSourceNames;
  if (modification && localSources.map(file => file.fileName).join(',') !== expectedSourceNames.join(',')) throw new Error('Modified CAD kernel requires its complete paired package, patch and rebuild evidence.');
  for (const file of localSources) await verifyPinnedFile(path.join(root, 'vendor/cad-kernel', file.fileName), file);
  if (modification) {
    const record: unknown = JSON.parse(await readFile(path.join(root, 'vendor/cad-kernel/replicad-ownership-build.json'), 'utf8'));
    if (!Value.Check(nativeBuildSchema, record) || record.packageVersion !== value.packageVersion || record.upstreamOwnershipCommit !== modification.upstreamCommit
      || record.bindingGeneratorCommit !== value.bindingGeneratorCommit || record.replicadCommit !== value.gitHead
      || record.occtCommit !== value.occtCommit || record.toolchainImage !== modification.toolchainImage
      || !Value.Equal(record.repairedArtifacts, value.installedArtifacts) || !Value.Equal(record.artifacts, localSources.slice(0, -1))) {
      throw new Error('Modified CAD kernel build record does not match its paired artifacts and corresponding source.');
    }
  }
  const rebuild = await readFile(path.join(root, 'docs/thirdparty/replicad-rebuild.md'), 'utf8');
  const index = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CAD kernel licenses and corresponding source</title><body>
<h1>CAD kernel licenses and corresponding source</h1><p>broCAD/M uses unmodified Replicad 1.1.0 (MIT) and ${modification ? `modified replicad-opencascadejs ${value.packageVersion} with the upstream native ownership repair${value.packageVersion === '1.1.0-wireedm.2' ? ' and exact indexed topology extraction' : ''}` : 'unmodified replicad-opencascadejs 1.1.0'} (LGPL 2.1), with OpenCascade Technology 8.0.1 (LGPL 2.1 and its additional exception). Exact source, wrapper/build files and dependencies are available below. Models are processed locally in your browser.</p>
<ul>${[...value.archives, ...localSources].map(file => `<li><a download href="${file.fileName}">${file.fileName}</a> (${file.byteLength} bytes), SHA-256 <code>${file.sha256}</code></li>`).join('\n')}</ul>
<p><a href="replicad-sources.json">Pinned source and library binary manifest</a> · <a href="REBUILD-replicad.md">Build and relink instructions</a></p>
<p><a href="../sketch-solver/index.html">PlaneGCS sketch solver, included up to 0.0.756: archived licenses, exact source and replacement instructions</a></p>
<ul>${notices.map(file => `<li><a href="${file}">${file}</a></li>`).join('\n')}</ul><p>These libraries are provided without warranty. FreeType is distributed under the FreeType License; portions of this software are copyright © 2023 The FreeType Project (www.freetype.org). All rights reserved.</p></body></html>\n`;
  return { manifest: value, localSources, texts: new Map([['replicad-sources.json', manifestText], ['REBUILD-replicad.md', rebuild], ['index.html', index],
    ...await Promise.all(notices.map(async file => [file, await readFile(path.join(root, 'src/features/cad/kernel/notices', file), 'utf8')] as const))]) };
}

/**
 * Versions up to 0.0.756 included PlaneGCS and served its licenses and source from this page's
 * address; it now points to the release archiving them.
 */
const archivedSketchSolverPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sketch solver licenses and source</title><body>
<h1>Sketch solver licenses and source</h1><p>broCAD/M versions up to 0.0.756 included the unmodified PlaneGCS 1.3.0 sketch solver (<code>@salusoft89/planegcs</code>): a wrapper under LGPL 2.1-or-later notices and a copied FreeCAD core under GNU Library GPL 2-or-later notices. Since 0.0.757 the app solves sketches with its own MIT-licensed solver and no longer includes PlaneGCS.</p>
<p>The PlaneGCS package, its exact source, the dependency sources, license notices and rebuild and replacement instructions served with those versions are archived in the <a href="https://github.com/Insignifi4nt/brocad-m/releases/tag/planegcs-1.3.0-sources">PlaneGCS 1.3.0 sources release</a>.</p></body></html>
`;

export async function distributeCadSources(root = process.cwd(), fetchSource: typeof fetch = fetch) {
  const { manifest, localSources, texts } = await inputs(root);
  const sources: string[] = [];
  for (const archive of manifest.archives) sources.push(await obtainSourceArchive(path.join(root, '.cache/third-party-sources'), archive, fetchSource, repositories));
  const destination = path.join(root, 'dist/third-party/cad');
  await mkdir(destination, { recursive: true });
  for (const [index, archive] of manifest.archives.entries()) await copyFile(sources[index], path.join(destination, archive.fileName));
  for (const file of localSources) await copyFile(path.join(root, 'vendor/cad-kernel', file.fileName), path.join(destination, file.fileName));
  for (const [file, content] of texts) await writeFile(path.join(destination, file), content);
  await mkdir(path.join(root, 'dist/third-party/sketch-solver'), { recursive: true });
  await writeFile(path.join(root, 'dist/third-party/sketch-solver/index.html'), archivedSketchSolverPage);
}
export async function checkCadSourceDistribution(root = process.cwd()) {
  const { manifest, localSources, texts } = await inputs(root);
  const destination = path.join(root, 'dist/third-party/cad');
  for (const file of [...manifest.archives, ...localSources]) await verifyPinnedFile(path.join(destination, file.fileName), file);
  for (const [file, expected] of texts) if (await readFile(path.join(destination, file), 'utf8') !== expected) throw new Error(`CAD third-party distribution text differs: ${file}`);
  if (await readFile(path.join(root, 'dist/third-party/sketch-solver/index.html'), 'utf8') !== archivedSketchSolverPage) throw new Error('The archived sketch solver page differs.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') throw new Error('Usage: distribute-cad-sources.ts [--check]');
  if (!args.length) await distributeCadSources();
  await checkCadSourceDistribution();
  console.log('CAD kernel corresponding source verified: 5 pinned archives, exact library artifacts, licenses and relink instructions.');
}
