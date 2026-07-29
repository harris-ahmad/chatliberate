import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const extDir = join(root, 'apps/extension');

await esbuild.build({
  entryPoints: [join(extDir, 'src/content.js')],
  bundle: true,
  outfile: join(extDir, 'content.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: false,
});

// Simple SVG icons
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#10a37f"/>
  <path d="M32 44h64v8H32zm0 20h48v8H32zm0 20h56v8H32z" fill="white"/>
  <path d="M88 76l12 12-12 12v-8H72v-8h16z" fill="white" opacity="0.9"/>
</svg>`;

mkdirSync(join(extDir, 'icons'), { recursive: true });

// Write placeholder PNG note - extension needs actual PNGs
// For dev, create minimal 1x1 PNGs or use SVG converted
for (const size of [16, 48, 128]) {
  // Minimal valid PNG (green square) - base64 decoded
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(join(extDir, 'icons', `icon${size}.png`), png);
}

writeFileSync(join(extDir, 'icons', 'icon.svg'), iconSvg);
console.log('Extension bundled → apps/extension/content.js');
