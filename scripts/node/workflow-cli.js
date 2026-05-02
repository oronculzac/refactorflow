#!/usr/bin/env node

'use strict';

const { parseArgv } = require('./lib/argv');
const {
  bootstrapWorkflow,
  closeoutWorkflow,
  helpWorkflow,
  unlockWorkflow,
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
  validateCommand,
  beginSlice,
} = require('./lib/workflow-kit');

function output(result, jsonMode, textRenderer) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (typeof textRenderer === 'function') {
    process.stdout.write(`${textRenderer(result)}\n`);
    return;
  }
  if (result && typeof result.markdown === 'string') {
    process.stdout.write(`${result.markdown}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function outputError(error, jsonMode, command) {
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          command,
          error: {
            message: error && error.message ? error.message : String(error),
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
}

function buildHelpText(result) {
  return renderMarkdownHelp(result);
}

function finalizeResult(result, jsonMode, textRenderer) {
  output(result, jsonMode, textRenderer);
  if (result && result.ok === false) {
    process.exitCode = 1;
  }
}

function main() {
  const parsed = parseArgv(process.argv);
  const jsonMode = Boolean(parsed.options.json);
  const command = parsed.command === '--help' ? 'help' : parsed.command;

  try {
    let result;
    switch (command) {
      case 'help':
        result = helpWorkflow();
        finalizeResult(result, jsonMode, buildHelpText);
        return;
      case 'bootstrap':
        result = bootstrapWorkflow();
        if (jsonMode) {
          result.localState = readFileMetadata(result.sessionFile);
        }
        finalizeResult(result, jsonMode, (payload) => renderMarkdownBootstrap(payload));
        return;
      case 'status':
        result = statusWorkflow();
        finalizeResult(result, jsonMode, (payload) => renderMarkdownStatus(payload));
        return;
      case 'begin-slice':
        result = beginSlice(parsed.options);
        finalizeResult(result, jsonMode, (payload) => renderMarkdownSlice(payload));
        return;
      case 'validate':
        result = validateCommand(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      case 'record-pass':
        result = recordPass(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      case 'record-skip':
        result = recordSkip(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      case 'record-candidate':
        result = recordCandidate(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      case 'record-protected-surface':
        result = recordProtectedSurface(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      case 'suggest-next':
        result = suggestNext();
        finalizeResult(result, jsonMode);
        return;
      case 'refresh':
        result = refreshWorkflow();
        finalizeResult(result, jsonMode);
        return;
      case 'closeout':
        result = closeoutWorkflow(parsed.options);
        finalizeResult(result, jsonMode, (payload) => renderMarkdownCloseout(payload));
        return;
      case 'precommit':
        result = precommitWorkflow(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      case 'unlock':
        result = unlockWorkflow(parsed.options);
        finalizeResult(result, jsonMode);
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    outputError(error, jsonMode, command);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
