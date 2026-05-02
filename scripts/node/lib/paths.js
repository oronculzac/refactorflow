'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, 'workflow');
const STATE_DIR = path.join(WORKFLOW_DIR, 'state');
const GENERATED_DIR = path.join(STATE_DIR, 'generated');
const POLICY_DIR = path.join(WORKFLOW_DIR, 'policy');
const MANIFEST_PATH = path.join(WORKFLOW_DIR, 'manifest.yaml');
const SESSION_PATH = path.join(STATE_DIR, 'active-session.yaml');
const SESSION_LOCK_PATH = path.join(STATE_DIR, '.session.lock');
const PROTECTED_SURFACES_PATH = path.join(POLICY_DIR, 'protected-surfaces.yaml');
const DECISION_LOG_PATH = path.join(STATE_DIR, 'decision-log.ndjson');
const CURRENT_SLICE_PATH = path.join(GENERATED_DIR, 'CURRENT_SLICE.md');
const NEXT_SESSION_PROMPT_PATH = path.join(
  GENERATED_DIR,
  'NEXT_SESSION_PROMPT.md',
);
const GIT_PREFLIGHT_PATH = path.join(GENERATED_DIR, 'GIT_PREFLIGHT.md');

module.exports = {
  REPO_ROOT,
  WORKFLOW_DIR,
  STATE_DIR,
  POLICY_DIR,
  GENERATED_DIR,
  MANIFEST_PATH,
  SESSION_PATH,
  SESSION_LOCK_PATH,
  PROTECTED_SURFACES_PATH,
  DECISION_LOG_PATH,
  CURRENT_SLICE_PATH,
  NEXT_SESSION_PROMPT_PATH,
  GIT_PREFLIGHT_PATH,
};
