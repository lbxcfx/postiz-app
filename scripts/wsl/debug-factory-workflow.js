#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const workflowId = process.argv[2];
if (!workflowId) {
  console.error('Usage: node scripts/wsl/debug-factory-workflow.js <workflowId>');
  process.exit(1);
}

const root = process.cwd();
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const authPath = path.join(root, '.runtime', 'auth_token.txt');
const orgPath = path.join(root, '.runtime', 'showorg.txt');
const auth = fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8').trim() : '';
const showorg = fs.existsSync(orgPath) ? fs.readFileSync(orgPath, 'utf8').trim() : '';

if (!auth) {
  console.error('Missing auth token: .runtime/auth_token.txt');
  process.exit(1);
}

const headers = { auth };
if (showorg) headers.showorg = showorg;

async function call(url) {
  const res = await fetch(`${backend}${url}`, { headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

(async () => {
  const workflow = await call(`/factory/workflows/${workflowId}`);
  console.log('workflow:', JSON.stringify(workflow, null, 2));

  const draft = await call(`/factory/workflows/${workflowId}/draft`);
  console.log('draft:', JSON.stringify(draft, null, 2));

  const logs = await call('/factory/logs?limit=100');
  const items = Array.isArray(logs.data) ? logs.data : [];
  const matched = items.filter((item) => {
    const detail = item?.detail && typeof item.detail === 'object' ? JSON.stringify(item.detail) : '';
    return (
      item?.resourceId === workflowId ||
      detail.includes(workflowId)
    );
  });
  console.log('logs matched:', JSON.stringify(matched, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
