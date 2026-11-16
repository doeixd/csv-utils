const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dist = join(__dirname, '..', 'dist');
const esmDir = join(dist, 'esm');
mkdirSync(esmDir, { recursive: true });
writeFileSync(join(esmDir, 'package.json'), '{"type":"module"}\n');

// NodeNext resolves declaration files using their package's module type. Keep
// separate ESM declarations and make their relative imports Node-compatible.
const typesDir = join(dist, 'types');
const esmTypesDir = join(typesDir, 'esm');
mkdirSync(esmTypesDir, { recursive: true });
writeFileSync(join(esmTypesDir, 'package.json'), '{"type":"module"}\n');
for (const filename of readdirSync(typesDir)) {
  if (!filename.endsWith('.d.ts')) continue;
  const source = readFileSync(join(typesDir, filename), 'utf8');
  const esm = source
    .replace(/((?:from\s+|import\s*\()\s*["'])(\.\/[^"']+)(["'])/g, (_, prefix, path, quote) => `${prefix}${path}.js${quote}`)
    .replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, '');
  writeFileSync(join(esmTypesDir, filename), esm);
}

// Pridepack regenerates exports during each build; restore conditional types
// for NodeNext while retaining its CommonJS and ESM runtime entry points.
const manifestPath = join(__dirname, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const [entry, base] of [['.', 'index'], ['./headers', 'headers'], ['./standalone', 'standalone']]) {
  const esmTypes = `./dist/types/esm/${base}.d.ts`;
  const cjsTypes = `./dist/types/${base}.d.ts`;
  manifest.exports[entry] = {
    development: {
      import: { types: esmTypes, default: `./dist/esm/development/${base}.js` },
      require: { types: cjsTypes, default: `./dist/cjs/development/${base}.js` },
    },
    import: { types: esmTypes, default: `./dist/esm/production/${base}.js` },
    require: { types: cjsTypes, default: `./dist/cjs/production/${base}.js` },
  };
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
