// Gives a linked git worktree a node_modules of links into the main checkout's install, without
// installing or writing anything in the shared install, and removes those links again before the
// worktree is deleted. Workspace packages (@wire-edm/*) link to the worktree's own packages/.
//
//   node scripts/worktree-modules.mjs link     run inside the worktree; then `npm run icons:build`
//   node scripts/worktree-modules.mjs unlink   run inside the worktree before deleting it
//   node scripts/worktree-modules.mjs status   list the links without changing anything
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const command = process.argv[2];
const root = path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const mainRoot = path.resolve(
  execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .find((line) => line.startsWith('worktree '))
    .slice('worktree '.length)
    .trim(),
);
const shared = path.join(mainRoot, 'node_modules');
const local = path.join(root, 'node_modules');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

const isLink = (target) => {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

// Removes a link alone. Neither call follows the link, so the folder it points to is untouched.
const removeLink = (target) => {
  try {
    fs.unlinkSync(target);
  } catch {
    fs.rmdirSync(target);
  }
};

// Every link under a folder, found by walking real directories only: a link is listed, never entered.
const linksIn = (folder) => {
  const found = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) found.push(full);
      else if (stat.isDirectory()) walk(full);
    }
  };
  if (fs.existsSync(folder) && !isLink(folder)) walk(folder);
  return found;
};

const comparable = (target) => {
  // Windows may report a junction target with the \\?\ long-path prefix, or \\?\UNC\ for a share.
  const resolved = path.resolve(target.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const pointsAt = (link, target) => comparable(path.resolve(path.dirname(link), fs.readlinkSync(link))) === comparable(target);

// A folder that must be a real local directory: a link in its place is removed first, so nothing
// is ever created through it inside another install.
const ensureRealDirectory = (dir) => {
  if (isLink(dir)) removeLink(dir);
  fs.mkdirSync(dir, { recursive: true });
};

if (root === mainRoot) {
  console.error('Run this inside a linked worktree, not the main checkout.');
  process.exit(1);
}

if (command === 'link') {
  if (!fs.existsSync(shared)) {
    console.error(`The main checkout has no install at ${shared}.`);
    process.exit(1);
  }
  // A worktree may start with node_modules as one link to the shared install: replace it.
  ensureRealDirectory(local);
  let linked = 0;
  for (const name of fs.readdirSync(shared)) {
    if (name.startsWith('.vite') || name === '.tmp' || name === '.cache') continue;
    const from = path.join(shared, name);
    const scope = name.startsWith('@') && fs.statSync(from).isDirectory();
    const names = scope ? fs.readdirSync(from).map((child) => path.join(name, child)) : [name];
    if (scope) ensureRealDirectory(path.join(local, name));
    for (const entry of names) {
      const to = path.join(local, entry);
      const own = entry.startsWith(`@wire-edm${path.sep}`) ? path.join(root, 'packages', path.basename(entry)) : null;
      const source = own && fs.existsSync(own) ? own : path.join(shared, entry);
      if (isLink(to)) {
        // An existing link stays only if it already points where this run would point it.
        if (pointsAt(to, source)) continue;
        removeLink(to);
      } else if (fs.existsSync(to)) {
        if (own) {
          console.error(`${to} is a real folder or file, not a link to ${source}. Remove it and run link again.`);
          process.exit(1);
        }
        continue;
      }
      if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, to, linkType);
      else fs.copyFileSync(source, to);
      linked += 1;
    }
  }
  console.log(`Linked ${linked} entries into ${local}. Run \`npm run icons:build\` next.`);
} else if (command === 'unlink') {
  if (isLink(local)) {
    removeLink(local);
    console.log('Removed the node_modules link.');
  } else {
    const links = linksIn(local);
    for (const link of links) removeLink(link);
    const left = linksIn(local).length;
    console.log(`Removed ${links.length} links; ${left} left.`);
    if (left > 0) process.exit(1);
  }
} else if (command === 'status') {
  console.log(isLink(local) ? 'node_modules is one link to the shared install.' : `${linksIn(local).length} links in ${local}.`);
} else {
  console.error('Usage: node scripts/worktree-modules.mjs link | unlink | status');
  process.exit(1);
}
