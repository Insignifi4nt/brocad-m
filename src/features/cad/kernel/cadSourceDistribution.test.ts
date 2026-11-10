// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCadSourceDistribution, distributeCadSources } from '../../../../scripts/distribute-cad-sources';
import sourceManifest from '../../../../docs/thirdparty/replicad-sources.json';

const roots: string[] = [];
const prefix = path.join(os.tmpdir(), 'wireedm-cad-source-test-');
const metadata = (fileName: string, bytes: Buffer) => ({ fileName, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
const notices = ['replicad-MIT.txt', 'replicad-opencascadejs-LGPL-2.1.txt', 'OCCT-LGPL-2.1.txt', 'OCCT-LGPL-exception.txt', 'rapidjson-license.txt', 'freetype-FTL.txt', 'flatbush-ISC.txt', 'flatqueue-ISC.txt', 'opentype-MIT.txt', 'tiny-inflate-MIT.txt', 'codepointat-MIT.txt'];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.resolve(root).startsWith(prefix)) throw new Error('Test temporary directory escaped its allocated prefix.');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(prefix); roots.push(root);
  const { modification: _modification, ...baseManifest } = structuredClone(sourceManifest);
  const manifest = { ...baseManifest, packageVersion: '1.1.0', installedArtifacts: baseManifest.installedArtifacts.filter(file => file.fileName !== 'replicad_single.d.ts') };
  const sources = manifest.archives.map((archive, index) => Buffer.from(`complete CAD source archive ${index}`));
  const artifacts = manifest.installedArtifacts.map((archive, index) => Buffer.from(`paired kernel artifact ${index}`));
  manifest.archives = manifest.archives.map((archive, index) => ({ ...archive, ...metadata(archive.fileName, sources[index]) }));
  manifest.installedArtifacts = manifest.installedArtifacts.map((file, index) => metadata(file.fileName, artifacts[index]));
  const files: [string, string | Buffer][] = [
    ['docs/thirdparty/replicad-sources.json', JSON.stringify(manifest)],
    ['docs/thirdparty/replicad-rebuild.md', 'Exact source and relink instructions.'],
    ['node_modules/replicad-opencascadejs/package.json', JSON.stringify({ name: manifest.packageName, version: manifest.packageVersion, gitHead: manifest.gitHead })],
    ...manifest.installedArtifacts.map((file, index): [string, Buffer] => [`node_modules/replicad-opencascadejs/dist/${file.fileName}`, artifacts[index]]),
    ...notices.map((name): [string, string] => [`src/features/cad/kernel/notices/${name}`, `Complete license: ${name}`])
  ];
  for (const [name, contents] of files) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); }
  const fetchSource: typeof fetch = async url => {
    const index = manifest.archives.findIndex(archive => archive.url === String(url));
    if (index < 0) throw new Error('Unexpected archive URL.');
    return new Response(new Uint8Array(sources[index]));
  };
  return { root, manifest, sources, fetchSource };
}
async function modifiedFixture(variant: 'ownership' | 'indexed' = 'ownership') {
  const fixtureResult = await fixture();
  const packageVersion = variant === 'indexed' ? '1.1.0-wireedm.2' : '1.1.0-wireedm.1';
  if (variant === 'indexed') {
    const fileName = 'replicad_single.d.ts', declarations = Buffer.from('export interface IndexedTopologyExtractor { extractWithTopologyIndices(): void; }');
    fixtureResult.manifest.installedArtifacts.push(metadata(fileName, declarations));
    await writeFile(path.join(fixtureResult.root, 'node_modules/replicad-opencascadejs/dist', fileName), declarations);
  }
  const fileNames = [`replicad-opencascadejs-${packageVersion}.tgz`, 'replicad-ownership-backport.patch',
    ...(variant === 'indexed' ? ['replicad-indexed-topology.patch'] : []), 'replicad-ownership-rebuild.tar.gz', 'replicad-ownership-build.json'];
  const contents = fileNames.slice(0, -1).map((_, index) => Buffer.from(`Complete modified library source ${index}`));
  const buildRecord = {
    format: 'wireedm-cad-native-ownership-build', schemaVersion: 1, packageName: 'replicad-opencascadejs', packageVersion,
    upstreamOwnershipCommit: '193f3339893c909abdd5e62a6f1dc6742369fa30', bindingGeneratorCommit: fixtureResult.manifest.bindingGeneratorCommit,
    replicadCommit: fixtureResult.manifest.gitHead, occtCommit: fixtureResult.manifest.occtCommit,
    toolchainImage: 'ghcr.io/taucad/opencascade.js@sha256:215198af0e2ca4c5f308e5540869f2419784dc290062d3eb03d34e4f22e0188c',
    emscriptenVersion: '5.0.1', variant: 'single-threaded', repairedArtifacts: fixtureResult.manifest.installedArtifacts,
    artifacts: fileNames.slice(0, -1).map((fileName, index) => metadata(fileName, contents[index])),
    ...(variant === 'indexed' ? { topologyIdentity: 'indexed-map' } : {})
  };
  contents.push(Buffer.from(JSON.stringify(buildRecord)));
  const localSources = fileNames.map((fileName, index) => metadata(fileName, contents[index]));
  const manifest = { ...fixtureResult.manifest, packageVersion, modification: {
    kind: variant === 'indexed' ? 'native-ownership-and-topology' : 'native-ownership-backport', upstreamCommit: '193f3339893c909abdd5e62a6f1dc6742369fa30',
    toolchainImage: 'ghcr.io/taucad/opencascade.js@sha256:215198af0e2ca4c5f308e5540869f2419784dc290062d3eb03d34e4f22e0188c', files: localSources
  } };
  await writeFile(path.join(fixtureResult.root, 'docs/thirdparty/replicad-sources.json'), JSON.stringify(manifest));
  await writeFile(path.join(fixtureResult.root, 'node_modules/replicad-opencascadejs/package.json'), JSON.stringify({ name: manifest.packageName, version: manifest.packageVersion, gitHead: manifest.gitHead }));
  const folder = path.join(fixtureResult.root, 'vendor/cad-kernel');
  await mkdir(folder, { recursive: true });
  for (const [index, file] of localSources.entries()) await writeFile(path.join(folder, file.fileName), contents[index]);
  return { ...fixtureResult, manifest, localSources, folder };
}
describe('CAD corresponding source distribution', () => {
  it('rejects indexed topology declarations that differ from the built library before publishing', async () => {
    const { root, fetchSource } = await modifiedFixture('indexed');
    await writeFile(path.join(root, 'node_modules/replicad-opencascadejs/dist/replicad_single.d.ts'), 'unmatched declarations');
    await expect(distributeCadSources(root, fetchSource)).rejects.toThrow('size mismatch');
    await expect(readdir(path.join(root, 'dist/third-party/cad'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['ownership', 'indexed'] as const)('publishes the %s pair package, complete patch and rebuild evidence alongside its pinned upstream originals', async variant => {
    const { root, fetchSource, manifest, localSources, folder } = await modifiedFixture(variant);
    await distributeCadSources(root, fetchSource);
    await checkCadSourceDistribution(root);
    for (const file of localSources) expect(await readFile(path.join(root, 'dist/third-party/cad', file.fileName))).toEqual(await readFile(path.join(folder, file.fileName)));
    const index = await readFile(path.join(root, 'dist/third-party/cad/index.html'), 'utf8');
    expect(index).toContain(`modified replicad-opencascadejs ${manifest.packageVersion}`);
    expect(index).toContain('replicad-ownership-backport.patch');
    await writeFile(path.join(root, 'dist/third-party/cad', localSources[1].fileName), Buffer.alloc(localSources[1].byteLength, 1));
    await expect(checkCadSourceDistribution(root)).rejects.toThrow('SHA-256 mismatch');
  });
  it.each(['ownership', 'indexed'] as const)('rejects a changed %s backport before publishing and preserves the proposed source bytes', async variant => {
    const { root, fetchSource, localSources, folder } = await modifiedFixture(variant);
    const patch = path.join(folder, localSources[1].fileName), changed = Buffer.alloc(localSources[1].byteLength, 1);
    await writeFile(patch, changed);
    await expect(distributeCadSources(root, fetchSource)).rejects.toThrow('SHA-256 mismatch');
    expect(await readFile(patch)).toEqual(changed);
    await expect(readdir(path.join(root, 'dist/third-party/cad'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['ownership', 'indexed'] as const)('rejects mismatched %s build evidence even when every proposed file has a matching checksum', async variant => {
    const { root, fetchSource, manifest, localSources, folder } = await modifiedFixture(variant);
    const index = localSources.length - 1, file = localSources[index], record = JSON.parse(await readFile(path.join(folder, file.fileName), 'utf8'));
    record.repairedArtifacts[0].sha256 = '0'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(record));
    await writeFile(path.join(folder, file.fileName), bytes);
    manifest.modification.files[index] = metadata(file.fileName, bytes);
    await writeFile(path.join(root, 'docs/thirdparty/replicad-sources.json'), JSON.stringify(manifest));
    await expect(distributeCadSources(root, fetchSource)).rejects.toThrow('build record does not match');
    await expect(readdir(path.join(root, 'dist/third-party/cad'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes all exact archives, notices and relink instructions and verifies them offline', async () => {
    const { root, manifest, sources, fetchSource } = await fixture();
    await distributeCadSources(root, fetchSource);
    await checkCadSourceDistribution(root);
    for (const [index, archive] of manifest.archives.entries()) expect(await readFile(path.join(root, 'dist/third-party/cad', archive.fileName))).toEqual(sources[index]);
    expect(await readFile(path.join(root, 'dist/third-party/cad/index.html'), 'utf8')).toContain('FreeType Project');
    await writeFile(path.join(root, 'dist/third-party/cad/replicad-MIT.txt'), 'changed');
    await expect(checkCadSourceDistribution(root)).rejects.toThrow('distribution text differs');
  });
  it('keeps the sketch solver page of earlier versions, pointing to the release archiving PlaneGCS', async () => {
    const { root, fetchSource } = await fixture();
    await distributeCadSources(root, fetchSource);
    const page = path.join(root, 'dist/third-party/sketch-solver/index.html');
    expect(await readFile(page, 'utf8')).toContain('https://github.com/Insignifi4nt/brocad-m/releases/tag/planegcs-1.3.0-sources');
    await writeFile(page, 'changed');
    await expect(checkCadSourceDistribution(root)).rejects.toThrow('archived sketch solver page differs');
  });
  it('rejects modified installed artifacts before publishing source downloads', async () => {
    const { root, fetchSource } = await fixture();
    await writeFile(path.join(root, 'node_modules/replicad-opencascadejs/dist/replicad_single.wasm'), 'unpaired kernel');
    await expect(distributeCadSources(root, fetchSource)).rejects.toThrow('size mismatch');
    await expect(readdir(path.join(root, 'dist/third-party/cad'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects corrupt cached sources without replacing original bytes', async () => {
    const { root, manifest, sources, fetchSource } = await fixture();
    const cached = path.join(root, '.cache/third-party-sources', manifest.archives[0].fileName);
    await mkdir(path.dirname(cached), { recursive: true });
    const corrupt = Buffer.alloc(sources[0].byteLength, 1);
    await writeFile(cached, corrupt);
    await expect(distributeCadSources(root, fetchSource)).rejects.toThrow('SHA-256 mismatch');
    expect(await readFile(cached)).toEqual(corrupt);
    await expect(readdir(path.join(root, 'dist/third-party/cad'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
