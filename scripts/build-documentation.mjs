import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';

const root = process.cwd();
const destination = path.join(root, 'dist');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const origin = 'https://brocad-m.visionforge.cc';
const base = '/';
const docs = `${base}documentation/`;
const repository = `https://github.com/Insignifi4nt/brocad-m/blob/v${pkg.version}/`;
const guides = ['index', 'cad', 'simulation', 'authoring', 'tools', 'agents', 'compatibility', 'reference', 'releases'];
const titles = ['Start here', 'CAD design', 'Saved-process simulation', 'Author a package', 'Package workbench', 'Agent tools', 'Compatibility & repairs', 'Contract reference', 'App releases'];
const routes = new Map(guides.map((slug) => [`docs/site/${slug}.md`, `${docs}${slug === 'index' ? '' : slug + '/'}index.md`]));
const htmlUrls = [];
const escape = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walk(file));
    else result.push(file);
  }
  return result;
}
for (const directory of ['docs/post-authoring/v1', 'docs/upid/v1', 'docs/upid/v2', 'docs/upid/v3']) {
  for (const file of await walk(directory)) routes.set(file, `${docs}reference/${file}`);
}
async function output(url, content) {
  if (!url.startsWith(base) || url.includes('..')) throw new Error(`Invalid documentation output path: ${url}`);
  const file = path.join(destination, url.slice(base.length));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
function links(markdown, source, html) {
  return markdown.replace(/\]\(([^\s)]+)\)/g, (_, target) => {
    if (/^(?:https?:|mailto:|#)/.test(target)) return `](${html && target.startsWith(origin + base) ? target.slice(origin.length) : target})`;
    const [file, fragment] = target.split('#');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
    let url = routes.get(resolved) ?? `${repository}${resolved}`;
    if (html && url.endsWith('.md') && routes.has(resolved)) url = url.replace(/\.md$/, '.html');
    return `](${html ? url : originIfLocal(url)}${fragment ? '#' + fragment : ''})`;
  });
}
const originIfLocal = (url) => url.startsWith('/') ? origin + url : url;
function renderMarkdown(markdown) {
  const renderer = new marked.Renderer();
  const usedIds = new Set();
  renderer.heading = function ({ tokens, depth, text }) {
    const baseId = text.toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    let id = baseId;
    for (let suffix = 1; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    return `<h${depth} id="${escape(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
  };
  return marked.parse(markdown, { renderer });
}
function page(title, body, htmlUrl, markdownUrl) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · broCAD/M</title><meta name="description" content="broCAD/M guides: saved-UPID simulation, browser agent tools, complete machine packages, postprocessor authoring and compatibility."><link rel="canonical" href="${origin}${htmlUrl}"><link rel="alternate" type="text/markdown" href="${markdownUrl}"><link rel="describedby" href="${base}llms.txt"><link rel="stylesheet" href="${docs}style.css"></head>
<body><a class="skip" href="#content">Skip to content</a><header><a href="${base}" class="brand">broCAD/M</a><span>Documentation · ${escape(pkg.version)}</span></header><div class="layout"><nav aria-label="Documentation">${guides.map((slug, index) => `<a href="${docs}${slug === 'index' ? '' : slug + '/'}">${titles[index]}</a>`).join('')}<hr><a href="${base}llms.txt">Agent index · llms.txt</a><a href="${docs}releases/${pkg.version}/">Release ${escape(pkg.version)}</a><a href="https://github.com/Insignifi4nt/brocad-m">Source on GitHub</a></nav><main id="content"><div class="page-tools"><a href="${markdownUrl}">Read as Markdown</a></div>${body}<footer>App ${escape(pkg.version)} · Exact machine evidence and validated output govern compatibility.</footer></main></div></body></html>`;
}
for (const [source, url] of routes) {
  const contents = await readFile(source);
  if (!source.endsWith('.md')) { await output(url, contents); continue; }
  const markdown = contents.toString('utf8');
  const title = markdown.match(/^# (.+)/m)?.[1] ?? path.basename(source);
  const htmlUrl = url.replace(/\.md$/, '.html');
  // Content is repository-authored, never rendered from user packages or diagnostics.
  await output(url, links(markdown, source, false));
  await output(htmlUrl, page(title, renderMarkdown(links(markdown, source, true)), htmlUrl, url));
  htmlUrls.push(origin + htmlUrl);
}
const releaseFiles = (await walk('docs/releases')).filter((file) => file.endsWith('.json'));
const releases = [];
for (const file of releaseFiles) {
  const release = JSON.parse(await readFile(file, 'utf8'));
  const published = { version: release.version, previousVersion: release.previousVersion, ...release.publicNotes };
  releases.push(published);
  const directory = `${docs}releases/${release.version}/`;
  const markdown = `# App ${release.version}\n\n${published.summary}\n\n## Changes\n\n${published.changes.map((change) => `- ${change}`).join('\n')}\n\n## Compatibility\n\n${published.compatibility}\n\n## Updating a package\n\n${published.action}\n\n[Versioned authoring contract](https://github.com/Insignifi4nt/brocad-m/tree/v${release.version}/docs/post-authoring/v1)\n`;
  await output(directory + 'index.md', markdown);
  await output(directory + 'index.html', page(`App ${release.version}`, renderMarkdown(markdown), directory + 'index.html', directory + 'index.md'));
  await output(directory + 'release.json', JSON.stringify(published, null, 2) + '\n');
  htmlUrls.push(origin + directory + 'index.html');
}
await output(docs + 'releases.json', JSON.stringify({ currentVersion: pkg.version, releases }, null, 2) + '\n');
const llms = `# broCAD/M\n\n> Build evidence-based, complete machine packages for a controller-neutral UPID workbench. Current app: ${pkg.version}.\n\nNew posts use schema v2 and engine API 1. App versions, format schemas and physical-machine verification are distinct. Start with the guide; fetch the reference files you need.\n\n## Guides\n\n${guides.map((slug, index) => `- [${titles[index]}](${origin}${routes.get(`docs/site/${slug}.md`)}): ${index === 0 ? 'Start here with no prior context.' : titles[index] + '.'}`).join('\n')}\n\n## Contracts\n\n- [Supported contracts](${origin}${docs}reference/docs/post-authoring/v1/compatibility.json): Generated from the application schema.\n- [Guest SDK](${origin}${docs}reference/docs/post-authoring/v1/sdk/wire-edm-post-sdk.d.ts): Exact event payloads and API.\n- [Release ledger](${origin}${docs}releases.json): Compatibility warnings and recorded test scope.\n`;
await output(base + 'llms.txt', llms);
await output(docs + 'llms.txt', llms);
await output(base + 'sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${htmlUrls.map((url) => `<url><loc>${escape(url)}</loc></url>`).join('')}</urlset>\n`);
await output(docs + 'style.css', await readFile('docs/site/style.css'));
console.log(`Built ${htmlUrls.length} static documentation pages, Markdown, contracts and discovery files.`);
