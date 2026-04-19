'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, 'workflow');
const STATE_DIR = path.join(WORKFLOW_DIR, 'state');
const GENERATED_DIR = path.join(STATE_DIR, 'generated');
const MANIFEST_PATH = path.join(WORKFLOW_DIR, 'manifest.yaml');
const SESSION_PATH = path.join(STATE_DIR, 'active-session.yaml');
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
  GENERATED_DIR,
  MANIFEST_PATH,
  SESSION_PATH,
  DECISION_LOG_PATH,
  CURRENT_SLICE_PATH,
  NEXT_SESSION_PROMPT_PATH,
  GIT_PREFLIGHT_PATH,
};
