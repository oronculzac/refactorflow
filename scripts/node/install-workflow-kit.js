#!/usr/bin/env node

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { parseArgv } = require('./lib/argv');
const { parseYaml, stringifyYaml } = require('./lib/yaml');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..');

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, 'utf8');
}

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function tryGit(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return '';
  }
}

function titleCaseFromId(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function requireTarget(options) {
  const target = String(options.target || '').trim();
  if (!target) {
    fail('missing required --target <repo-path>');
  }
  const targetRoot = path.resolve(target);
  if (!pathExists(targetRoot)) {
    fail(`target repo does not exist: ${targetRoot}`);
  }
  if (!fs.statSync(targetRoot).isDirectory()) {
    fail(`target path is not a directory: ${targetRoot}`);
  }
  return targetRoot;
}

function buildConfig(targetRoot, options) {
  const targetName =
    String(options.repoName || '').trim() || path.basename(targetRoot);
  const detectedBranch = tryGit(targetRoot, ['branch', '--show-current']);
  const baselineBranch =
    String(options.baselineBranch || '').trim() ||
    detectedBranch ||
    'main';
  const integrationBranch =
    String(options.integrationBranch || '').trim() || 'refactor/main';
  const laneId =
    String(options.laneId || '').trim() || 'core-import-cleanup';
  const laneName =
    String(options.laneName || '').trim() || titleCaseFromId(laneId);
  const runtimeHub =
    String(options.runtimeHub || '').trim() ||
    'packages/core/src/tools/tools.ts';
  const pack = String(options.pack || '').trim() || null;
  const force = Boolean(options.force);
  return {
    targetRoot,
    targetName,
    integrationBranch,
    baselineBranch,
    laneId,
    laneName,
    runtimeHub,
    pack,
    force,
  };
}

function targetPaths(config) {
  return {
    workflowDir: path.join(config.targetRoot, 'workflow'),
    scriptsDir: path.join(config.targetRoot, 'scripts'),
    workflowCommand: path.join(config.targetRoot, 'scripts', 'workflow'),
    installCommand: path.join(
      config.targetRoot,
      'scripts',
      'install-workflow-kit',
    ),
    manifest: path.join(config.targetRoot, 'workflow', 'manifest.yaml'),
    activeSession: path.join(
      config.targetRoot,
      'workflow',
      'state',
      'active-session.yaml',
    ),
    lane: path.join(
      config.targetRoot,
      'workflow',
      'lanes',
      `${config.laneId}.yaml`,
    ),
    bootstrapPrompt: path.join(
      config.targetRoot,
      'workflow',
      'prompts',
      'bootstrap.md.tpl',
    ),
    activeSessionTemplate: path.join(
      config.targetRoot,
      'workflow',
      'templates',
      'active-session.yaml.tpl',
    ),
    protectedSurfaces: path.join(
      config.targetRoot,
      'workflow',
      'policy',
      'protected-surfaces.yaml',
    ),
    validationMatrix: path.join(
      config.targetRoot,
      'workflow',
      'policy',
      'validation-matrix.yaml',
    ),
    runtimeHubs: path.join(
      config.targetRoot,
      'workflow',
      'policy',
      'runtime-hubs.yaml',
    ),
    packsDir: path.join(config.targetRoot, 'workflow', 'packs'),
    readmeSnapshot: path.join(config.targetRoot, 'README.refactorflow.md'),
  };
}

function assertSafeToWrite(config, paths) {
  const conflicts = [
    paths.workflowDir,
    paths.workflowCommand,
    paths.installCommand,
  ].filter((filePath) => pathExists(filePath));

  if (conflicts.length > 0 && !config.force) {
    fail(
      `target already has workflow files; rerun with --force to overwrite: ${conflicts
        .map(normalizePath)
        .join(', ')}`,
    );
  }
}

function copyIntoTarget(config) {
  const paths = targetPaths(config);
  assertSafeToWrite(config, paths);

  fs.cpSync(
    path.join(SOURCE_ROOT, 'workflow'),
    path.join(config.targetRoot, 'workflow'),
    {
      recursive: true,
      force: config.force,
      dereference: false,
    },
  );

  fs.cpSync(
    path.join(SOURCE_ROOT, 'scripts', 'workflow'),
    path.join(config.targetRoot, 'scripts', 'workflow'),
    {
      recursive: true,
      force: config.force,
      dereference: false,
    },
  );

  fs.cpSync(
    path.join(SOURCE_ROOT, 'scripts', 'node'),
    path.join(config.targetRoot, 'scripts', 'node'),
    {
      recursive: true,
      force: config.force,
      dereference: false,
    },
  );

  fs.cpSync(
    path.join(SOURCE_ROOT, 'scripts', 'install-workflow-kit'),
    path.join(config.targetRoot, 'scripts', 'install-workflow-kit'),
    {
      force: config.force,
      dereference: false,
    },
  );

  fs.cpSync(path.join(SOURCE_ROOT, 'README.md'), paths.readmeSnapshot, {
    force: config.force,
    dereference: false,
  });

  fs.cpSync(path.join(SOURCE_ROOT, 'WORKFLOW.md'), path.join(config.targetRoot, 'WORKFLOW.md'), {
    force: config.force,
    dereference: false,
  });

  fs.chmodSync(paths.workflowCommand, 0o755);
  fs.chmodSync(paths.installCommand, 0o755);
}

function loadYaml(filePath) {
  return parseYaml(readText(filePath));
}

function saveYaml(filePath, value) {
  writeText(filePath, `${stringifyYaml(value)}\n`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureArrayProperty(container, key) {
  if (!Array.isArray(container[key])) {
    container[key] = [];
  }
  return container[key];
}

function appendUniqueByName(target, entries) {
  const existingNames = new Set(
    target
      .map((entry) => (entry && entry.name ? String(entry.name) : ''))
      .filter(Boolean),
  );
  for (const entry of entries) {
    if (!entry || !entry.name || existingNames.has(String(entry.name))) {
      continue;
    }
    target.push(entry);
    existingNames.add(String(entry.name));
  }
}

function appendUniqueScalars(target, entries) {
  const existing = new Set(target.map((entry) => String(entry)));
  for (const entry of entries) {
    const value = String(entry || '').trim();
    if (!value || existing.has(value)) {
      continue;
    }
    target.push(value);
    existing.add(value);
  }
}

function requirePack(config, paths) {
  if (!config.pack) {
    return null;
  }
  const packDir = path.join(paths.packsDir, config.pack);
  if (!pathExists(packDir) || !fs.statSync(packDir).isDirectory()) {
    throw new Error(`unknown workflow pack: ${config.pack}`);
  }
  return {
    id: config.pack,
    dir: packDir,
    pack: loadYaml(path.join(packDir, 'pack.yaml')),
    protectedSurfaces: loadYaml(path.join(packDir, 'protected-surfaces.yaml')),
    validationMatrix: loadYaml(path.join(packDir, 'validation-matrix.yaml')),
    runtimeHubRules: loadYaml(path.join(packDir, 'runtime-hub-rules.yaml')),
    contextHygiene: loadYaml(path.join(packDir, 'context-hygiene.yaml')),
  };
}

function rewriteManifest(config, paths) {
  const manifest = loadYaml(paths.manifest);
  manifest.workflow_name = 'refactorflow';
  manifest.name = `${config.targetName}-refactorflow`;
  manifest.summary = `RefactorFlow bounded refactor workflow kit for ${config.targetName}.`;
  manifest.integration_branch = config.integrationBranch;
  manifest.baseline_branch = config.baselineBranch;
  if (manifest.kit && typeof manifest.kit === 'object') {
    manifest.kit.name = 'refactorflow';
  }
  if (Array.isArray(manifest.bootstrap_order)) {
    manifest.bootstrap_order = manifest.bootstrap_order.map((entry) =>
      entry === 'workflow/lanes/core-import-cleanup.yaml'
        ? `workflow/lanes/${config.laneId}.yaml`
        : entry,
    );
  }
  saveYaml(paths.manifest, manifest);
}

function rewriteLane(config, paths) {
  const originalLanePath = path.join(
    config.targetRoot,
    'workflow',
    'lanes',
    'core-import-cleanup.yaml',
  );
  const lane = loadYaml(originalLanePath);
  if (lane.lane && typeof lane.lane === 'object') {
    lane.lane.id = config.laneId;
    lane.lane.name = config.laneName;
  }
  saveYaml(paths.lane, lane);
  if (paths.lane !== originalLanePath && pathExists(originalLanePath)) {
    fs.rmSync(originalLanePath);
  }
}

function rewriteRuntimeHubs(config) {
  const runtimeHubPath = path.join(
    config.targetRoot,
    'workflow',
    'policy',
    'runtime-hubs.yaml',
  );
  const runtimeHubs = loadYaml(runtimeHubPath);
  if (
    runtimeHubs.runtime_hubs &&
    Array.isArray(runtimeHubs.runtime_hubs) &&
    runtimeHubs.runtime_hubs.length > 0
  ) {
    runtimeHubs.runtime_hubs[0].location_hint = config.runtimeHub;
  }
  saveYaml(runtimeHubPath, runtimeHubs);
}

function replaceInFile(filePath, replacements) {
  let contents = readText(filePath);
  for (const [from, to] of replacements) {
    contents = contents.split(from).join(to);
  }
  writeText(filePath, contents);
}

function rewriteSessionAndTemplates(config, paths) {
  const session = loadYaml(paths.activeSession);
  if (session.session && typeof session.session === 'object') {
    session.session.active_lane = config.laneId;
  }
  if (session.llm_bootstrap && Array.isArray(session.llm_bootstrap.reading_order)) {
    session.llm_bootstrap.reading_order = session.llm_bootstrap.reading_order.map(
      (entry) =>
        entry === 'workflow/lanes/core-import-cleanup.yaml'
          ? `workflow/lanes/${config.laneId}.yaml`
          : entry,
    );
  }
  saveYaml(paths.activeSession, session);

  replaceInFile(paths.bootstrapPrompt, [
    ['workflow/lanes/core-import-cleanup.yaml', `workflow/lanes/${config.laneId}.yaml`],
  ]);

  replaceInFile(paths.activeSessionTemplate, [
    ['active_lane: core-import-cleanup', `active_lane: ${config.laneId}`],
    ['workflow/lanes/<lane-file>.yaml', `workflow/lanes/${config.laneId}.yaml`],
  ]);
}

function activateProtectedSurfaces(paths, pack) {
  const policy = loadYaml(paths.protectedSurfaces);
  appendUniqueByName(
    ensureArrayProperty(policy, 'surfaces'),
    asArray(pack.protectedSurfaces.surfaces),
  );
  appendUniqueScalars(
    ensureArrayProperty(policy, 'rules'),
    asArray(pack.protectedSurfaces.rules),
  );
  policy.activated_packs = ensureArrayProperty(policy, 'activated_packs');
  appendUniqueScalars(policy.activated_packs, [pack.id]);
  saveYaml(paths.protectedSurfaces, policy);
}

function activateValidationMatrix(paths, pack) {
  const policy = loadYaml(paths.validationMatrix);
  if (!policy.pack_validation_commands || typeof policy.pack_validation_commands !== 'object') {
    policy.pack_validation_commands = {};
  }
  policy.pack_validation_commands[pack.id] = pack.validationMatrix.commands || {};
  if (pack.validationMatrix.acceptance) {
    if (!policy.pack_acceptance || typeof policy.pack_acceptance !== 'object') {
      policy.pack_acceptance = {};
    }
    policy.pack_acceptance[pack.id] = pack.validationMatrix.acceptance;
  }
  appendUniqueScalars(
    ensureArrayProperty(policy, 'required_evidence'),
    [
      'pack_validation_commands_when_present',
      'pack_acceptance_when_present',
    ],
  );
  policy.activated_packs = ensureArrayProperty(policy, 'activated_packs');
  appendUniqueScalars(policy.activated_packs, [pack.id]);
  saveYaml(paths.validationMatrix, policy);
}

function activateManifestValidation(paths, pack) {
  const manifest = loadYaml(paths.manifest);
  const validationKinds = ensureArrayProperty(manifest, 'validation_kinds');
  const commands = pack.validationMatrix.commands || {};
  appendUniqueScalars(
    validationKinds,
    Object.values(commands)
      .map((entry) => entry && entry.kind)
      .filter(Boolean),
  );
  if (pack.contextHygiene.generated_doc_budgets) {
    manifest.generated_doc_budgets = {
      ...(manifest.generated_doc_budgets || {}),
      ...pack.contextHygiene.generated_doc_budgets,
    };
  }
  if (!manifest.activated_packs || typeof manifest.activated_packs !== 'object') {
    manifest.activated_packs = {};
  }
  manifest.activated_packs[pack.id] = {
    id: pack.id,
    status: 'active',
    source: `workflow/packs/${pack.id}/pack.yaml`,
  };
  saveYaml(paths.manifest, manifest);
}

function activateRuntimeHubRules(paths, pack) {
  const policy = loadYaml(paths.runtimeHubs);
  const runtimeHub = pack.runtimeHubRules.runtime_hub || {};
  const hubName = `${pack.id}-runtime-hub`;
  const runtimeHubs = ensureArrayProperty(policy, 'runtime_hubs');
  const existingIndex = runtimeHubs.findIndex((entry) => entry && entry.name === hubName);
  const hub = {
    name: hubName,
    location_hint: runtimeHub.primary_file || 'packages/core/src/tools/tools.ts',
    role: `${pack.id} runtime hub policy`,
    map_doc: runtimeHub.map_doc || null,
    map_command: runtimeHub.map_command || null,
    rules: [
      ...asArray(pack.runtimeHubRules.required_order),
      ...asArray(pack.runtimeHubRules.rules),
    ],
    fast_validation: asArray(pack.runtimeHubRules.fast_validation),
    stop_conditions: asArray(pack.runtimeHubRules.discard_criteria),
  };
  if (existingIndex === -1) {
    runtimeHubs.push(hub);
  } else {
    runtimeHubs[existingIndex] = hub;
  }
  policy.activated_packs = ensureArrayProperty(policy, 'activated_packs');
  appendUniqueScalars(policy.activated_packs, [pack.id]);
  saveYaml(paths.runtimeHubs, policy);
}

function activateContextHygiene(paths, pack) {
  const target = path.join(paths.packsDir, pack.id, 'context-hygiene.active.yaml');
  saveYaml(target, {
    version: 1,
    pack: pack.id,
    status: 'active',
    context_hygiene: pack.contextHygiene,
  });
}

function activatePack(config, paths) {
  const pack = requirePack(config, paths);
  if (!pack) {
    return null;
  }
  activateProtectedSurfaces(paths, pack);
  activateValidationMatrix(paths, pack);
  activateManifestValidation(paths, pack);
  activateRuntimeHubRules(paths, pack);
  activateContextHygiene(paths, pack);
  return pack;
}

function refreshTarget(config) {
  execFileSync('./scripts/workflow', ['refresh', '--json'], {
    cwd: config.targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildResult(config, paths, activatedPack) {
  return {
    ok: true,
    target: normalizePath(config.targetRoot),
    installed: {
      workflowDir: normalizePath(paths.workflowDir),
      workflowCommand: normalizePath(paths.workflowCommand),
      installCommand: normalizePath(paths.installCommand),
      readmeSnapshot: normalizePath(paths.readmeSnapshot),
      manifest: normalizePath(paths.manifest),
      activeSession: normalizePath(paths.activeSession),
      lane: normalizePath(paths.lane),
    },
    rewritten: {
      integrationBranch: config.integrationBranch,
      baselineBranch: config.baselineBranch,
      laneId: config.laneId,
      laneName: config.laneName,
      runtimeHub: config.runtimeHub,
    },
    pack: activatedPack
      ? {
          id: activatedPack.id,
          status: 'active',
          source: normalizePath(path.join(paths.packsDir, activatedPack.id, 'pack.yaml')),
        }
      : null,
    next: [
      'cd <target-repo>',
      './scripts/workflow bootstrap --json',
    ],
  };
}

function main() {
  const parsed = parseArgv(process.argv);
  const config = buildConfig(requireTarget(parsed.options), parsed.options);
  const paths = targetPaths(config);

  copyIntoTarget(config);
  rewriteManifest(config, paths);
  rewriteLane(config, paths);
  rewriteRuntimeHubs(config);
  rewriteSessionAndTemplates(config, paths);
  const activatedPack = activatePack(config, paths);
  refreshTarget(config);

  const result = buildResult(config, paths, activatedPack);
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  info(`Installed workflow kit into ${result.target}`);
  info('');
  info('Rewritten values:');
  info(`- integration branch: ${config.integrationBranch}`);
  info(`- baseline branch: ${config.baselineBranch}`);
  info(`- lane id: ${config.laneId}`);
  info(`- lane name: ${config.laneName}`);
  info(`- runtime hub: ${config.runtimeHub}`);
  if (activatedPack) {
    info(`- activated pack: ${activatedPack.id}`);
  }
  info('');
  info('Next:');
  info(`- cd ${config.targetRoot}`);
  info('- ./scripts/workflow bootstrap --json');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  }
}
