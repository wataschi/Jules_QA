import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGETS = [
  'node_modules/@midscene/core/dist/lib/ai-model/common.js',
  'node_modules/@midscene/core/dist/es/ai-model/common.mjs',
];

const MARKER = "if ('Sleep' === verb)";

const PATCH_CJS = `        if ('Sleep' === verb) {
            var _plan_param;
            flow.push({
                sleep: (null == (_plan_param = plan.param) ? void 0 : _plan_param.timeMs) || 3000
            });
            continue;
        }
        `;

const PATCH_ESM = `        if ('Sleep' === verb) {
            flow.push({
                sleep: plan.param?.timeMs || 3000
            });
            continue;
        }
        `;

function patchFile(relativePath, patchBlock) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-midscene-sleep] skip (missing): ${relativePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(MARKER)) {
    console.log(`[patch-midscene-sleep] already patched: ${relativePath}`);
    return;
  }

  const needle = '        const verb = plan.type;\n        const action = actionSpace.find';
  if (!content.includes(needle)) {
    console.warn(`[patch-midscene-sleep] pattern not found: ${relativePath}`);
    return;
  }

  fs.writeFileSync(
    filePath,
    content.replace(needle, `        const verb = plan.type;\n${patchBlock}const action = actionSpace.find`),
  );
  console.log(`[patch-midscene-sleep] patched: ${relativePath}`);
}

patchFile(TARGETS[0], PATCH_CJS);
patchFile(TARGETS[1], PATCH_ESM);
