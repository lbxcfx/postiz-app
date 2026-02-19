#!/usr/bin/env node
/* eslint-disable no-console */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = process.cwd();
const runtimeDir = path.join(root, '.runtime');
const logDir = path.join(runtimeDir, 'logs');
const pidDir = path.join(runtimeDir, 'pids');

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(pidDir, { recursive: true });

function spawnDetached(name, command, args, cwd) {
  const outPath = path.join(logDir, `${name}.win.log`);
  const fd = fs.openSync(outPath, 'a');
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.on('error', (error) => {
    fs.appendFileSync(outPath, `[ERROR] spawn ${name} failed: ${error.message}\n`, 'utf8');
  });
  child.unref();
  if (child.pid) {
    fs.writeFileSync(path.join(pidDir, `${name}.win.pid`), `${child.pid}\n`, 'utf8');
    console.log(`[START] ${name} pid=${child.pid}`);
  } else {
    console.log(`[WARN] ${name} did not return a pid`);
  }
}

spawnDetached(
  'backend',
  'node',
  ['-r', 'dotenv/config', 'apps/backend/dist/apps/backend/src/main.js', 'dotenv_config_path=.env'],
  root
);

spawnDetached(
  'orchestrator',
  'node',
  ['-r', 'dotenv/config', 'apps/orchestrator/dist/apps/orchestrator/src/main.js', 'dotenv_config_path=.env'],
  root
);

const socialCwd = path.join(root, 'social-auto-upload-main', 'social-auto-upload-main');
spawnDetached('social_auto_upload', 'py', ['-3', 'sau_backend.py'], socialCwd);
