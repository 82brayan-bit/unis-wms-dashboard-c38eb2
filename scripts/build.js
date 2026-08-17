'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const TEXT_EXTENSIONS = new Set(['.html','.css','.js','.json','.svg','.txt','.md']);

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

function hashedName(relativePath, buffer) {
  const extension = path.extname(relativePath);
  const stem = relativePath.slice(0, -extension.length);
  return stem + '.' + hash(buffer) + extension;
}

function write(relativePath, buffer, manifest, sourcePath) {
  const target = path.join(DIST, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, buffer);
  if (sourcePath) manifest[sourcePath] = '/' + relativePath.replaceAll(path.sep, '/');
}

function compressFile(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return;
  const target = path.join(DIST, relativePath);
  const source = fs.readFileSync(target);
  fs.writeFileSync(target + '.gz', zlib.gzipSync(source, {level:9}));
  fs.writeFileSync(target + '.br', zlib.brotliCompressSync(source, {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}));
}

function replacePaths(contents, manifest) {
  return contents.replace(/\/assets\/[A-Za-z0-9_./-]+/g, value => manifest[value] || value);
}

async function minifyJavaScript(source, sourcePath, identifiers) {
  return (await esbuild.transform(source, {
    loader:'js', target:['es2020'], minifySyntax:true,
    minifyWhitespace:true, minifyIdentifiers:identifiers, legalComments:'none', sourcefile:sourcePath
  })).code;
}

async function minifyModule(source, sourcePath) {
  return (await esbuild.transform(source, {
    loader:'js', format:'esm', target:['es2020'], minify:true,
    treeShaking:true, legalComments:'none', sourcefile:sourcePath
  })).code;
}

async function main() {
  fs.rmSync(DIST, {recursive:true, force:true});
  fs.mkdirSync(DIST, {recursive:true});
  const manifest = {};

  const dataDir = path.join(PUBLIC, 'assets/data/facilities');
  for (const filename of fs.readdirSync(dataDir).filter(name => name.endsWith('.js')).sort()) {
    const sourcePath = '/assets/data/facilities/' + filename;
    const output = Buffer.from(await minifyModule(fs.readFileSync(path.join(dataDir, filename), 'utf8'), sourcePath));
    write(hashedName('assets/data/facilities/' + filename, output), output, manifest, sourcePath);
  }

  for (const directory of ['brand','fonts','icons']) {
    const sourceDir = path.join(PUBLIC, 'assets', directory);
    for (const filename of fs.readdirSync(sourceDir).sort()) {
      const sourcePath = '/assets/' + directory + '/' + filename;
      const buffer = fs.readFileSync(path.join(sourceDir, filename));
      write(hashedName('assets/' + directory + '/' + filename, buffer), buffer, manifest, sourcePath);
    }
  }

  // Vendored third-party assets (Leaflet): JS/CSS are hashed for long-lived
  // caching, images are copied verbatim so the stylesheet's relative url()
  // references keep resolving. The GIS renderer loads them lazily via the
  // manifest-resolved hashed names.
  const vendorDir = path.join(PUBLIC, 'assets/vendor');
  function copyVendor(relative) {
    const full = path.join(vendorDir, relative);
    for (const entry of fs.readdirSync(full, {withFileTypes:true})) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) { copyVendor(rel); continue; }
      const sourcePath = '/assets/vendor/' + rel.replaceAll(path.sep, '/');
      const buffer = fs.readFileSync(path.join(vendorDir, rel));
      if (entry.name.endsWith('.js') || entry.name.endsWith('.css')) {
        write(hashedName('assets/vendor/' + rel.replaceAll(path.sep, '/'), buffer), buffer, manifest, sourcePath);
      } else {
        write('assets/vendor/' + rel.replaceAll(path.sep, '/'), buffer, manifest, sourcePath);
      }
    }
  }
  if (fs.existsSync(vendorDir)) copyVendor('.');


  const jsDir = path.join(PUBLIC, 'assets/js');
  const jsFiles = fs.readdirSync(jsDir).filter(name => name.endsWith('.js') && name !== 'facility-customer-locations.js').sort();
  // Pass 1: minify every JS file and register its hashed name so cross-file
  // references (e.g. dashboard-modules.js → the lazy gis-official-map chunk)
  // resolve during pass 2 regardless of alphabetical processing order.
  const minifyIdentifiersFor = filename => filename === 'theme.js' || filename === 'facility-data-loader.js';
  const nameMap = {};
  for (const filename of jsFiles) {
    const sourcePath = '/assets/js/' + filename;
    const output = Buffer.from(await minifyJavaScript(fs.readFileSync(path.join(jsDir, filename), 'utf8'), sourcePath, minifyIdentifiersFor(filename)));
    nameMap[sourcePath] = hashedName('assets/js/' + filename, output);
  }
  // Pass 2: rewrite manifest paths, minify again, and settle cross-file
  // references on their FINAL hashed names. Two iterations are enough: a
  // chunk that references another chunk (dashboard-modules.js → the lazy
  // gis-official-map.js) changes hash when the referenced name settles, but
  // the referenced chunk itself only depends on stable vendor/assets names.
  const finalNames = Object.assign({}, nameMap);
  for (let iteration = 0; iteration < 2; iteration++) {
    const resolutionManifest = Object.assign({}, manifest, finalNames);
    const next = {};
    for (const filename of jsFiles) {
      const sourcePath = '/assets/js/' + filename;
      let source = replacePaths(fs.readFileSync(path.join(jsDir, filename), 'utf8'), resolutionManifest);
      if (filename === 'facility-data-loader.js') {
        for (const [input, output] of Object.entries(resolutionManifest)) {
          if (input.startsWith('/assets/data/facilities/')) source = source.replaceAll(input.split('/').pop(), output.split('/').pop());
        }
      }
      const output = Buffer.from(await minifyJavaScript(source, sourcePath, minifyIdentifiersFor(filename)));
      next[sourcePath] = hashedName('assets/js/' + filename, output);
    }
    Object.assign(finalNames, next);
  }
  // Write the final files with the settled names.
  for (const filename of jsFiles) {
    const sourcePath = '/assets/js/' + filename;
    const resolutionManifest = Object.assign({}, manifest, finalNames);
    let source = replacePaths(fs.readFileSync(path.join(jsDir, filename), 'utf8'), resolutionManifest);
    if (filename === 'facility-data-loader.js') {
      for (const [input, output] of Object.entries(resolutionManifest)) {
        if (input.startsWith('/assets/data/facilities/')) source = source.replaceAll(input.split('/').pop(), output.split('/').pop());
      }
    }
    const output = Buffer.from(await minifyJavaScript(source, sourcePath, minifyIdentifiersFor(filename)));
    write(hashedName('assets/js/' + filename, output), output, manifest, sourcePath);
  }

  const cssDir = path.join(PUBLIC, 'assets/css');
  for (const filename of fs.readdirSync(cssDir).filter(name => name.endsWith('.css')).sort()) {
    const sourcePath = '/assets/css/' + filename;
    const source = replacePaths(fs.readFileSync(path.join(cssDir, filename), 'utf8'), manifest);
    const output = Buffer.from((await esbuild.transform(source, {loader:'css',minify:true,legalComments:'none',sourcefile:sourcePath})).code);
    write(hashedName('assets/css/' + filename, output), output, manifest, sourcePath);
  }

  const html = replacePaths(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), manifest);
  write('index.html', Buffer.from(html));
  write('asset-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

  const builtFiles = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (!entry.name.endsWith('.gz') && !entry.name.endsWith('.br')) builtFiles.push(path.relative(DIST, full));
    }
  }
  collect(DIST);
  builtFiles.forEach(compressFile);
  process.stdout.write('Built ' + builtFiles.length + ' production files in dist/.\n');
}

main().catch(error => { console.error(error); process.exit(1); });
