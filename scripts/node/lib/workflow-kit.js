'use strict';

const { randomUUID } = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { ensureDir, pathExists, readTextIfExists, statIfExists, writeText } = require('./io');
const {
  MANIFEST_PATH,
  SESSION_PATH,
  SESSION_LOCK_PATH,
  PROTECTED_SURFACES_PATH,
  DECISION_LOG_PATH,
  CURRENT_SLICE_PATH,
  NEXT_SESSION_PROMPT_PATH,
  GIT_PREFLIGHT_PATH,
  GENERATED_DIR,
  REPO_ROOT,
} = require('./paths');
const { parseYaml, stringifyYaml } = require('./yaml');
const {
  renderCurrentSliceDoc,
  renderGitPreflightDoc,
  renderMarkdownBootstrap,
  renderMarkdownChecklist,
  renderMarkdownCloseout,
  renderMarkdownHelp,
  renderMarkdownSlice,
  renderMarkdownStatus,
  renderNextSessionPromptDoc,
} = require('./render');

const DEFAULT_MANIFEST = {
  workflow_name: 'refactorflow',
  integration_branch: 'example/refactor/main',
  baseline_branch: 'example/baseline-upstream',
  name: 'refactorflow',
  summary: 'AI-assisted bounded refactor workflow kit with a single JSON-first command surface.',
  commands: {
    help: { description: 'Show command help and manifest metadata.' },
    bootstrap: { description: 'Load manifest, session, and policy state in one JSON payload.' },
    status: { description: 'Inspect current workflow state and the next recommended action.' },
    'begin-slice': { description: 'Start one small slice for one or more scopes.' },
    validate: {
      description:
        'Record one validation kind for the current slice; add --run to execute the command.',
    },
    'record-pass': { description: 'Record a successful command outcome.' },
    'record-skip': {
      description:
        'Record a skipped command outcome; add --blocking for a hard workflow stop.',
    },
    'record-candidate': {
      description:
        'Record the next candidate as open, closed, stale, or discarded.',
    },
    'record-protected-surface': {
      description:
        'Record an explicit protected-surface exception with --surface <path> --reason <text>.',
    },
    'suggest-next': { description: 'Compute the next recommended workflow action.' },
    refresh: { description: 'Regenerate human-readable docs from structured state.' },
    closeout: {
      description:
        'Close the current slice with --outcome <supported|refuted|inconclusive> and append a decision log entry.',
    },
    precommit: {
      description:
        'Run a state-focused precommit checklist; add --strict for non-zero enforcement on checklist failures.',
    },
    unlock: { description: 'Remove a stale session lock; requires --force.' },
  },
  validation_kinds: [
    'focused_test',
    'touched_scope_build',
    'root_build',
    'smoke',
    'policy',
    'trust',
    'custom',
  ],
  generated_outputs: [
    'workflow/state/generated/CURRENT_SLICE.md',
    'workflow/state/generated/NEXT_SESSION_PROMPT.md',
    'workflow/state/generated/GIT_PREFLIGHT.md',
  ],
  generated_doc_budgets: {
    'workflow/state/generated/CURRENT_SLICE.md': { max_lines: 80 },
    'workflow/state/generated/NEXT_SESSION_PROMPT.md': { max_lines: 80 },
    'workflow/state/generated/GIT_PREFLIGHT.md': { max_lines: 80 },
  },
};

const DEFAULT_SESSION = {
  version: 1,
  session: {
    status: 'seeded',
    current_state: 'seeded',
    previous_state: null,
    active_lane: 'core-import-cleanup',
    slice_id: null,
    hypothesis: null,
    hypothesis_check: null,
    hypothesis_outcome: null,
    writable_scope: [],
    protected_surfaces_consulted: false,
    protected_surface_exceptions: [],
    validation_plan: [],
    validation_result: null,
    closeout_ready: false,
    blocked_reason: null,
    external_blockers: [],
    started_at: null,
    updated_at: null,
  },
  validation_log: [],
  command_log: [],
  history: [],
  candidate_log: [],
  next_step: null,
  llm_bootstrap: {
    reading_order: [
      'workflow/manifest.yaml',
      'workflow/state/active-session.yaml',
      'workflow/policy/protected-surfaces.yaml',
      'workflow/policy/validation-matrix.yaml',
      'workflow/policy/risk-map.yaml',
      'workflow/policy/runtime-hubs.yaml',
      'workflow/lanes/core-import-cleanup.yaml',
    ],
    next_action: 'run scripts/workflow bootstrap --json',
  },
  generated: {
    current_slice: 'workflow/state/generated/CURRENT_SLICE.md',
    next_session_prompt: 'workflow/state/generated/NEXT_SESSION_PROMPT.md',
    git_preflight: 'workflow/state/generated/GIT_PREFLIGHT.md',
  },
};

const DEFAULT_PROTECTED_SURFACES = {
  surfaces: [],
  rules: [],
};

const GIT_CHANGED_PATHS_ARGS = ['status', '--porcelain=1', '--untracked-files=all'];
const GIT_STAGED_PATHS_ARGS = [
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACDMRTUXB',
];
const OUTPUT_SUMMARY_MAX_CHARS = 2000;
const OUTPUT_SUMMARY_MAX_LINES = 40;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override.slice() : base.slice();
  }
  if (isObject(base)) {
    const result = clone(base);
    if (!isObject(override)) {
      return result;
    }
    for (const [key, value] of Object.entries(override)) {
      if (isObject(value) && isObject(base[key])) {
        result[key] = mergeDeep(base[key], value);
      } else if (Array.isArray(value)) {
        result[key] = value.slice();
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return typeof override === 'undefined' ? base : override;
}

function loadYamlFile(filePath, defaults) {
  const raw = readTextIfExists(filePath);
  if (raw === null) {
    return clone(defaults);
  }
  const parsed = parseYaml(raw);
  if (!isObject(parsed)) {
    return clone(defaults);
  }
  return mergeDeep(defaults, parsed);
}

function loadManifest() {
  return loadYamlFile(MANIFEST_PATH, DEFAULT_MANIFEST);
}

function loadProtectedSurfaces() {
  return loadYamlFile(PROTECTED_SURFACES_PATH, DEFAULT_PROTECTED_SURFACES);
}

function loadSession() {
  const session = loadYamlFile(SESSION_PATH, DEFAULT_SESSION);
  if (!Array.isArray(session.validation_log)) {
    session.validation_log = [];
  }
  if (!Array.isArray(session.command_log)) {
    session.command_log = [];
  }
  if (!Array.isArray(session.history)) {
    session.history = [];
  }
  if (!Array.isArray(session.candidate_log)) {
    session.candidate_log = [];
  }
  if (!session.generated) {
    session.generated = clone(DEFAULT_SESSION.generated);
  }
  if (!Array.isArray(session.session.external_blockers)) {
    session.session.external_blockers = [];
  }
  if (!Array.isArray(session.session.protected_surface_exceptions)) {
    session.session.protected_surface_exceptions = [];
  }
  return session;
}

function saveSession(session) {
  ensureDir(GENERATED_DIR);
  writeText(SESSION_PATH, `${stringifyYaml(session)}\n`);
}

function appendDecisionLog(entry) {
  ensureDir(GENERATED_DIR);
  fs.appendFileSync(DECISION_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

function now() {
  return new Date().toISOString();
}

function createSliceId() {
  return `slice-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function readSessionLock() {
  const raw = readTextIfExists(SESSION_LOCK_PATH);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {
      raw,
    };
  }
}

function acquireSessionLock(commandName) {
  const lock = {
    lock_id: randomUUID(),
    command: commandName,
    pid: process.pid,
    at: now(),
  };

  ensureDir(path.dirname(SESSION_LOCK_PATH));
  let fd;
  try {
    fd = fs.openSync(SESSION_LOCK_PATH, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = readSessionLock();
      const detail = existing && existing.command
        ? `held by command "${existing.command}" at ${existing.at || 'unknown time'}`
        : 'present with unreadable contents';
      throw new Error(
        `session lock already exists (${detail}); retry later or run scripts/workflow unlock --force`,
      );
    }
    throw error;
  }

  try {
    fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(fd);
  }

  return lock;
}

function releaseSessionLock(lock) {
  if (!lock || !pathExists(SESSION_LOCK_PATH)) {
    return;
  }
  const existing = readSessionLock();
  if (
    existing &&
    typeof existing === 'object' &&
    existing.lock_id &&
    existing.lock_id !== lock.lock_id
  ) {
    return;
  }
  fs.rmSync(SESSION_LOCK_PATH, {
    force: true,
  });
}

function withSessionLock(commandName, operation) {
  const lock = acquireSessionLock(commandName);
  try {
    return operation(lock);
  } finally {
    releaseSessionLock(lock);
  }
}

function readFileMetadata(filePath) {
  const stat = statIfExists(filePath);
  if (!stat) {
    return null;
  }
  return {
    path: filePath,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function normalizeScopes(scope) {
  if (!scope) {
    return [];
  }
  if (Array.isArray(scope)) {
    return scope.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return [String(scope).trim()].filter(Boolean);
}

function isTrue(value) {
  return value === true || value === 'true';
}

function getProtectedSurfaceExceptions(session) {
  if (!Array.isArray(session.session.protected_surface_exceptions)) {
    session.session.protected_surface_exceptions = [];
  }
  return session.session.protected_surface_exceptions;
}

function hasProtectedSurfaceException(session, filePath) {
  return getProtectedSurfaceExceptions(session).some((entry) => {
    const pattern = buildPathPattern(entry.surface);
    return pathMatchesPattern(filePath, pattern);
  });
}

function getExternalBlockers(session) {
  if (!Array.isArray(session.session.external_blockers)) {
    session.session.external_blockers = [];
  }
  return session.session.external_blockers;
}

function getValidationResultWithExternalBlockers(baseResult, externalBlockers) {
  if (!baseResult) {
    return baseResult;
  }
  if (!externalBlockers || externalBlockers.length === 0) {
    return baseResult;
  }
  if (baseResult === 'passed') {
    return 'passed-with-external-skips';
  }
  if (baseResult === 'in-progress') {
    return 'in-progress-with-external-skips';
  }
  return baseResult;
}

function isBlockingSkip(options) {
  return isTrue(options.blocking);
}

function normalizeCandidateStatus(options) {
  const status = String(options.status || '').trim().toLowerCase();
  if (
    status === 'open' ||
    status === 'closed' ||
    status === 'stale' ||
    status === 'discarded'
  ) {
    return status;
  }
  throw new Error(
    'record-candidate requires --status <open|closed|stale|discarded>',
  );
}

function normalizeValidationKind(kind, manifest) {
  const normalizedKind = String(kind || '').trim();
  const acceptedKinds = Array.isArray(manifest.validation_kinds)
    ? manifest.validation_kinds.map((entry) => String(entry))
    : DEFAULT_MANIFEST.validation_kinds;
  if (!normalizedKind) {
    throw new Error('validate requires --kind');
  }
  if (!acceptedKinds.includes(normalizedKind)) {
    throw new Error(
      `unknown validation kind "${normalizedKind}"; expected one of: ${acceptedKinds.join(', ')}`,
    );
  }
  return normalizedKind;
}

function normalizeCloseoutOutcome(options) {
  const outcome = String(options.outcome || '').trim().toLowerCase();
  if (
    outcome === 'supported' ||
    outcome === 'refuted' ||
    outcome === 'inconclusive'
  ) {
    return outcome;
  }
  throw new Error(
    'closeout requires --outcome <supported|refuted|inconclusive>',
  );
}

function isPassLikeValidationResult(result) {
  return result === 'passed' || result === 'passed-with-external-skips';
}

function parseCommandText(commandText) {
  const text = String(commandText || '').trim();
  if (!text) {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;
  for (const character of text) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (escaping) {
    current += '\\';
  }
  if (quote) {
    throw new Error('validate --run command has an unterminated quote');
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function resolveExecutable(command) {
  if (command.includes('/') || command.includes('\\')) {
    return path.resolve(REPO_ROOT, command);
  }
  return command;
}

function summarizeOutput(output) {
  const text = String(output || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = text.trimEnd();
  const lines = trimmed ? trimmed.split('\n') : [];
  const truncatedByLines = lines.length > OUTPUT_SUMMARY_MAX_LINES;
  let summary = lines.slice(0, OUTPUT_SUMMARY_MAX_LINES).join('\n');
  const truncatedByChars = summary.length > OUTPUT_SUMMARY_MAX_CHARS;
  if (truncatedByChars) {
    summary = summary.slice(0, OUTPUT_SUMMARY_MAX_CHARS);
  }
  return {
    text: summary,
    lines: lines.length,
    chars: text.length,
    truncated: truncatedByLines || truncatedByChars,
  };
}

function runValidationCommand(commandText) {
  const argv = parseCommandText(commandText);
  if (argv.length === 0) {
    throw new Error('validate --run requires --command <text>');
  }

  const startedAt = now();
  const startedAtMs = Date.now();
  const result = spawnSync(resolveExecutable(argv[0]), argv.slice(1), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const durationMs = Date.now() - startedAtMs;
  const exitCode =
    typeof result.status === 'number'
      ? result.status
      : result.error
        ? 127
        : null;

  return {
    command: commandText,
    argv,
    at: startedAt,
    exit_code: exitCode,
    signal: result.signal || null,
    duration_ms: durationMs,
    stdout: summarizeOutput(result.stdout),
    stderr: summarizeOutput(
      result.error && !result.stderr
        ? result.error.message
        : result.stderr,
    ),
  };
}

function loadWorkflowState() {
  const manifest = loadManifest();
  const session = loadSession();
  const protectedSurfaces = loadProtectedSurfaces();
  return {
    manifest,
    session,
    protectedSurfaces,
    manifestPath: MANIFEST_PATH,
    sessionFile: SESSION_PATH,
  };
}

function transitionSession(session, nextState, nextStatus) {
  session.session.previous_state = session.session.current_state;
  session.session.current_state = nextState;
  session.session.status = nextStatus;
  session.session.updated_at = now();
  if (!session.session.started_at) {
    session.session.started_at = session.session.updated_at;
  }
}

function touchSession(session) {
  session.session.updated_at = now();
  if (!session.session.started_at) {
    session.session.started_at = session.session.updated_at;
  }
}

function getNextCandidate(session) {
  if (
    session.next_step &&
    typeof session.next_step === 'object' &&
    typeof session.next_step.candidate === 'string'
  ) {
    return session.next_step;
  }
  return null;
}

function summarizeState(state) {
  const suggestion = suggestNextFromState(state.manifest, state.session);
  return {
    manifest: {
      name: state.manifest.name,
      workflow_name: state.manifest.workflow_name,
      summary: state.manifest.summary,
      validation_kinds:
        state.manifest.validation_kinds || DEFAULT_MANIFEST.validation_kinds,
    },
    session: state.session,
    suggestion,
  };
}

function normalizePath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim();
}

function toRepoRelative(filePath) {
  return normalizePath(path.relative(REPO_ROOT, filePath));
}

function tryExecGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch {
    return null;
  }
}

function parseGitStatusPaths(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      let candidate = line.slice(3).trim();
      const renameIndex = candidate.lastIndexOf(' -> ');
      if (renameIndex !== -1) {
        candidate = candidate.slice(renameIndex + 4);
      }
      return normalizePath(candidate);
    })
    .filter(Boolean);
}

function parseGitNameOnlyPaths(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => normalizePath(line))
    .filter(Boolean);
}

function getChangedFiles() {
  const stagedRaw = tryExecGit(GIT_STAGED_PATHS_ARGS);
  if (stagedRaw === null) {
    return {
      gitAvailable: false,
      sourceMode: 'unavailable',
      paths: [],
    };
  }

  const stagedPaths = parseGitNameOnlyPaths(stagedRaw);
  if (stagedPaths.length > 0) {
    return {
      gitAvailable: true,
      sourceMode: 'staged',
      paths: stagedPaths,
    };
  }

  const dirtyRaw = tryExecGit(GIT_CHANGED_PATHS_ARGS);
  return {
    gitAvailable: true,
    sourceMode: 'dirty',
    paths: parseGitStatusPaths(dirtyRaw),
  };
}

function getDirtyFiles() {
  const dirtyRaw = tryExecGit(GIT_CHANGED_PATHS_ARGS);
  if (dirtyRaw === null) {
    return {
      gitAvailable: false,
      sourceMode: 'unavailable',
      paths: [],
    };
  }

  return {
    gitAvailable: true,
    sourceMode: 'dirty',
    paths: parseGitStatusPaths(dirtyRaw),
  };
}

function isWithinScope(filePath, scopes) {
  return scopes.some((scope) => {
    const normalizedScope = normalizePath(scope);
    if (!normalizedScope) {
      return false;
    }
    return filePath === normalizedScope || filePath.startsWith(`${normalizedScope}/`);
  });
}

function getWorkflowSidecarPaths(manifest) {
  const generatedOutputs = Array.isArray(manifest.generated_outputs)
    ? manifest.generated_outputs
    : DEFAULT_MANIFEST.generated_outputs;
  return new Set(
    [
      ...generatedOutputs,
      toRepoRelative(SESSION_PATH),
      toRepoRelative(DECISION_LOG_PATH),
      toRepoRelative(SESSION_LOCK_PATH),
    ].map((entry) => normalizePath(entry)),
  );
}

function escapeRegExp(text) {
  return String(text).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  let source = '^';
  const text = normalizePath(pattern);
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '*') {
      if (text[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegExp(character);
  }
  source += '$';
  return new RegExp(source);
}

function buildPathPattern(value) {
  const raw = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
  if (!raw) {
    return null;
  }
  if (raw.endsWith('/**')) {
    return {
      raw: normalizePath(raw),
      mode: 'prefix',
      prefix: normalizePath(raw.slice(0, -3)),
    };
  }
  if (raw.endsWith('/*')) {
    return {
      raw: normalizePath(raw),
      mode: 'prefix',
      prefix: normalizePath(raw.slice(0, -2)),
    };
  }
  if (raw.endsWith('/')) {
    return {
      raw: normalizePath(raw),
      mode: 'prefix',
      prefix: normalizePath(raw),
    };
  }
  if (raw.includes('*')) {
    return {
      raw: normalizePath(raw),
      mode: 'glob',
      regex: globToRegExp(raw),
    };
  }
  return {
    raw: normalizePath(raw),
    mode: 'exact',
    path: normalizePath(raw),
  };
}

function pathMatchesPattern(filePath, pattern) {
  const normalizedPath = normalizePath(filePath);
  if (!pattern || !normalizedPath) {
    return false;
  }
  if (pattern.mode === 'exact') {
    return normalizedPath === pattern.path;
  }
  if (pattern.mode === 'prefix') {
    return (
      normalizedPath === pattern.prefix ||
      normalizedPath.startsWith(`${pattern.prefix}/`)
    );
  }
  if (pattern.mode === 'glob') {
    return pattern.regex.test(normalizedPath);
  }
  return false;
}

function getProtectedSurfacePatterns(protectedSurfaces) {
  const entries =
    protectedSurfaces &&
    Array.isArray(protectedSurfaces.surfaces)
      ? protectedSurfaces.surfaces
      : [];
  return entries
    .map((entry) => buildPathPattern(entry && entry.name ? entry.name : ''))
    .filter(Boolean);
}

function hasMatchingPathPattern(patterns, filePath) {
  return patterns.some((pattern) => pathMatchesPattern(filePath, pattern));
}

function getAllowedProtectedSurfacePaths() {
  return new Set([
    toRepoRelative(SESSION_PATH),
    toRepoRelative(DECISION_LOG_PATH),
  ]);
}

function getSharedPathPrefix(paths) {
  if (paths.length === 0) {
    return null;
  }
  if (paths.length === 1) {
    return paths[0];
  }

  const segmentedPaths = paths.map((entry) => entry.split('/').filter(Boolean));
  const prefix = [];
  const limit = Math.min(...segmentedPaths.map((segments) => segments.length));

  for (let index = 0; index < limit; index += 1) {
    const segment = segmentedPaths[0][index];
    if (segmentedPaths.every((segments) => segments[index] === segment)) {
      prefix.push(segment);
      continue;
    }
    break;
  }

  return prefix.length > 0 ? prefix.join('/') : null;
}

function inspectChangedFiles(manifest, session, protectedSurfaces) {
  const changed = getChangedFiles();
  return inspectChangedFileSet(manifest, session, protectedSurfaces, changed);
}

function inspectDirtyFiles(manifest, session, protectedSurfaces, scopes) {
  const changed = getDirtyFiles();
  return inspectChangedFileSet(manifest, session, protectedSurfaces, changed, scopes);
}

function inspectChangedFileSet(manifest, session, protectedSurfaces, changed, scopes) {
  const sidecarPaths = getWorkflowSidecarPaths(manifest);
  const protectedSurfacePatterns = getProtectedSurfacePatterns(protectedSurfaces);
  const allowedProtectedSurfacePaths = getAllowedProtectedSurfacePaths();
  const writableScope = normalizeScopes(
    typeof scopes === 'undefined' ? session.session.writable_scope : scopes,
  ).map((entry) => normalizePath(entry));
  const buckets = {
    gitAvailable: changed.gitAvailable,
    sourceMode: changed.sourceMode,
    changedPaths: changed.paths,
    primaryFiles: [],
    workflowSidecars: [],
    outOfScopeFiles: [],
    protectedSurfaceFiles: [],
    unapprovedProtectedSurfaceFiles: [],
    primaryGroup: null,
    hasSinglePrimaryGroup: true,
  };

  for (const filePath of changed.paths) {
    if (hasMatchingPathPattern(protectedSurfacePatterns, filePath)) {
      buckets.protectedSurfaceFiles.push(filePath);
      if (
        !allowedProtectedSurfacePaths.has(filePath) &&
        !hasProtectedSurfaceException(session, filePath)
      ) {
        buckets.unapprovedProtectedSurfaceFiles.push(filePath);
      }
    }

    if (sidecarPaths.has(filePath)) {
      buckets.workflowSidecars.push(filePath);
      continue;
    }

    buckets.primaryFiles.push(filePath);
    if (!isWithinScope(filePath, writableScope)) {
      buckets.outOfScopeFiles.push(filePath);
    }
  }

  buckets.primaryGroup = getSharedPathPrefix(buckets.primaryFiles);
  buckets.hasSinglePrimaryGroup =
    buckets.primaryFiles.length <= 1 || Boolean(buckets.primaryGroup);

  return buckets;
}

function normalizeGitPreflightDoc(doc) {
  return String(doc || '').replace(
    /(## Working Tree\s+```text\n)([\s\S]*?)(\n```)/,
    '$1<git-summary>\n$3',
  );
}

function generatedDocsAreFresh(expectedDocs) {
  const currentSliceMatches =
    readTextIfExists(CURRENT_SLICE_PATH) === `${expectedDocs.currentSlice}\n`;
  const nextSessionMatches =
    readTextIfExists(NEXT_SESSION_PROMPT_PATH) === `${expectedDocs.nextSessionPrompt}\n`;
  const gitPreflightMatches =
    normalizeGitPreflightDoc(readTextIfExists(GIT_PREFLIGHT_PATH)) ===
    normalizeGitPreflightDoc(`${expectedDocs.gitPreflight}\n`);

  return {
    currentSliceMatches,
    nextSessionMatches,
    gitPreflightMatches,
    allMatch: currentSliceMatches && nextSessionMatches && gitPreflightMatches,
  };
}

function countLines(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') {
    return 0;
  }
  const withoutTrailingNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTrailingNewline === ''
    ? 0
    : withoutTrailingNewline.split('\n').length;
}

function normalizeMaxLines(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (isObject(value)) {
    return normalizeMaxLines(value.max_lines);
  }
  return null;
}

function getGeneratedDocEntries(expectedDocs) {
  return [
    {
      key: 'currentSlice',
      path: normalizePath('workflow/state/generated/CURRENT_SLICE.md'),
      text: expectedDocs.currentSlice,
    },
    {
      key: 'nextSessionPrompt',
      path: normalizePath('workflow/state/generated/NEXT_SESSION_PROMPT.md'),
      text: expectedDocs.nextSessionPrompt,
    },
    {
      key: 'gitPreflight',
      path: normalizePath('workflow/state/generated/GIT_PREFLIGHT.md'),
      text: expectedDocs.gitPreflight,
    },
  ];
}

function inspectGeneratedDocLineBudgets(manifest, expectedDocs) {
  const budgets = isObject(manifest.generated_doc_budgets)
    ? manifest.generated_doc_budgets
    : {};
  const docs = getGeneratedDocEntries(expectedDocs).map((entry) => {
    const maxLines = normalizeMaxLines(budgets[entry.path]);
    const lines = countLines(entry.text);
    return {
      path: entry.path,
      lines,
      max_lines: maxLines,
      within_budget: maxLines === null || lines <= maxLines,
    };
  });
  const overBudget = docs.filter((entry) => !entry.within_budget);
  return {
    docs,
    over_budget: overBudget,
    all_within_budget: overBudget.length === 0,
  };
}

function bootstrapWorkflow() {
  const state = loadWorkflowState();
  return {
    command: 'bootstrap',
    manifest: state.manifest,
    session: state.session,
    sessionFile: state.sessionFile,
    bootstrap: {
      readingOrder:
        state.session.llm_bootstrap.reading_order ||
        DEFAULT_SESSION.llm_bootstrap.reading_order,
      nextAction:
        state.session.llm_bootstrap.next_action ||
        'run scripts/workflow status --json',
    },
    markdown: renderMarkdownBootstrap({
      manifest: state.manifest,
      session: state.session,
      sessionFile: state.sessionFile,
      bootstrap: {
        nextAction:
          state.session.llm_bootstrap.next_action ||
          'run scripts/workflow status --json',
      },
    }),
  };
}

function statusWorkflow() {
  const state = loadWorkflowState();
  return {
    command: 'status',
    ...summarizeState(state),
    markdown: renderMarkdownStatus({
      manifest: state.manifest,
      session: state.session,
      suggestion: suggestNextFromState(state.manifest, state.session),
    }),
  };
}

function assertBeginSliceDirtyTreeAllowed(manifest, session, protectedSurfaces, scopes) {
  const dirtyFiles = inspectDirtyFiles(manifest, session, protectedSurfaces, scopes);
  if (!dirtyFiles.gitAvailable) {
    return dirtyFiles;
  }
  if (dirtyFiles.changedPaths.length > 0 && scopes.length === 0) {
    throw new Error(
      `begin-slice requires at least one --scope when dirty files are present: ${dirtyFiles.changedPaths.join(', ')}`,
    );
  }
  if (dirtyFiles.outOfScopeFiles.length > 0) {
    throw new Error(
      `begin-slice dirty tree has files outside declared scope: ${dirtyFiles.outOfScopeFiles.join(', ')}`,
    );
  }
  return dirtyFiles;
}

function beginSlice(options) {
  const scopes = normalizeScopes(options.scope);
  const hypothesis = String(options.hypothesis || '').trim();
  const hypothesisCheck = String(options.check || '').trim() || null;
  if (!hypothesis) {
    throw new Error('begin-slice requires --hypothesis');
  }

  return withSessionLock('begin-slice', () => {
    const state = loadWorkflowState();
    const session = state.session;
    const dirtyFiles = assertBeginSliceDirtyTreeAllowed(
      state.manifest,
      session,
      state.protectedSurfaces,
      scopes,
    );
    if (scopes.length === 0) {
      throw new Error('begin-slice requires at least one --scope');
    }

    transitionSession(session, 'scoping', 'active');
    session.session.slice_id = createSliceId();
    session.session.hypothesis = hypothesis;
    session.session.hypothesis_check = hypothesisCheck;
    session.session.hypothesis_outcome = null;
    session.session.writable_scope = scopes;
    session.session.protected_surfaces_consulted = true;
    session.session.protected_surface_exceptions = [];
    session.session.validation_plan = [];
    session.session.validation_result = null;
    session.session.closeout_ready = false;
    session.session.blocked_reason = null;
    session.session.external_blockers = [];
    session.next_step = null;

    const entry = {
      type: 'begin-slice',
      at: session.session.updated_at,
      slice_id: session.session.slice_id,
      scope: scopes,
      hypothesis,
      hypothesis_check: hypothesisCheck,
    };
    session.history.push(entry);
    saveSession(session);
    appendDecisionLog({
      event: 'begin-slice',
      at: session.session.updated_at,
      slice_id: session.session.slice_id,
      lane: session.session.active_lane,
      scope: scopes,
      hypothesis,
      hypothesis_check: hypothesisCheck,
    });

    return {
      ok: true,
      command: 'begin-slice',
      scope: scopes,
      hypothesis,
      hypothesisCheck,
      dirtyFiles,
      session,
      markdown: renderMarkdownSlice({
        command: 'begin-slice',
        scope: scopes,
        hypothesis,
      }),
    };
  });
}

function validateCommand(options) {
  const commandText = String(options.command || '').trim();
  const run = isTrue(options.run);

  return withSessionLock('validate', () => {
    const state = loadWorkflowState();
    const session = state.session;
    const kind = normalizeValidationKind(options.kind, state.manifest);
    transitionSession(session, 'validating', 'active');
    if (!session.session.validation_plan.includes(kind)) {
      session.session.validation_plan.push(kind);
    }

    const execution = run ? runValidationCommand(commandText) : null;
    const passed = execution ? execution.exit_code === 0 : false;
    if (execution) {
      session.session.validation_result = passed
        ? getValidationResultWithExternalBlockers(
            'passed',
            getExternalBlockers(session),
          )
        : 'failed';
      session.session.closeout_ready = passed;
    } else {
      session.session.validation_result = getValidationResultWithExternalBlockers(
        'in-progress',
        getExternalBlockers(session),
      );
    }

    const entry = {
      id: `val-${randomUUID().slice(0, 8)}`,
      kind,
      command: commandText || null,
      at: session.session.updated_at,
      status: execution ? (passed ? 'passed' : 'failed') : 'recorded',
      evidence: [],
    };
    if (execution) {
      entry.execution = execution;
      session.command_log.push({
        command: commandText,
        outcome: passed ? 'pass' : 'fail',
        at: execution.at,
        exit_code: execution.exit_code,
        duration_ms: execution.duration_ms,
      });
    }
    session.validation_log.push(entry);
    session.history.push({
      type: 'validate',
      at: session.session.updated_at,
      kind,
      run,
      status: entry.status,
    });
    saveSession(session);

    return {
      ok: !execution || passed,
      command: 'validate',
      run,
      validation: entry,
      session,
    };
  });
}

function recordPass(options) {
  const commandText = String(options.command || '').trim();
  if (!commandText) {
    throw new Error('record-pass requires --command');
  }

  return withSessionLock('record-pass', () => {
    const session = loadSession();
    transitionSession(session, 'validating', 'active');
    session.session.validation_result = getValidationResultWithExternalBlockers(
      'passed',
      getExternalBlockers(session),
    );
    session.session.closeout_ready = true;

    const entry = {
      command: commandText,
      outcome: 'pass',
      at: session.session.updated_at,
    };
    session.command_log.push(entry);
    session.history.push({
      type: 'record-pass',
      at: session.session.updated_at,
      command: commandText,
    });
    saveSession(session);

    return {
      ok: true,
      command: 'record-pass',
      entry,
      session,
    };
  });
}

function recordSkip(options) {
  const commandText = String(options.command || '').trim();
  const reason = String(options.reason || '').trim();
  const blocking = isBlockingSkip(options);
  if (!commandText) {
    throw new Error('record-skip requires --command');
  }
  if (!reason) {
    throw new Error('record-skip requires --reason');
  }

  return withSessionLock('record-skip', () => {
    const session = loadSession();
    if (blocking) {
      transitionSession(session, 'blocked', 'blocked');
      session.session.validation_result = 'skipped-blocking';
      session.session.closeout_ready = false;
      session.session.blocked_reason = reason;
    } else {
      transitionSession(session, 'validating', 'active');
      session.session.blocked_reason = null;
      getExternalBlockers(session).push({
        command: commandText,
        reason,
        at: session.session.updated_at,
      });
      session.session.validation_result = getValidationResultWithExternalBlockers(
        session.session.closeout_ready ? 'passed' : 'in-progress',
        getExternalBlockers(session),
      );
    }

    const entry = {
      command: commandText,
      outcome: 'skip',
      blocking,
      reason,
      at: session.session.updated_at,
    };
    session.command_log.push(entry);
    session.history.push({
      type: 'record-skip',
      at: session.session.updated_at,
      command: commandText,
      blocking,
      reason,
    });
    saveSession(session);
    if (blocking) {
      appendDecisionLog({
        event: 'blocking-skip',
        at: session.session.updated_at,
        slice_id: session.session.slice_id,
        lane: session.session.active_lane,
        command: commandText,
        reason,
      });
    }

    return {
      ok: true,
      command: 'record-skip',
      entry,
      session,
    };
  });
}

function recordCandidate(options) {
  const candidate = String(options.candidate || '').trim();
  const status = normalizeCandidateStatus(options);
  const reason = String(options.reason || '').trim();
  if (!candidate) {
    throw new Error('record-candidate requires --candidate');
  }
  if (!reason) {
    throw new Error('record-candidate requires --reason');
  }

  return withSessionLock('record-candidate', () => {
    const session = loadSession();
    touchSession(session);

    const entry = {
      candidate,
      status,
      reason,
      at: session.session.updated_at,
    };
    session.candidate_log.push(entry);
    session.next_step = entry;
    session.history.push({
      type: 'record-candidate',
      candidate,
      status,
      reason,
      at: session.session.updated_at,
    });
    saveSession(session);

    return {
      ok: true,
      command: 'record-candidate',
      entry,
      session,
    };
  });
}

function recordProtectedSurface(options) {
  const surface = normalizePath(options.surface);
  const reason = String(options.reason || '').trim();
  if (!surface) {
    throw new Error('record-protected-surface requires --surface <path>');
  }
  if (!reason) {
    throw new Error('record-protected-surface requires --reason <text>');
  }

  return withSessionLock('record-protected-surface', () => {
    const protectedSurfaces = loadProtectedSurfaces();
    const protectedSurfacePatterns = getProtectedSurfacePatterns(protectedSurfaces);
    if (!hasMatchingPathPattern(protectedSurfacePatterns, surface)) {
      throw new Error(`path is not a protected surface: ${surface}`);
    }

    const session = loadSession();
    touchSession(session);
    session.session.protected_surfaces_consulted = true;

    const existingIndex = getProtectedSurfaceExceptions(session).findIndex(
      (entry) => normalizePath(entry.surface) === surface,
    );
    const entry = {
      surface,
      reason,
      at: session.session.updated_at,
    };
    if (existingIndex === -1) {
      getProtectedSurfaceExceptions(session).push(entry);
    } else {
      getProtectedSurfaceExceptions(session)[existingIndex] = entry;
    }
    session.history.push({
      type: 'record-protected-surface',
      at: session.session.updated_at,
      surface,
      reason,
    });
    saveSession(session);
    appendDecisionLog({
      event: 'protected-surface-exception',
      at: session.session.updated_at,
      slice_id: session.session.slice_id,
      lane: session.session.active_lane,
      surface,
      reason,
    });

    return {
      ok: true,
      command: 'record-protected-surface',
      entry,
      session,
    };
  });
}

function suggestNextFromState(manifest, session) {
  const externalBlockers = getExternalBlockers(session);
  const nextCandidate = getNextCandidate(session);
  if (
    session.session.status === 'closed' ||
    session.session.current_state === 'closeout'
  ) {
    if (!nextCandidate) {
      return {
        command: 'status',
        reason:
          'The previous slice is closed. Rerank fresh or record the next candidate before opening a new slice.',
        details: {
          rerank_required: true,
        },
      };
    }
    if (nextCandidate.status === 'open') {
      return {
        command: 'begin-slice',
        reason: `Recorded next candidate is ready: ${nextCandidate.candidate}`,
        details: {
          next_candidate: nextCandidate,
        },
      };
    }
    return {
      command: 'status',
      reason: `Recorded next candidate is ${nextCandidate.status}; rerank fresh before opening the next slice.`,
      details: {
        next_candidate: nextCandidate,
        rerank_required: true,
      },
    };
  }
  if (!session.session.hypothesis) {
    if (nextCandidate) {
      if (nextCandidate.status === 'open') {
        return {
          command: 'begin-slice',
          reason: `Recorded next candidate is ready: ${nextCandidate.candidate}`,
          details: {
            next_candidate: nextCandidate,
          },
        };
      }
      return {
        command: 'status',
        reason: `Recorded next candidate is ${nextCandidate.status}; rerank fresh before opening the next slice.`,
        details: {
          next_candidate: nextCandidate,
          rerank_required: true,
        },
      };
    }
    return {
      command: 'begin-slice',
      reason: 'No active hypothesis is recorded yet.',
      details: {
        scope_hint: ['src/'],
      },
    };
  }
  if (session.session.blocked_reason) {
    return {
      command: 'status',
      reason: 'The session is currently blocked and needs a new decision.',
      details: {
        blocked_reason: session.session.blocked_reason,
      },
    };
  }
  if (session.validation_log.length === 0) {
    return {
      command: 'validate',
      reason: 'The active slice has no recorded validation yet.',
      details: {
        validation_kinds:
          manifest.validation_kinds || DEFAULT_MANIFEST.validation_kinds,
      },
    };
  }
  if (!session.session.closeout_ready) {
    return {
      command: 'record-pass',
      reason:
        externalBlockers.length > 0
          ? 'Validation has non-blocking skipped checks recorded; add a passing command outcome or make a new blocking decision.'
          : 'Validation has started, but no successful command outcome is recorded yet.',
      details: {
        example: 'scripts/workflow record-pass --command "npm test"',
        external_blockers: externalBlockers,
      },
    };
  }
  return {
    command: 'closeout',
    reason:
      externalBlockers.length > 0
        ? 'The slice has a passing command outcome plus recorded external blockers that must be documented at closeout.'
        : 'The slice has a hypothesis, validation, and a passing command outcome.',
    details: {
      scope_count: session.session.writable_scope.length,
      external_blocker_count: externalBlockers.length,
    },
  };
}

function suggestNext() {
  const state = loadWorkflowState();
  return {
    command: 'suggest-next',
    suggestion: suggestNextFromState(state.manifest, state.session),
    session: state.session,
  };
}

function buildProtectedSurfaceBlockedReason(paths) {
  return `Protected surface changes require a recorded exception: ${paths.join(', ')}`;
}

function tryGitStatus() {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return [
      `branch: ${branch || 'unknown'}`,
      'exact working tree output omitted from generated docs; run `git status --short --branch` locally',
    ].join('\n');
  } catch (error) {
    return '(git unavailable from this kit location)';
  }
}

function buildGeneratedDocs(manifest, session) {
  const refreshedAt =
    session.session.updated_at ||
    session.session.started_at ||
    'not recorded';
  const suggestion = suggestNextFromState(manifest, session);
  return {
    currentSlice: renderCurrentSliceDoc({
      refreshedAt,
      manifest,
      session,
      suggestion,
    }),
    nextSessionPrompt: renderNextSessionPromptDoc({
      manifest,
      session,
      suggestion,
      readingOrder:
        session.llm_bootstrap.reading_order ||
        DEFAULT_SESSION.llm_bootstrap.reading_order,
    }),
    gitPreflight: renderGitPreflightDoc({
      refreshedAt,
      session,
      gitSummary: tryGitStatus(),
    }),
  };
}

function refreshWorkflow() {
  return withSessionLock('refresh', () => {
    const state = loadWorkflowState();
    const docs = buildGeneratedDocs(state.manifest, state.session);
    const lineBudgets = inspectGeneratedDocLineBudgets(state.manifest, docs);
    ensureDir(GENERATED_DIR);
    writeText(CURRENT_SLICE_PATH, `${docs.currentSlice}\n`);
    writeText(NEXT_SESSION_PROMPT_PATH, `${docs.nextSessionPrompt}\n`);
    writeText(GIT_PREFLIGHT_PATH, `${docs.gitPreflight}\n`);
    return {
      ok: lineBudgets.all_within_budget,
      command: 'refresh',
      outputs: [
        CURRENT_SLICE_PATH,
        NEXT_SESSION_PROMPT_PATH,
        GIT_PREFLIGHT_PATH,
      ],
      lineBudgets,
      session: state.session,
      suggestion: suggestNextFromState(state.manifest, state.session),
    };
  });
}

function closeoutWorkflow(options = {}) {
  const outcome = normalizeCloseoutOutcome(options);
  return withSessionLock('closeout', () => {
    const state = loadWorkflowState();
    if (!state.session.session.hypothesis) {
      throw new Error('closeout requires an active hypothesis');
    }
    if (state.session.session.blocked_reason) {
      throw new Error(
        `closeout is blocked: ${state.session.session.blocked_reason}`,
      );
    }
    if (!state.session.session.closeout_ready) {
      throw new Error(
        'closeout requires a passing validation outcome before completion',
      );
    }
    if (!isPassLikeValidationResult(state.session.session.validation_result)) {
      throw new Error(
        `closeout requires a pass-like validation result; received ${state.session.session.validation_result || 'none'}`,
      );
    }

    transitionSession(state.session, 'closeout', 'closed');
    state.session.session.closeout_ready = true;
    state.session.session.hypothesis_outcome = outcome;
    state.session.history.push({
      type: 'closeout',
      at: state.session.session.updated_at,
      outcome,
    });

    const summary = buildCloseoutSummary(state.manifest, state.session);
    appendDecisionLog({
      event: 'closeout',
      at: state.session.session.updated_at,
      slice_id: state.session.session.slice_id,
      lane: state.session.session.active_lane,
      hypothesis: state.session.session.hypothesis,
      hypothesis_check: state.session.session.hypothesis_check,
      hypothesis_outcome: state.session.session.hypothesis_outcome,
      scope: state.session.session.writable_scope,
      validation_result: state.session.session.validation_result,
      external_blockers: getExternalBlockers(state.session),
      blocked_reason: state.session.session.blocked_reason,
      next_candidate: getNextCandidate(state.session),
      next_step: suggestNextFromState(state.manifest, state.session),
    });

    saveSession(state.session);
    const docs = buildGeneratedDocs(state.manifest, state.session);
    writeText(CURRENT_SLICE_PATH, `${docs.currentSlice}\n`);
    writeText(NEXT_SESSION_PROMPT_PATH, `${docs.nextSessionPrompt}\n`);
    writeText(GIT_PREFLIGHT_PATH, `${docs.gitPreflight}\n`);
    return {
      ok: true,
      command: 'closeout',
      summary,
      refresh: [
        CURRENT_SLICE_PATH,
        NEXT_SESSION_PROMPT_PATH,
        GIT_PREFLIGHT_PATH,
      ],
      session: state.session,
      markdown: renderMarkdownCloseout({
        session: state.session,
        summary,
      }),
    };
  });
}

function buildCloseoutSummary(manifest, session) {
  const parts = [];
  parts.push(`Workflow: ${manifest.name}`);
  parts.push(`Lane: ${session.session.active_lane || 'unassigned'}`);
  parts.push(`Slice ID: ${session.session.slice_id || 'not recorded'}`);
  parts.push(`Hypothesis: ${session.session.hypothesis || 'not recorded'}`);
  parts.push(
    `Hypothesis check: ${session.session.hypothesis_check || 'not recorded'}`,
  );
  parts.push(
    `Hypothesis outcome: ${session.session.hypothesis_outcome || 'not recorded'}`,
  );
  parts.push(
    `Scope: ${session.session.writable_scope.join(', ') || 'not recorded'}`,
  );
  parts.push(
    `Validation result: ${session.session.validation_result || 'not recorded'}`,
  );
  if (session.session.blocked_reason) {
    parts.push(`Blocked reason: ${session.session.blocked_reason}`);
  }
  if (getExternalBlockers(session).length > 0) {
    parts.push(
      `External blockers: ${getExternalBlockers(session)
        .map((entry) => `${entry.command}: ${entry.reason}`)
        .join('; ')}`,
    );
  }
  if (getNextCandidate(session)) {
    parts.push(
      `Next candidate: ${getNextCandidate(session).candidate} (${getNextCandidate(
        session,
      ).status})`,
    );
  }
  parts.push(`History entries: ${session.history.length}`);
  return parts.join('\n');
}

function precommitWorkflow(options = {}) {
  return withSessionLock('precommit', () => {
    const strict = isTrue(options.strict);
    const state = loadWorkflowState();
    let session = state.session;
    const changedFiles = inspectChangedFiles(
      state.manifest,
      session,
      state.protectedSurfaces,
    );
    const expectedDocs = buildGeneratedDocs(state.manifest, session);
    const generatedDocs = generatedDocsAreFresh(expectedDocs);
    const generatedDocLineBudgets = inspectGeneratedDocLineBudgets(
      state.manifest,
      expectedDocs,
    );

    const unapprovedProtectedSurfaceFiles =
      changedFiles.unapprovedProtectedSurfaceFiles;
    if (unapprovedProtectedSurfaceFiles.length > 0) {
      const blockedReason = buildProtectedSurfaceBlockedReason(
        unapprovedProtectedSurfaceFiles,
      );
      if (
        session.session.current_state !== 'blocked' ||
        session.session.blocked_reason !== blockedReason
      ) {
        transitionSession(session, 'blocked', 'blocked');
        session.session.closeout_ready = false;
        session.session.blocked_reason = blockedReason;
        saveSession(session);
        appendDecisionLog({
          event: 'auto-block',
          at: session.session.updated_at,
          slice_id: session.session.slice_id,
          lane: session.session.active_lane,
          reason: blockedReason,
          surfaces: unapprovedProtectedSurfaceFiles,
        });
      }
    }

    const primaryFailure = unapprovedProtectedSurfaceFiles.length > 0
      ? {
          kind: 'protected_surface',
          message: buildProtectedSurfaceBlockedReason(unapprovedProtectedSurfaceFiles),
          files: unapprovedProtectedSurfaceFiles,
        }
      : null;
    const items = [
      { text: 'Manifest is present', done: pathExists(MANIFEST_PATH) },
      { text: 'Active session file is present', done: pathExists(SESSION_PATH) },
      {
        text: 'Protected surface touches are approved or workflow-managed sidecars',
        done: unapprovedProtectedSurfaceFiles.length === 0,
      },
      {
        text: 'Hypothesis is recorded',
        done: Boolean(session.session.hypothesis),
      },
      {
        text: 'Writable scope is recorded',
        done: session.session.writable_scope.length > 0,
      },
      {
        text: 'At least one validation exists',
        done: session.validation_log.length > 0,
      },
      {
        text: 'Generated docs are up to date',
        done: generatedDocs.allMatch,
      },
      {
        text: 'Generated docs stay within configured line budgets',
        done: generatedDocLineBudgets.all_within_budget,
      },
      {
        text: 'Git working tree inspection is available',
        done: changedFiles.gitAvailable,
      },
      {
        text: 'Changed files stay inside the recorded writable scope or workflow sidecars',
        done:
          changedFiles.gitAvailable &&
          changedFiles.outOfScopeFiles.length === 0,
      },
      {
        text: 'Changed files resolve to one primary slice group plus allowed sidecars',
        done:
          changedFiles.gitAvailable &&
          changedFiles.hasSinglePrimaryGroup,
      },
      {
        text: 'Session is not blocked',
        done: !session.session.blocked_reason,
      },
    ];

    const notes = [];
    if (primaryFailure) {
      notes.push(primaryFailure.message);
    }
    if (session.session.blocked_reason) {
      notes.push(`Current blocked reason: ${session.session.blocked_reason}`);
    }
    if (!pathExists(CURRENT_SLICE_PATH)) {
      notes.push('Generated docs do not exist yet. Run scripts/workflow refresh.');
    }
    if (!changedFiles.gitAvailable) {
      notes.push(
        'Git working tree inspection is unavailable at the kit root, so change-group checks could not run.',
      );
    } else if (changedFiles.changedPaths.length === 0) {
      notes.push(
        'No staged or dirty files were found at the repo root, so precommit only verified workflow state and generated docs.',
      );
    } else if (changedFiles.sourceMode === 'staged') {
      notes.push(
        'Precommit inspected staged files first. Leave unrelated dirty files unstaged when closing one slice.',
      );
    } else {
      notes.push(
        'No staged files were found, so precommit fell back to the dirty working tree.',
      );
    }
    if (!generatedDocs.allMatch) {
      const staleDocs = [];
      if (!generatedDocs.currentSliceMatches) {
        staleDocs.push('workflow/state/generated/CURRENT_SLICE.md');
      }
      if (!generatedDocs.nextSessionMatches) {
        staleDocs.push('workflow/state/generated/NEXT_SESSION_PROMPT.md');
      }
      if (!generatedDocs.gitPreflightMatches) {
        staleDocs.push('workflow/state/generated/GIT_PREFLIGHT.md');
      }
      notes.push(`Generated docs appear stale: ${staleDocs.join(', ')}`);
      notes.push(
        'If generated docs were refreshed or reformatted, rerun scripts/workflow refresh if needed and restage workflow/state/generated/* before retrying commit.',
      );
    }
    if (!generatedDocLineBudgets.all_within_budget) {
      notes.push(
        `Generated docs exceed line budgets: ${generatedDocLineBudgets.over_budget
          .map((entry) => `${entry.path} has ${entry.lines} lines (max ${entry.max_lines})`)
          .join(', ')}`,
      );
    }
    if (changedFiles.outOfScopeFiles.length > 0) {
      notes.push(
        `Out-of-scope files: ${changedFiles.outOfScopeFiles.join(', ')}`,
      );
    }
    if (!changedFiles.hasSinglePrimaryGroup && changedFiles.primaryFiles.length > 0) {
      notes.push(
        `Primary files do not share one common path prefix: ${changedFiles.primaryFiles.join(', ')}`,
      );
      notes.push(
        'Stage one primary slice group at a time and let workflow state or generated docs ride along as sidecars.',
      );
    }
    if (changedFiles.workflowSidecars.length > 0) {
      notes.push(
        `Workflow sidecars detected: ${changedFiles.workflowSidecars.join(', ')}`,
      );
    }
    if (changedFiles.protectedSurfaceFiles.length > 0) {
      notes.push(
        `Protected surfaces touched: ${changedFiles.protectedSurfaceFiles.join(', ')}`,
      );
    }
    if (getProtectedSurfaceExceptions(session).length > 0) {
      notes.push(
        `Recorded protected-surface exceptions: ${getProtectedSurfaceExceptions(session)
          .map((entry) => `${entry.surface}: ${entry.reason}`)
          .join('; ')}`,
      );
    }

    const failedItems = items.filter((item) => !item.done);
    const blockingFailure =
      Boolean(session.session.blocked_reason) ||
      unapprovedProtectedSurfaceFiles.length > 0;
    const ok = !blockingFailure && (!strict || failedItems.length === 0);

    return {
      ok,
      command: 'precommit',
      strict,
      items,
      notes,
      failed_items: failedItems.map((item) => item.text),
      primary_failure: primaryFailure,
      generatedDocs: {
        freshness: generatedDocs,
        lineBudgets: generatedDocLineBudgets,
      },
      changedFiles,
      session,
      markdown: renderMarkdownChecklist({ items, notes }),
    };
  });
}

function unlockWorkflow(options = {}) {
  if (!isTrue(options.force)) {
    throw new Error('unlock requires --force');
  }

  const existing = readSessionLock();
  if (!pathExists(SESSION_LOCK_PATH)) {
    return {
      ok: true,
      command: 'unlock',
      removed: false,
      lock: null,
    };
  }

  fs.rmSync(SESSION_LOCK_PATH, {
    force: true,
  });
  return {
    ok: true,
    command: 'unlock',
    removed: true,
    lock: existing,
  };
}

function helpWorkflow() {
  const manifest = loadManifest();
  const commands = Object.entries(
    manifest.commands || DEFAULT_MANIFEST.commands,
  ).map(([name, config]) => ({
    name,
    description: config && config.description ? config.description : '',
  }));
  return {
    command: 'help',
    title: manifest.name,
    summary: manifest.summary,
    commands,
    manifest,
  };
}

module.exports = {
  bootstrapWorkflow,
  beginSlice,
  closeoutWorkflow,
  helpWorkflow,
  precommitWorkflow,
  readFileMetadata,
  recordCandidate,
  recordProtectedSurface,
  refreshWorkflow,
  recordPass,
  recordSkip,
  renderMarkdownBootstrap,
  renderMarkdownCloseout,
  renderMarkdownHelp,
  renderMarkdownStatus,
  renderMarkdownSlice,
  statusWorkflow,
  suggestNext,
  unlockWorkflow,
  validateCommand,
};
