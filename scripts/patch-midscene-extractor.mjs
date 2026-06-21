import fs from 'node:fs';
import path from 'node:path';

/**
 * Patch Midscene's injected DOM extractor to cap recursion depth.
 *
 * Midscene injects a browser-side script (stored as a string literal inside
 * `@midscene/shared/.../node/fs`) whose `extractTreeNode` walks the DOM with a
 * recursive `dfs`. On very deeply nested pages (heavy SPAs such as
 * data.kyivcity.gov.ua dataset pages) the recursion overflows the browser's JS
 * stack: `RangeError: Maximum call stack size exceeded`, which aborts
 * `getUIContext` and hangs/fails the whole run.
 *
 * We add a depth guard (closure counter) so the walk stops descending past a
 * safe depth. Interactive targets are never that deep, so grounding is
 * unaffected; the guard only prunes pathologically deep wrapper chains and, as
 * a side effect, speeds up extraction on huge DOMs.
 */

const ROOT = process.cwd();
const TARGETS = [
  'node_modules/@midscene/shared/dist/es/node/fs.mjs',
  'node_modules/@midscene/shared/dist/lib/node/fs.js',
];

const MARKER = '__mdDepth';
const MAX_DEPTH = 500;

/** @type {Array<{ name: string; re: RegExp; replace: string }>} */
const EDITS = [
  {
    name: 'declare-counter',
    re: /(const topChildren = \[\];\\n\s*)(function dfs\()/,
    replace: `$1let __mdDepth = 0;\\n        $2`,
  },
  {
    name: 'depth-guard',
    re: /(const rect = getRect\(node, baseZoom, currentWindow\);\\n\s*)(for\(let i = 0; i < node\.childNodes\.length; i\+\+\)\{)/,
    replace: `$1if (__mdDepth++ > ${MAX_DEPTH}) { __mdDepth--; return nodeInfo.node ? nodeInfo : (nodeInfo.children.length ? nodeInfo.children : null); }\\n                $2`,
  },
  {
    name: 'decrement',
    re: /(else if \(childNodeInfo\) nodeInfo\.children\.push\(childNodeInfo\);\\n\s*\}\\n\s*)(if \(null === nodeInfo\.node\) \{)/,
    replace: `$1__mdDepth--;\\n                $2`,
  },
];

function patchFile(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-midscene-extractor] skip (missing): ${relativePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(MARKER)) {
    console.log(`[patch-midscene-extractor] already patched: ${relativePath}`);
    return;
  }

  let applied = 0;
  for (const edit of EDITS) {
    if (!edit.re.test(content)) {
      console.warn(`[patch-midscene-extractor] pattern not found (${edit.name}): ${relativePath}`);
      continue;
    }
    content = content.replace(edit.re, edit.replace);
    applied += 1;
  }

  if (applied === EDITS.length) {
    fs.writeFileSync(filePath, content);
    console.log(`[patch-midscene-extractor] patched: ${relativePath}`);
  } else {
    console.warn(
      `[patch-midscene-extractor] partial/no patch (${applied}/${EDITS.length}); left untouched: ${relativePath}`,
    );
  }
}

for (const target of TARGETS) {
  patchFile(target);
}
