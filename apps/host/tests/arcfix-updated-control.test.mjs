import './helpers/isolate-profile.mjs';   // a test run never writes the owner's real Strata profile
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { bundledPython, createControl, findControl } from '../server/control-runtime.mjs';
import { createNativeControl } from '../server/native-control.mjs';

// ARCFIX (0.2.13): a Control-only feed update (`strata update`, or Settings > Updates > Strata) writes <components>/control/active.json.
// The fork keeps explicit and bundled Control authoritative; an updated component is used only when those are unavailable.
const isWin = process.platform === 'win32';
const tmp = () => realpathSync(osTmpdir());

function controlDir(parent, name, version) {
  const dir = join(parent, name);
  mkdirSync(join(dir, 'python', ...(isWin ? [] : ['bin'])), { recursive: true });
  mkdirSync(join(dir, 'strata_control'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'serve'), { recursive: true });
  writeFileSync(bundledPython(dir), 'x');
  writeFileSync(join(dir, 'strata.py'), '# cli');
  writeFileSync(join(dir, 'tools', 'strata_mcp.py'), '# mcp');
  writeFileSync(join(dir, 'setup.py'), '# setup');
  writeFileSync(join(dir, 'serve', 'server.py'), 'port\nparallel\n/v1/responses');
  writeFileSync(join(dir, 'BUNDLE.json'), JSON.stringify({ version }));
  return dir;
}

function fixture() {
  const root = mkdtempSync(join(tmp(), 'strata-arcfix-'));
  const install = join(root, 'install');                          // the AppImage's / installer's folder: <install>/host + <install>/control
  mkdirSync(join(install, 'host'), { recursive: true });
  const bundled = controlDir(install, 'control', '0.1.59');
  const components = join(root, 'components');
  mkdirSync(join(components, 'control'), { recursive: true });
  const updated = controlDir(join(components, 'control'), '0.1.59.1', '0.1.59.1');
  writeFileSync(join(components, 'control', 'active.json'), JSON.stringify({ version: '0.1.59.1', folder: '0.1.59.1', sha256: 'x' }));
  return { root, install, bundled, components, updated, hostDir: join(install, 'host') };
}

test('the fork keeps explicit and bundled Control ahead of a newer upstream component', () => {
  const f = fixture();
  try {
    // the Tauri shell sets STRATA_CONTROL_DIR to the bundled folder (apps/desktop/src-tauri/src/main.rs apply_runtime_policy)
    const viaShell = findControl({ env: { STRATA_CONTROL_DIR: f.bundled }, hostDir: f.hostDir, components: f.components });
    assert.equal(viaShell.dir, f.bundled);
    assert.equal(viaShell.bundle.version, '0.1.59');
    assert.equal(findControl({ env: {}, hostDir: f.hostDir, components: f.components }).dir, f.bundled);
    // An explicit user-supplied Control also wins over both bundled and updated copies.
    const explicit = controlDir(f.root, 'explicit-control', '0.1.58');
    assert.equal(findControl({ env: { STRATA_CONTROL_DIR: explicit }, hostDir: f.hostDir, components: f.components }).dir, explicit);
    // A component at the same version cannot replace the bundled copy either.
    writeFileSync(join(f.updated, 'BUNDLE.json'), JSON.stringify({ version: '0.1.59' }));
    writeFileSync(join(f.components, 'control', 'active.json'), JSON.stringify({ version: '0.1.59', folder: '0.1.59.1' }));
    assert.equal(findControl({ env: { STRATA_CONTROL_DIR: f.bundled }, hostDir: f.hostDir, components: f.components }).dir, f.bundled);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('without bundled or explicit Control, model setup uses the updated component interpreter and source', async () => {
  const f = fixture();
  try {
    rmSync(f.bundled, { recursive: true, force: true });
    const found = findControl({ env: {}, hostDir: f.hostDir, components: f.components });
    const spawned = [];
    const spawnProcess = (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
      child.kill = () => true;
      child.stdin = { write(line) {
        const message = JSON.parse(line); if (!message.id) return;
        const result = message.method === 'tools/list' ? { tools: [{ name: 'strata_status' }] } : { protocolVersion: '2024-11-05' };
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')));
      } };
      return child;
    };
    const data = join(f.root, 'data');
    const control = { ...createControl({ control: found, run: async () => ({}) }),
      async installedModels() { return { install_dir: f.root, models: [] }; },
      async engine() { return { usable: true, backend: 'sycl', engine: { version: '0.1.59', platform: 'linux-x86_64', backend: 'sycl', exe: '/e/strata', root: '/e' } }; } };
    const native = createNativeControl({ control, directory: data, spawnProcess, fetcher: async () => Response.json({}) });
    try { await native.refresh(true); } finally { await native.close(); }
    const installer = spawned.find(s => String(s.args[0]).endsWith('strata_mcp.py'));
    assert.ok(installer, 'the host started the installer process');
    assert.equal(installer.command, bundledPython(f.updated));
    assert.equal(installer.args[0], join(f.updated, 'tools', 'strata_mcp.py'));
    assert.equal(installer.args[installer.args.indexOf('--src') + 1], f.updated);
    assert.equal(installer.options.cwd, f.updated);
    assert.equal(installer.options.env.STRATA_CONTROL_DIR, f.updated);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('reload respects fork precedence and leaves an authoritative bundled Control unchanged', () => {
  const f = fixture();
  try {
    const env = { STRATA_CONTROL_DIR: f.bundled, STRATA_COMPONENTS_DIR: f.components };
    const find = options => findControl({ ...options, hostDir: f.hostDir });
    const control = createControl({ control: find({ env }), env });
    assert.equal(control.reload({ find }), false);
    assert.equal(control.control.dir, f.bundled);
    assert.equal(control.canUpdateControl(), false);
    assert.equal(control.version, '0.1.59');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('reload follows a new whole component when no authoritative Control is available', () => {
  const f = fixture();
  try {
    rmSync(f.bundled, { recursive: true, force: true });
    const env = { STRATA_COMPONENTS_DIR: f.components };
    const find = options => findControl({ ...options, hostDir: f.hostDir });
    const control = createControl({ control: find({ env }), env });
    assert.equal(control.control.dir, f.updated);
    assert.equal(control.canUpdateControl(), true);
    const next = controlDir(join(f.components, 'control'), '0.1.59.2', '0.1.59.2');
    writeFileSync(join(f.components, 'control', 'active.json'), JSON.stringify({ version: '0.1.59.2', folder: '0.1.59.2' }));
    assert.equal(control.reload({ find }), true);
    assert.equal(control.control.dir, next);
    assert.equal(control.control.python, bundledPython(next));
    assert.equal(control.version, '0.1.59.2');
    assert.equal(control.reload({ find }), false);
    // An incomplete newly selected component cannot replace the working one.
    const incomplete = controlDir(join(f.components, 'control'), '0.1.59.3', '0.1.59.3');
    rmSync(bundledPython(incomplete));
    writeFileSync(join(f.components, 'control', 'active.json'), JSON.stringify({ version: '0.1.59.3', folder: '0.1.59.3' }));
    assert.equal(control.reload({ find }), false);
    assert.equal(control.control.dir, next);
    assert.equal(control.version, '0.1.59.2');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
