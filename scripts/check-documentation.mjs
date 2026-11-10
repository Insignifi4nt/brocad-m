import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const base = `${pkg.homepage.replace(/\/$/, '')}/`;
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result;
}
async function exists(url) {
  if (!url.startsWith(base)) return;
  const target = new URL(url);
  const relative = target.pathname.slice(new URL(base).pathname.length);
  const file = path.join('dist', !relative || relative.endsWith('/') ? relative + 'index.html' : relative);
  assert.ok((await stat(file).catch(() => null))?.isFile(), `Broken published link: ${url}`);
  if (target.hash && relative.startsWith('documentation/') && /\.(?:html|md)$/.test(file)) {
    const htmlFile = file.endsWith('.md') ? file.replace(/\.md$/, '.html') : file;
    const dom = new JSDOM(await readFile(htmlFile, 'utf8'));
    try {
      assert.ok(dom.window.document.getElementById(decodeURIComponent(target.hash.slice(1))), `Broken published section link: ${url}`);
    } finally { dom.window.close(); }
  }
}
// Check the entry points as well as documentation: a renamed deployment can
// serve HTML successfully while every script still points at the old path.
for (const entry of ['index.html', '404.html', 'package-tools/index.html']) {
  const dom = new JSDOM(await readFile(path.join('dist', entry), 'utf8'));
  try {
    const assets = dom.window.document.querySelectorAll('script[src], link[rel="stylesheet"], link[rel="modulepreload"]');
    assert.ok(assets.length > 0, `Missing application assets: ${entry}`);
    for (const asset of assets) {
      const url = new URL(asset.getAttribute('src') ?? asset.getAttribute('href'), base + entry).href;
      assert.ok(url.startsWith(base), `Application asset outside deployment base: ${url}`);
      await exists(url);
    }
  } finally { dom.window.close(); }
}
const files = await walk('dist/documentation');
for (const file of files.filter((file) => file.endsWith('.html'))) {
  const dom = new JSDOM(await readFile(file, 'utf8'));
  const document = dom.window.document;
  assert.ok(document.querySelector('main h1'), `No crawlable heading: ${file}`);
  assert.ok(document.querySelector('link[rel="alternate"][type="text/markdown"]'), `Missing Markdown: ${file}`);
  const pageUrl = base + path.relative('dist', file).split(path.sep).join('/');
  for (const link of document.querySelectorAll('[href]')) {
    await exists(new URL(link.getAttribute('href'), pageUrl).href);
  }
  dom.window.close();
}
for (const file of ['dist/llms.txt', 'dist/documentation/llms.txt', ...files.filter((file) => file.endsWith('.md'))]) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\]\((https?:[^\s)]+)\)/g)) await exists(match[1]);
}
const llms = await readFile('dist/llms.txt', 'utf8');
assert.ok(llms.startsWith('# broCAD/M\n'));
assert.ok(llms.includes('/documentation/index.md'));
const sitemap = await readFile('dist/sitemap.xml', 'utf8');
for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) await exists(match[1]);
const published = await readFile('dist/documentation/reference/docs/post-authoring/v1/schema/post-package.schema.json', 'utf8');
assert.equal(published, await readFile('docs/post-authoring/v1/schema/post-package.schema.json', 'utf8'));
console.log(`Documentation verified: static content, discovery, schema parity and local links across ${files.length} files.`);
