'use strict';

const fs = require('fs');
const path = require('path');

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function readTextIfExists(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function statIfExists(filePath) {
  if (!pathExists(filePath)) {
    return null;
  }
  return fs.statSync(filePath);
}

module.exports = {
  ensureDir,
  pathExists,
  readTextIfExists,
  statIfExists,
  writeText,
};
