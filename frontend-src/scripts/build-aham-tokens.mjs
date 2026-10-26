import fs from 'node:fs';
const directory = new URL('../src/styles/aham/', import.meta.url);
const tokens = JSON.parse(fs.readFileSync(new URL('tokens.json', directory), 'utf8'));
function resolve(value) {
  return String(value).replace(/\{([^}]+)\}/g, (_, path) => resolve(path.split('.').reduce((object, key) => object[key], tokens).$value));
}
function declarations(group) {
  return Object.entries(group).filter(([, token]) => token?.$value !== undefined)
    .map(([key, token]) => '  --wb-' + key + ': ' + resolve(token.$value) + ';').join('\n');
}
const common = Object.entries(tokens).filter(([key]) => !['color', '$meta'].includes(key))
  .map(([, group]) => declarations(group)).filter(Boolean).join('\n');
const css = '/* Generated from Aham UI 9.1.0, commit 464daa3. Run node scripts/build-aham-tokens.mjs. */\n'
  + "@font-face { font-family: 'Inter Variable'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('/fonts/InterVariable.woff2') format('woff2'); }\n"
  + ':root {\n' + common + '\n' + declarations(tokens.color.light) + '\n  color-scheme: light;\n}\n'
  + ':root.dark {\n' + declarations(tokens.color.dark) + '\n  color-scheme: dark;\n}\n'
  + '@media (prefers-contrast: more) {\n  :root {\n' + declarations(tokens.color['contrast-more'].light)
  + '\n  }\n  :root.dark {\n' + declarations(tokens.color['contrast-more'].dark) + '\n  }\n}\n';
const destination = new URL('tokens.css', directory);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== css) throw Error('Aham tokens.css is stale');
} else fs.writeFileSync(destination, css);
