'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseYaml } = require('../scripts/node/lib/yaml');

const ROOT = path.resolve(__dirname, '..');
const GEM_CLI_PACK_DIR = path.join(ROOT, 'workflow', 'packs', 'gem-cli');
const GEM_CLI_PACK_FILES = [
  'README.md',
  'pack.yaml',
  'protected-surfaces.yaml',
  'validation-matrix.yaml',
  'runtime-hub-rules.yaml',
  'context-hygiene.yaml',
];

function runCommand(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
}

function assertSuccess(result, context) {
  assert.equal(
    result.status,
    0,
    `${context}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function parseJsonOutput(result, context) {
  const stdout = String(result.stdout || '').trim();
  assert.notEqual(stdout, '', `${context}: expected JSON output`);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    assert.fail(
      `${context}: failed to parse JSON output\nstdout:\n${stdout}\nerror: ${error.message}`,
    );
  }
}

function writeFile(repoRoot, relativePath, contents) {
  const target = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(target), {
    recursive: true,
  });
  fs.writeFileSync(target, contents, 'utf8');
}

function createInstalledRepo(installArgs = []) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refactorflow-'));
  const repoRoot = path.join(sandboxRoot, 'sample-target');
  fs.mkdirSync(repoRoot, {
    recursive: true,
  });

  assertSuccess(runCommand('git', ['init', '-b', 'main', repoRoot], ROOT), 'git init');
  assertSuccess(
    runCommand('git', ['config', 'user.email', 'tests@example.com'], repoRoot),
    'git config user.email',
  );
  assertSuccess(
    runCommand('git', ['config', 'user.name', 'RefactorFlow Tests'], repoRoot),
    'git config user.name',
  );
  assertSuccess(
    runCommand(
      path.join(ROOT, 'scripts', 'install-workflow-kit'),
      ['--target', repoRoot, '--repo-name', 'sample-target', ...installArgs],
      ROOT,
    ),
    'install workflow kit',
  );
  assertSuccess(runCommand('git', ['add', '.'], repoRoot), 'git add initial');
  assertSuccess(
    runCommand('git', ['commit', '-m', 'initial kit snapshot'], repoRoot),
    'git commit initial',
  );

  return repoRoot;
}

function runWorkflow(repoRoot, args) {
  return runCommand(path.join(repoRoot, 'scripts', 'workflow'), args, repoRoot);
}

function packageBin(projectRoot, name) {
  return path.join(projectRoot, 'node_modules', '.bin', name);
}

function appendProtectedSurface(repoRoot, name) {
  const protectedSurfacesPath = path.join(
    repoRoot,
    'workflow',
    'policy',
    'protected-surfaces.yaml',
  );
  const current = fs.readFileSync(protectedSurfacesPath, 'utf8');
  fs.writeFileSync(
    protectedSurfacesPath,
    current.replace(
      '\nrules:\n',
      `\n  - name: ${name}\n    protection: change-with-review\n    rationale: Test-only protected surface pattern.\n\nrules:\n`,
    ),
    'utf8',
  );
  assertSuccess(
    runCommand('git', ['add', 'workflow/policy/protected-surfaces.yaml'], repoRoot),
    'git add protected surface pattern',
  );
  assertSuccess(
    runCommand('git', ['commit', '-m', `protect ${name}`], repoRoot),
    'git commit protected surface pattern',
  );
}

function readPackYaml(fileName, baseDir = GEM_CLI_PACK_DIR) {
  return parseYaml(fs.readFileSync(path.join(baseDir, fileName), 'utf8'));
}

test('npm pack has a narrow package surface and installs into a temp repo', { timeout: 120000 }, () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refactorflow-pack-'));
  const packDir = path.join(sandboxRoot, 'packs');
  const consumerRoot = path.join(sandboxRoot, 'consumer');
  const targetRoot = path.join(sandboxRoot, 'packed-target');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });

  const pack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], ROOT);
  assertSuccess(pack, 'npm pack');
  const packPayload = parseJsonOutput(pack, 'npm pack');
  assert.equal(Array.isArray(packPayload), true, 'npm pack should emit an array payload');
  const packInfo = packPayload[0];
  const packedPaths = packInfo.files.map((entry) => entry.path);

  assert.equal(packedPaths.includes('refactorflow-0.1.0.tgz'), false);
  assert.equal(packedPaths.some((entry) => entry.startsWith('.github/')), false);
  assert.equal(packedPaths.some((entry) => entry.startsWith('test/')), false);
  assert.ok(packedPaths.includes('scripts/node/install-workflow-kit.js'));
  assert.ok(packedPaths.includes('scripts/node/lib/workflow-kit.js'));
  assert.ok(packedPaths.includes('workflow/manifest.yaml'));
  assert.ok(packedPaths.includes('workflow/packs/gem-cli/pack.yaml'));
  assert.ok(packedPaths.includes('workflow/packs/gem-cli/validation-matrix.yaml'));

  assertSuccess(runCommand('npm', ['init', '-y'], consumerRoot), 'npm init consumer');
  assertSuccess(
    runCommand(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        path.join(packDir, packInfo.filename),
      ],
      consumerRoot,
    ),
    'npm install packed tarball',
  );

  assertSuccess(runCommand('git', ['init', '-b', 'main', targetRoot], ROOT), 'git init packed target');
  assertSuccess(
    runCommand(packageBin(consumerRoot, 'install-refactorflow'), [
      '--target',
      targetRoot,
      '--repo-name',
      'packed-target',
    ], consumerRoot),
    'install-refactorflow from packed tarball',
  );

  assertSuccess(runWorkflow(targetRoot, ['help', '--json']), 'packed workflow help');
  assertSuccess(runWorkflow(targetRoot, ['bootstrap', '--json']), 'packed workflow bootstrap');
  assertSuccess(runWorkflow(targetRoot, ['status', '--json']), 'packed workflow status');
});

test('gem-cli pack files are present, parseable, and copied by installer', () => {
  const pack = readPackYaml('pack.yaml');
  const protectedSurfaces = readPackYaml('protected-surfaces.yaml');
  const validationMatrix = readPackYaml('validation-matrix.yaml');
  const runtimeHubRules = readPackYaml('runtime-hub-rules.yaml');
  const contextHygiene = readPackYaml('context-hygiene.yaml');

  assert.equal(pack.pack.id, 'gem-cli');
  assert.equal(pack.pack.installer_support.copied_by_current_installer, true);
  assert.equal(pack.pack.installer_support.auto_applies_policy, true);
  assert.deepEqual(
    protectedSurfaces.surfaces.map((entry) => entry.name),
    [
      'program.md',
      'results.tsv',
      'baseline/**',
      'harness/**',
      'scripts/autoresearch/**',
      'docs/refactor/**',
    ],
  );
  assert.equal(validationMatrix.commands.root_build.command, 'npm run build');
  assert.equal(
    validationMatrix.commands.core_build.command,
    'npm run build --workspace @google/gemini-cli-core',
  );
  assert.equal(validationMatrix.commands.auth_smoke_oauth.required, false);
  assert.equal(
    runtimeHubRules.runtime_hub.primary_file,
    'packages/core/src/tools/tools.ts',
  );
  assert.ok(
    runtimeHubRules.discard_criteria.some((entry) =>
      entry.includes('Circular import count increases'),
    ),
  );
  assert.equal(
    contextHygiene.archive_policy.historical_slice_detail,
    'ledger-or-archive',
  );

  const repoRoot = createInstalledRepo();
  const installedPackDir = path.join(repoRoot, 'workflow', 'packs', 'gem-cli');
  for (const fileName of GEM_CLI_PACK_FILES) {
    assert.ok(
      fs.existsSync(path.join(installedPackDir, fileName)),
      `expected installed pack file ${fileName}`,
    );
  }
  assert.equal(readPackYaml('pack.yaml', installedPackDir).pack.id, 'gem-cli');
});

test('install --pack gem-cli activates harness protection', () => {
  const repoRoot = createInstalledRepo(['--pack', 'gem-cli']);
  const protectedSurfaces = parseYaml(
    fs.readFileSync(
      path.join(repoRoot, 'workflow', 'policy', 'protected-surfaces.yaml'),
      'utf8',
    ),
  );

  assert.ok(
    protectedSurfaces.surfaces.some((entry) => entry.name === 'harness/**'),
  );

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'harness',
      '--hypothesis',
      'Pack protected harness changes require approval',
      '--json',
    ]),
    'begin-slice harness protected by pack',
  );

  writeFile(repoRoot, 'harness/generated.txt', 'test-only\n');
  assertSuccess(
    runCommand('git', ['add', 'harness/generated.txt'], repoRoot),
    'git add harness generated file',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit harness protected by pack');

  assert.deepEqual(payload.changedFiles.outOfScopeFiles, []);
  assert.deepEqual(payload.changedFiles.protectedSurfaceFiles, ['harness/generated.txt']);
  assert.deepEqual(payload.changedFiles.unapprovedProtectedSurfaceFiles, ['harness/generated.txt']);
});

test('precommit protected-surface block does not report docs stale from auto-block mutation', () => {
  const repoRoot = createInstalledRepo(['--pack', 'gem-cli']);

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'harness',
      '--hypothesis',
      'Harness edits are protected by the gem-cli pack',
      '--json',
    ]),
    'begin-slice harness protected regression',
  );
  assertSuccess(runWorkflow(repoRoot, ['refresh', '--json']), 'refresh before protected precommit');

  writeFile(repoRoot, 'harness/run-config.json', '{"testOnly": true}\n');

  const result = runWorkflow(repoRoot, ['precommit', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit protected auto-block freshness');

  assert.equal(payload.primary_failure.kind, 'protected_surface');
  assert.deepEqual(payload.primary_failure.files, ['harness/run-config.json']);
  assert.equal(payload.session.session.current_state, 'blocked');
  assert.deepEqual(payload.changedFiles.unapprovedProtectedSurfaceFiles, [
    'harness/run-config.json',
  ]);
  assert.equal(payload.generatedDocs.freshness.allMatch, true);
  assert.equal(
    payload.failed_items.includes('Generated docs are up to date'),
    false,
  );
  assert.doesNotMatch(payload.notes.join('\n'), /Generated docs appear stale/);
});

test('install --pack gem-cli activates validation commands and metadata', () => {
  const repoRoot = createInstalledRepo(['--pack', 'gem-cli']);
  const validationMatrix = parseYaml(
    fs.readFileSync(
      path.join(repoRoot, 'workflow', 'policy', 'validation-matrix.yaml'),
      'utf8',
    ),
  );
  const manifest = parseYaml(
    fs.readFileSync(path.join(repoRoot, 'workflow', 'manifest.yaml'), 'utf8'),
  );
  const runtimeHubs = parseYaml(
    fs.readFileSync(
      path.join(repoRoot, 'workflow', 'policy', 'runtime-hubs.yaml'),
      'utf8',
    ),
  );

  assert.equal(
    validationMatrix.pack_validation_commands['gem-cli'].root_build.command,
    'npm run build',
  );
  assert.equal(
    validationMatrix.pack_validation_commands['gem-cli'].core_build.command,
    'npm run build --workspace @google/gemini-cli-core',
  );
  assert.equal(
    validationMatrix.pack_validation_commands['gem-cli'].circular_import_eval.command,
    'npm run autoresearch:eval:circular',
  );
  assert.equal(
    manifest.activated_packs['gem-cli'].source,
    'workflow/packs/gem-cli/pack.yaml',
  );
  assert.ok(manifest.validation_kinds.includes('root_build'));
  assert.ok(
    runtimeHubs.runtime_hubs.some(
      (entry) =>
        entry.name === 'gem-cli-runtime-hub' &&
        entry.location_hint === 'packages/core/src/tools/tools.ts',
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(repoRoot, 'workflow', 'packs', 'gem-cli', 'context-hygiene.active.yaml'),
    ),
  );
});

test('begin-slice fails when dirty files are present and no scope is declared', () => {
  const repoRoot = createInstalledRepo();
  writeFile(repoRoot, 'src/dirty.js', 'export const value = 1;\n');

  const result = runWorkflow(repoRoot, [
    'begin-slice',
    '--hypothesis',
    'Dirty work must be scoped',
    '--json',
  ]);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'begin-slice dirty no scope');

  assert.match(payload.error.message, /requires at least one --scope when dirty files are present/);
  assert.match(payload.error.message, /src\/dirty\.js/);
});

test('begin-slice fails when dirty files are outside declared scope', () => {
  const repoRoot = createInstalledRepo();
  writeFile(repoRoot, 'docs/out-of-scope.md', '# outside\n');

  const result = runWorkflow(repoRoot, [
    'begin-slice',
    '--scope',
    'src',
    '--hypothesis',
    'Dirty work must stay in scope',
    '--json',
  ]);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'begin-slice dirty outside scope');

  assert.match(payload.error.message, /dirty tree has files outside declared scope/);
  assert.match(payload.error.message, /docs\/out-of-scope\.md/);
});

test('begin-slice allows dirty files inside declared scope', () => {
  const repoRoot = createInstalledRepo();
  writeFile(repoRoot, 'src/in-scope.js', 'export const value = 1;\n');

  const result = runWorkflow(repoRoot, [
    'begin-slice',
    '--scope',
    'src',
    '--hypothesis',
    'Dirty work is already inside scope',
    '--json',
  ]);
  assertSuccess(result, 'begin-slice dirty inside scope');
  const payload = parseJsonOutput(result, 'begin-slice dirty inside scope');

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.dirtyFiles.outOfScopeFiles, []);
  assert.deepEqual(payload.dirtyFiles.primaryFiles, ['src/in-scope.js']);
});

test('protected directory prefix blocks unapproved changes', () => {
  const repoRoot = createInstalledRepo();
  appendProtectedSurface(repoRoot, 'src/protected/**');

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Protected prefix needs approval',
      '--json',
    ]),
    'begin-slice protected prefix',
  );

  const protectedFile = 'src/protected/feature.js';
  writeFile(repoRoot, protectedFile, 'export const feature = true;\n');
  assertSuccess(
    runCommand('git', ['add', protectedFile], repoRoot),
    'git add protected prefix file',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit protected prefix');

  assert.equal(payload.ok, false);
  assert.deepEqual(payload.changedFiles.protectedSurfaceFiles, [protectedFile]);
  assert.deepEqual(payload.changedFiles.unapprovedProtectedSurfaceFiles, [protectedFile]);
});

test('protected directory prefix allows an approved exact-path exception', () => {
  const repoRoot = createInstalledRepo();
  appendProtectedSurface(repoRoot, 'src/protected/**');

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Protected prefix can be approved narrowly',
      '--json',
    ]),
    'begin-slice approved protected prefix',
  );

  const protectedFile = 'src/protected/feature.js';
  assertSuccess(
    runWorkflow(repoRoot, [
      'record-protected-surface',
      '--surface',
      protectedFile,
      '--reason',
      'Narrow protected prefix exception',
      '--json',
    ]),
    'record exact protected prefix exception',
  );

  writeFile(repoRoot, protectedFile, 'export const feature = true;\n');
  assertSuccess(
    runCommand('git', ['add', protectedFile], repoRoot),
    'git add approved protected prefix file',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--json']);
  assertSuccess(result, 'precommit approved protected prefix');
  const payload = parseJsonOutput(result, 'precommit approved protected prefix');

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.changedFiles.protectedSurfaceFiles, [protectedFile]);
  assert.deepEqual(payload.changedFiles.unapprovedProtectedSurfaceFiles, []);
});

test('record-only validation keeps intent-only behavior', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Validation can be recorded without execution',
      '--json',
    ]),
    'begin-slice record-only validation',
  );

  const result = runWorkflow(repoRoot, [
    'validate',
    '--kind',
    'smoke',
    '--command',
    'node -e "process.exit(99)"',
    '--json',
  ]);
  assertSuccess(result, 'record-only validate');
  const payload = parseJsonOutput(result, 'record-only validate');

  assert.equal(payload.ok, true);
  assert.equal(payload.run, false);
  assert.equal(payload.validation.status, 'recorded');
  assert.equal(payload.validation.execution, undefined);
  assert.equal(payload.session.session.validation_result, 'in-progress');
  assert.equal(payload.session.session.closeout_ready, false);
  assert.deepEqual(payload.session.command_log, []);
});

test('validate --run success records execution and allows closeout', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Executable validation can support closeout',
      '--json',
    ]),
    'begin-slice executable validation success',
  );

  const result = runWorkflow(repoRoot, [
    'validate',
    '--kind',
    'smoke',
    '--command',
    'node -e "process.stdout.write(\'ok\')"',
    '--run',
    '--json',
  ]);
  assertSuccess(result, 'validate --run success');
  const payload = parseJsonOutput(result, 'validate --run success');

  assert.equal(payload.ok, true);
  assert.equal(payload.run, true);
  assert.equal(payload.validation.status, 'passed');
  assert.equal(payload.validation.execution.exit_code, 0);
  assert.equal(payload.validation.execution.stdout.text, 'ok');
  assert.equal(typeof payload.validation.execution.duration_ms, 'number');
  assert.equal(payload.session.session.validation_result, 'passed');
  assert.equal(payload.session.session.closeout_ready, true);
  assert.equal(payload.session.command_log.at(-1).outcome, 'pass');

  const closeout = runWorkflow(repoRoot, [
    'closeout',
    '--outcome',
    'supported',
    '--json',
  ]);
  assertSuccess(closeout, 'closeout after validate --run success');
});

test('validate --run failure records execution and blocks closeout', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Executable validation failure blocks closeout',
      '--json',
    ]),
    'begin-slice executable validation failure',
  );

  const result = runWorkflow(repoRoot, [
    'validate',
    '--kind',
    'smoke',
    '--command',
    'node -e "process.stderr.write(\'bad\'); process.exit(7)"',
    '--run',
    '--json',
  ]);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'validate --run failure');

  assert.equal(payload.ok, false);
  assert.equal(payload.validation.status, 'failed');
  assert.equal(payload.validation.execution.exit_code, 7);
  assert.equal(payload.validation.execution.stderr.text, 'bad');
  assert.equal(payload.session.session.validation_result, 'failed');
  assert.equal(payload.session.session.closeout_ready, false);
  assert.equal(payload.session.command_log.at(-1).outcome, 'fail');

  const closeout = runWorkflow(repoRoot, [
    'closeout',
    '--outcome',
    'supported',
    '--json',
  ]);
  assert.equal(closeout.status, 1, closeout.stdout || closeout.stderr);
  assert.match(
    parseJsonOutput(closeout, 'closeout after validate --run failure').error.message,
    /closeout requires a passing validation outcome/,
  );
});

test('validate fails clearly for unknown validation kinds', () => {
  const repoRoot = createInstalledRepo();

  const result = runWorkflow(repoRoot, [
    'validate',
    '--kind',
    'not-a-kind',
    '--command',
    'node --version',
    '--json',
  ]);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'validate unknown kind');

  assert.match(payload.error.message, /unknown validation kind "not-a-kind"/);
  assert.match(payload.error.message, /smoke/);
});

test('precommit --strict exits non-zero for staged out-of-scope files', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Keep edits inside src',
      '--json',
    ]),
    'begin-slice',
  );
  assertSuccess(
    runWorkflow(repoRoot, [
      'validate',
      '--kind',
      'smoke',
      '--command',
      'npm test',
      '--json',
    ]),
    'validate',
  );
  assertSuccess(
    runWorkflow(repoRoot, [
      'record-pass',
      '--command',
      'npm test',
      '--json',
    ]),
    'record-pass',
  );
  assertSuccess(runWorkflow(repoRoot, ['refresh', '--json']), 'refresh');

  writeFile(repoRoot, 'docs/out-of-scope.md', '# not in scope\n');
  assertSuccess(
    runCommand('git', ['add', 'docs/out-of-scope.md'], repoRoot),
    'git add out-of-scope file',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--strict', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit --strict');

  assert.equal(payload.ok, false);
  assert.deepEqual(payload.changedFiles.outOfScopeFiles, ['docs/out-of-scope.md']);
  assert.match(payload.notes.join('\n'), /Out-of-scope files: docs\/out-of-scope\.md/);
});

test('precommit auto-blocks on unapproved protected surface touches', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'workflow/policy',
      '--hypothesis',
      'Inspect policy changes intentionally',
      '--json',
    ]),
    'begin-slice',
  );

  const protectedSurface = 'workflow/policy/validation-matrix.yaml';
  const target = path.join(repoRoot, protectedSurface);
  fs.appendFileSync(target, '\n# test-only touch\n', 'utf8');
  assertSuccess(
    runCommand('git', ['add', protectedSurface], repoRoot),
    'git add protected surface',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit protected surface');

  assert.equal(payload.ok, false);
  assert.equal(payload.session.session.current_state, 'blocked');
  assert.match(payload.session.session.blocked_reason, /Protected surface changes require a recorded exception/);
  assert.deepEqual(
    payload.changedFiles.unapprovedProtectedSurfaceFiles,
    [protectedSurface],
  );
});

test('record-protected-surface approves an explicit protected surface exception', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'workflow/policy',
      '--hypothesis',
      'Inspect policy changes intentionally',
      '--json',
    ]),
    'begin-slice',
  );
  assertSuccess(
    runWorkflow(repoRoot, [
      'record-protected-surface',
      '--surface',
      'workflow/policy/validation-matrix.yaml',
      '--reason',
      'Intentional policy review',
      '--json',
    ]),
    'record-protected-surface',
  );

  const protectedSurface = 'workflow/policy/validation-matrix.yaml';
  fs.appendFileSync(path.join(repoRoot, protectedSurface), '\n# approved touch\n', 'utf8');
  assertSuccess(
    runCommand('git', ['add', protectedSurface], repoRoot),
    'git add approved protected surface',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--json']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit approved protected surface');

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.changedFiles.unapprovedProtectedSurfaceFiles, []);
});

test('closeout requires an explicit outcome', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Closeout needs an outcome',
      '--json',
    ]),
    'begin-slice',
  );

  const result = runWorkflow(repoRoot, ['closeout', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'closeout missing outcome');

  assert.match(payload.error.message, /closeout requires --outcome/);
});

test('closeout requires pass-like validation before succeeding', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'src',
      '--hypothesis',
      'Closeout requires validation',
      '--json',
    ]),
    'begin-slice',
  );

  const earlyCloseout = runWorkflow(repoRoot, [
    'closeout',
    '--outcome',
    'supported',
    '--json',
  ]);
  assert.equal(earlyCloseout.status, 1, earlyCloseout.stdout || earlyCloseout.stderr);
  assert.match(
    parseJsonOutput(earlyCloseout, 'closeout without validation').error.message,
    /closeout requires a passing validation outcome/,
  );

  assertSuccess(
    runWorkflow(repoRoot, [
      'validate',
      '--kind',
      'smoke',
      '--command',
      'npm test',
      '--json',
    ]),
    'validate',
  );
  assertSuccess(
    runWorkflow(repoRoot, [
      'record-pass',
      '--command',
      'npm test',
      '--json',
    ]),
    'record-pass',
  );

  const closeout = runWorkflow(repoRoot, [
    'closeout',
    '--outcome',
    'supported',
    '--json',
  ]);
  assertSuccess(closeout, 'closeout');
  const payload = parseJsonOutput(closeout, 'successful closeout');

  assert.equal(payload.session.session.status, 'closed');
  assert.equal(payload.session.session.current_state, 'closeout');
  assert.equal(payload.session.session.hypothesis_outcome, 'supported');
});

test('stale session locks block mutating commands until unlock --force', () => {
  const repoRoot = createInstalledRepo();
  const lockPath = path.join(repoRoot, 'workflow', 'state', '.session.lock');
  writeFile(
    repoRoot,
    'workflow/state/.session.lock',
    `${JSON.stringify({ command: 'validate', at: '2026-04-22T00:00:00.000Z' }, null, 2)}\n`,
  );
  assert.ok(fs.existsSync(lockPath));

  const lockedBeginSlice = runWorkflow(repoRoot, [
    'begin-slice',
    '--scope',
    'src',
    '--hypothesis',
    'Lock should block this command',
    '--json',
  ]);
  assert.equal(lockedBeginSlice.status, 1, lockedBeginSlice.stdout || lockedBeginSlice.stderr);
  assert.match(
    parseJsonOutput(lockedBeginSlice, 'locked begin-slice').error.message,
    /session lock already exists/,
  );

  const unlock = runWorkflow(repoRoot, ['unlock', '--force', '--json']);
  assertSuccess(unlock, 'unlock --force');
  assert.equal(parseJsonOutput(unlock, 'unlock').removed, true);

  const beginSlice = runWorkflow(repoRoot, [
    'begin-slice',
    '--scope',
    'src',
    '--hypothesis',
    'Lock should be cleared now',
    '--json',
  ]);
  assertSuccess(beginSlice, 'begin-slice after unlock');
  assert.match(
    parseJsonOutput(beginSlice, 'begin-slice after unlock').session.session.slice_id,
    /^slice-/,
  );
});

test('refresh exits non-zero when generated docs exceed line budgets', () => {
  const repoRoot = createInstalledRepo();
  const manifestPath = path.join(repoRoot, 'workflow', 'manifest.yaml');
  fs.writeFileSync(
    manifestPath,
    fs.readFileSync(manifestPath, 'utf8').replaceAll('max_lines: 80', 'max_lines: 1'),
    'utf8',
  );

  const result = runWorkflow(repoRoot, ['refresh', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'refresh generated doc budgets');

  assert.equal(payload.ok, false);
  assert.deepEqual(
    payload.lineBudgets.over_budget.map((entry) => entry.path),
    [
      'workflow/state/generated/CURRENT_SLICE.md',
      'workflow/state/generated/NEXT_SESSION_PROMPT.md',
      'workflow/state/generated/GIT_PREFLIGHT.md',
    ],
  );
});

test('precommit --strict enforces generated doc line budgets', () => {
  const repoRoot = createInstalledRepo();

  assertSuccess(
    runWorkflow(repoRoot, [
      'begin-slice',
      '--scope',
      'workflow',
      '--hypothesis',
      'Generated docs should stay compact',
      '--json',
    ]),
    'begin-slice',
  );
  assertSuccess(
    runWorkflow(repoRoot, [
      'validate',
      '--kind',
      'smoke',
      '--command',
      'scripts/workflow status --json',
      '--json',
    ]),
    'validate',
  );
  assertSuccess(
    runWorkflow(repoRoot, [
      'record-pass',
      '--command',
      'scripts/workflow status --json',
      '--json',
    ]),
    'record-pass',
  );
  assertSuccess(runWorkflow(repoRoot, ['refresh', '--json']), 'refresh');

  const manifestPath = path.join(repoRoot, 'workflow', 'manifest.yaml');
  fs.writeFileSync(
    manifestPath,
    fs.readFileSync(manifestPath, 'utf8').replaceAll('max_lines: 80', 'max_lines: 1'),
    'utf8',
  );

  const result = runWorkflow(repoRoot, ['precommit', '--strict', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  const payload = parseJsonOutput(result, 'precommit generated doc budgets');

  assert.equal(payload.ok, false);
  assert.ok(
    payload.failed_items.includes('Generated docs stay within configured line budgets'),
  );
  assert.deepEqual(
    payload.generatedDocs.lineBudgets.over_budget.map((entry) => entry.path),
    [
      'workflow/state/generated/CURRENT_SLICE.md',
      'workflow/state/generated/NEXT_SESSION_PROMPT.md',
      'workflow/state/generated/GIT_PREFLIGHT.md',
    ],
  );
  assert.match(payload.notes.join('\n'), /Generated docs exceed line budgets/);
});
