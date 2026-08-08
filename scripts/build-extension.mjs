import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const extDir = join(root, 'apps/extension');
const iconsDir = join(extDir, 'icons');
const svgPath = join(iconsDir, 'icon.svg');

await esbuild.build({
  entryPoints: [join(extDir, 'src/content.js')],
  bundle: true,
  outfile: join(extDir, 'content.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: false,
});

mkdirSync(iconsDir, { recursive: true });

if (!existsSync(svgPath)) {
  throw new Error(`Missing ${svgPath} — add the ChatLiberate icon.svg before building`);
}

function pngLooksValid(filePath) {
  if (!existsSync(filePath)) return false;
  // The old build wrote a 70-byte 1×1 stub — treat tiny files as corrupt
  return statSync(filePath).size > 100;
}

function rasterizeWithRsvg(size, outPath) {
  const result = spawnSync(
    'rsvg-convert',
    ['-w', String(size), '-h', String(size), svgPath, '-o', outPath],
    { encoding: 'utf8' },
  );
  return result.status === 0 && pngLooksValid(outPath);
}

let rasterized = 0;
for (const size of [16, 48, 128]) {
  const outPath = join(iconsDir, `icon${size}.png`);
  if (rasterizeWithRsvg(size, outPath)) {
    rasterized++;
    continue;
  }
  if (pngLooksValid(outPath)) {
    console.warn(`rsvg-convert unavailable — keeping existing icon${size}.png`);
    continue;
  }
  throw new Error(
    `Could not build icons/icon${size}.png. Install librsvg (brew install librsvg) or restore the PNG from git.`,
  );
}

console.log(
  `Extension bundled → apps/extension/content.js` +
    (rasterized ? ` (icons regenerated from icon.svg)` : ''),
);
