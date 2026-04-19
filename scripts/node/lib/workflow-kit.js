'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { ensureDir, pathExists, readTextIfExists, statIfExists, writeText } = require('./io');
const {
  MANIFEST_PATH,
  SESSION_PATH,
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
    validate: { description: 'Record one validation kind for the current slice.' },
    'record-pass': { description: 'Record a successful command outcome.' },
    'record-skip': {
      description:
        'Record a skipped command outcome; add --blocking for a hard workflow stop.',
    },
    'record-candidate': {
      description:
        'Record the next candidate as open, closed, stale, or discarded.',
    },
    'suggest-next': { description: 'Compute the next recommended workflow action.' },
    refresh: { description: 'Regenerate human-readable docs from structured state.' },
    closeout: { description: 'Close the current slice and append a decision log entry.' },
    precommit: { description: 'Run a state-focused precommit checklist.' },
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
};

const DEFAULT_SESSION = {
  version: 1,
  session: {
    status: 'seeded',
    current_state: 'seeded',
    previous_state: null,
    active_lane: 'core-import-cleanup',
    hypothesis: null,
    writable_scope: [],
    protected_surfaces_consulted: false,
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

const GIT_CHANGED_PATHS_ARGS = ['status', '--porcelain=1', '--untracked-files=all'];
const GIT_STAGED_PATHS_ARGS = [
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACDMRTUXB',
];

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
  return options.blocking === true || options.blocking === 'true';
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

function loadWorkflowState() {
  const manifest = loadManifest();
  const session = loadSession();
  return {
    manifest,
    session,
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
    ].map((entry) => normalizePath(entry)),
  );
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

function inspectChangedFiles(manifest, session) {
  const changed = getChangedFiles();
  const sidecarPaths = getWorkflowSidecarPaths(manifest);
  const writableScope = normalizeScopes(session.session.writable_scope).map((entry) =>
    normalizePath(entry),
  );
  const buckets = {
    gitAvailable: changed.gitAvailable,
    sourceMode: changed.sourceMode,
    changedPaths: changed.paths,
    primaryFiles: [],
    workflowSidecars: [],
    outOfScopeFiles: [],
    primaryGroup: null,
    hasSinglePrimaryGroup: true,
  };

  for (const filePath of changed.paths) {
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

function beginSlice(options) {
  const scopes = normalizeScopes(options.scope);
  const hypothesis = String(options.hypothesis || '').trim();
  if (scopes.length === 0) {
    throw new Error('begin-slice requires at least one --scope');
  }
  if (!hypothesis) {
    throw new Error('begin-slice requires --hypothesis');
  }

  const session = loadSession();
  transitionSession(session, 'scoping', 'active');
  session.session.hypothesis = hypothesis;
  session.session.writable_scope = scopes;
  session.session.validation_plan = [];
  session.session.validation_result = null;
  session.session.closeout_ready = false;
  session.session.blocked_reason = null;
  session.session.external_blockers = [];
  session.next_step = null;

  const entry = {
    type: 'begin-slice',
    at: session.session.updated_at,
    scope: scopes,
    hypothesis,
  };
  session.history.push(entry);
  saveSession(session);

  return {
    command: 'begin-slice',
    scope: scopes,
    hypothesis,
    session,
    markdown: renderMarkdownSlice({
      command: 'begin-slice',
      scope: scopes,
      hypothesis,
    }),
  };
}

function validateCommand(options) {
  const kind = String(options.kind || '').trim();
  const commandText = String(options.command || '').trim();
  if (!kind) {
    throw new Error('validate requires --kind');
  }

  const session = loadSession();
  transitionSession(session, 'validating', 'active');
  if (!session.session.validation_plan.includes(kind)) {
    session.session.validation_plan.push(kind);
  }
  session.session.validation_result = getValidationResultWithExternalBlockers(
    'in-progress',
    getExternalBlockers(session),
  );

  const entry = {
    kind,
    command: commandText || null,
    at: session.session.updated_at,
    status: 'recorded',
  };
  session.validation_log.push(entry);
  session.history.push({
    type: 'validate',
    at: session.session.updated_at,
    kind,
  });
  saveSession(session);

  return {
    command: 'validate',
    validation: entry,
    session,
  };
}

function recordPass(options) {
  const commandText = String(options.command || '').trim();
  if (!commandText) {
    throw new Error('record-pass requires --command');
  }

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
    command: 'record-pass',
    entry,
    session,
  };
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

  return {
    command: 'record-skip',
    entry,
    session,
  };
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
    command: 'record-candidate',
    entry,
    session,
  };
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
  const state = loadWorkflowState();
  const docs = buildGeneratedDocs(state.manifest, state.session);
  ensureDir(GENERATED_DIR);
  writeText(CURRENT_SLICE_PATH, `${docs.currentSlice}\n`);
  writeText(NEXT_SESSION_PROMPT_PATH, `${docs.nextSessionPrompt}\n`);
  writeText(GIT_PREFLIGHT_PATH, `${docs.gitPreflight}\n`);
  return {
    command: 'refresh',
    outputs: [
      CURRENT_SLICE_PATH,
      NEXT_SESSION_PROMPT_PATH,
      GIT_PREFLIGHT_PATH,
    ],
    session: state.session,
    suggestion: suggestNextFromState(state.manifest, state.session),
  };
}

function closeoutWorkflow() {
  const state = loadWorkflowState();
  transitionSession(state.session, 'closeout', 'closed');
  state.session.session.closeout_ready = true;
  state.session.history.push({
    type: 'closeout',
    at: state.session.session.updated_at,
  });

  const summary = buildCloseoutSummary(state.manifest, state.session);
  appendDecisionLog({
    at: state.session.session.updated_at,
    lane: state.session.session.active_lane,
    hypothesis: state.session.session.hypothesis,
    scope: state.session.session.writable_scope,
    validation_result: state.session.session.validation_result,
    external_blockers: getExternalBlockers(state.session),
    blocked_reason: state.session.session.blocked_reason,
    next_candidate: getNextCandidate(state.session),
    next_step: suggestNextFromState(state.manifest, state.session),
  });

  saveSession(state.session);
  const refreshResult = refreshWorkflow();
  return {
    command: 'closeout',
    summary,
    refresh: refreshResult.outputs,
    session: state.session,
    markdown: renderMarkdownCloseout({
      session: state.session,
      summary,
    }),
  };
}

function buildCloseoutSummary(manifest, session) {
  const parts = [];
  parts.push(`Workflow: ${manifest.name}`);
  parts.push(`Lane: ${session.session.active_lane || 'unassigned'}`);
  parts.push(`Hypothesis: ${session.session.hypothesis || 'not recorded'}`);
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

function precommitWorkflow() {
  const state = loadWorkflowState();
  const expectedDocs = buildGeneratedDocs(state.manifest, state.session);
  const generatedDocs = generatedDocsAreFresh(expectedDocs);
  const changedFiles = inspectChangedFiles(state.manifest, state.session);
  const items = [
    { text: 'Manifest is present', done: pathExists(MANIFEST_PATH) },
    { text: 'Active session file is present', done: pathExists(SESSION_PATH) },
    {
      text: 'Hypothesis is recorded',
      done: Boolean(state.session.session.hypothesis),
    },
    {
      text: 'Writable scope is recorded',
      done: state.session.session.writable_scope.length > 0,
    },
    {
      text: 'At least one validation exists',
      done: state.session.validation_log.length > 0,
    },
    {
      text: 'Generated docs are up to date',
      done: generatedDocs.allMatch,
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
  ];

  const notes = [];
  if (state.session.session.blocked_reason) {
    notes.push(`Current blocked reason: ${state.session.session.blocked_reason}`);
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

  return {
    command: 'precommit',
    items,
    notes,
    changedFiles,
    session: state.session,
    markdown: renderMarkdownChecklist({ items, notes }),
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
  validateCommand,
};
