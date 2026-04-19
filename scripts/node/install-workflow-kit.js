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
  const force = Boolean(options.force);
  return {
    targetRoot,
    targetName,
    integrationBranch,
    baselineBranch,
    laneId,
    laneName,
    runtimeHub,
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

function refreshTarget(config) {
  execFileSync('./scripts/workflow', ['refresh', '--json'], {
    cwd: config.targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildResult(config, paths) {
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
  refreshTarget(config);

  const result = buildResult(config, paths);
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
