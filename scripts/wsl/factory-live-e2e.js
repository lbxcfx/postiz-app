#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argValue = (name) => {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    return '';
  }
  return process.argv[index + 1];
};
const argHas = (name) => process.argv.includes(`--${name}`);

const BACKEND_URL = argValue('backend-url') || process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const AUTH_TOKEN_FILE = process.env.AUTH_TOKEN_FILE || path.resolve(process.cwd(), '.runtime/auth_token.txt');
const AUTH_TOKEN =
  argValue('auth') ||
  process.env.AUTH_TOKEN ||
  (fs.existsSync(AUTH_TOKEN_FILE) ? fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim() : '');
const SHOWORG_FILE = process.env.SHOWORG_FILE || path.resolve(process.cwd(), '.runtime/showorg.txt');
const SHOWORG =
  argValue('showorg') ||
  process.env.SHOWORG ||
  (fs.existsSync(SHOWORG_FILE) ? fs.readFileSync(SHOWORG_FILE, 'utf8').trim() : '');
const PLATFORM = argValue('platform') || process.env.FACTORY_PLATFORM || 'xhs';
const KEYWORDS = argValue('keywords') || process.env.FACTORY_KEYWORDS || '内容工厂验收';
const PAGE_LIMIT = Number(argValue('page-limit') || process.env.FACTORY_PAGE_LIMIT || 1);
const POLL_INTERVAL_MS = Number(argValue('poll-interval-ms') || process.env.FACTORY_POLL_INTERVAL_MS || 5000);
const DRAFT_TIMEOUT_MS = Number(argValue('draft-timeout-ms') || process.env.FACTORY_DRAFT_TIMEOUT_MS || 600000);
const PUBLISH_TIMEOUT_MS = Number(argValue('publish-timeout-ms') || process.env.FACTORY_PUBLISH_TIMEOUT_MS || 300000);
const SCHEDULE_MINUTES = Number(argValue('schedule-minutes') || process.env.FACTORY_SCHEDULE_MINUTES || 20);
const CALL_RETRY_ATTEMPTS = Number(
  argValue('call-retry-attempts') || process.env.FACTORY_CALL_RETRY_ATTEMPTS || 6
);
const CALL_RETRY_BACKOFF_MS = Number(
  argValue('call-retry-backoff-ms') || process.env.FACTORY_CALL_RETRY_BACKOFF_MS || 2000
);
const BACKEND_READY_TIMEOUT_MS = Number(
  argValue('backend-ready-timeout-ms') || process.env.FACTORY_BACKEND_READY_TIMEOUT_MS || 120000
);
const BACKEND_READY_INTERVAL_MS = Number(
  argValue('backend-ready-interval-ms') || process.env.FACTORY_BACKEND_READY_INTERVAL_MS || 3000
);
const RUN_LIVE = argHas('live') || process.env.FACTORY_LIVE_E2E === '1';
const REPORT_DIR = argValue('report-dir') || process.env.FACTORY_E2E_REPORT_DIR || 'reports';

const runMeta = {
  startedAt: new Date().toISOString(),
  backendUrl: BACKEND_URL,
  platform: PLATFORM,
  keywords: KEYWORDS,
  pageLimit: PAGE_LIMIT,
  scheduleMinutes: SCHEDULE_MINUTES,
};
let currentWorkflowId = '';

if (!RUN_LIVE) {
  console.log('[SKIP] FACTORY_LIVE_E2E!=1, skip live factory e2e');
  process.exit(0);
}

if (!AUTH_TOKEN) {
  console.error('[FAIL] AUTH_TOKEN is required when FACTORY_LIVE_E2E=1');
  process.exit(1);
}

const headers = {
  'content-type': 'application/json',
  auth: AUTH_TOKEN,
};
if (SHOWORG) {
  headers.showorg = SHOWORG;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, options = {}) {
  const maxAttempts = Math.max(1, CALL_RETRY_ATTEMPTS);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${BACKEND_URL}${path}`, {
        ...options,
        headers: {
          ...headers,
          ...(options.headers || {}),
        },
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const message = `${path} -> ${response.status}: ${JSON.stringify(data)}`;
        const retriable = response.status >= 500 || response.status === 429;
        if (retriable && attempt < maxAttempts) {
          await sleep(CALL_RETRY_BACKOFF_MS * attempt);
          continue;
        }
        throw new Error(message);
      }
      return data;
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error);
      const retriable = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(message);
      if (!retriable || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(CALL_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastError || new Error(`Request failed: ${path}`);
}

async function waitForBackendReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BACKEND_READY_TIMEOUT_MS) {
    try {
      const response = await fetch(`${BACKEND_URL}/docs`, {
        method: 'GET',
      });
      if (response.ok) {
        return;
      }
    } catch {
      // keep retrying until timeout
    }
    await sleep(BACKEND_READY_INTERVAL_MS);
  }
  throw new Error(
    `Backend not ready within ${BACKEND_READY_TIMEOUT_MS}ms: ${BACKEND_URL}/docs`
  );
}

async function pickIntegrationId() {
  const integrationByArg = argValue('integration-id');
  if (integrationByArg) {
    return integrationByArg;
  }
  if (process.env.FACTORY_INTEGRATION_ID) {
    return process.env.FACTORY_INTEGRATION_ID;
  }
  const list = await call('/integrations/list');
  const items = Array.isArray(list) ? list : Array.isArray(list?.integrations) ? list.integrations : [];
  const usable = items.find((item) => !item?.disabled) || items[0];
  if (!usable?.id) {
    throw new Error('No integration found; set FACTORY_INTEGRATION_ID');
  }
  return usable.id;
}

async function waitForDraft(workflowId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DRAFT_TIMEOUT_MS) {
    const workflow = await call(`/factory/workflows/${workflowId}`);
    if (workflow?.status === 'FAILED' || workflow?.status === 'TERMINATED') {
      throw new Error(`Workflow ended before draft generation: ${workflow.status}`);
    }

    const draftLookup = await call(`/factory/workflows/${workflowId}/draft`);
    const target = draftLookup?.draft;
    const ready =
      target &&
      ((typeof target.content === 'string' && target.content.trim().length > 0) ||
        (typeof target.title === 'string' && target.title.trim().length > 0) ||
        target.score !== null);
    if (ready) {
      return target;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout waiting for draft of workflow ${workflowId}`);
}

async function waitForPublishJob(draftId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < PUBLISH_TIMEOUT_MS) {
    const publishLookup = await call(`/factory/drafts/${draftId}/publish-job`);
    const target = publishLookup?.publishJob;
    if (target?.status) {
      if (target.status === 'FAILED') {
        throw new Error(
          `Publish job failed: ${target.errorMessage || target.errorCode || 'unknown'}`
        );
      }
      if (
        target.status === 'SCHEDULED' ||
        target.status === 'PUBLISHED' ||
        target.status === 'PUBLISHING'
      ) {
        return target;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout waiting for publish job of draft ${draftId}`);
}

async function main() {
  console.log('[STEP] factory live e2e start');
  console.log('[STEP] wait backend ready');
  await waitForBackendReady();
  const integrationId = await pickIntegrationId();
  const idempotencyKey = `factory-e2e-${Date.now()}`;
  const scheduleAt = new Date(Date.now() + SCHEDULE_MINUTES * 60000).toISOString();

  console.log('[INFO] integrationId=', integrationId);
  console.log('[STEP] start workflow');
  const startResult = await call('/factory/workflows/start', {
    method: 'POST',
    headers: {
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      integrationId,
      collectParams: {
        platform: PLATFORM,
        keywords: KEYWORDS,
        pageLimit: PAGE_LIMIT,
      },
      productProfile: {
        scenario: 'wsl_acceptance',
        timestamp: new Date().toISOString(),
      },
      scheduleAt,
      idempotencyKey,
    }),
  });

  const workflowId = startResult?.workflowId;
  if (!workflowId) {
    throw new Error(`start workflow missing workflowId: ${JSON.stringify(startResult)}`);
  }
  currentWorkflowId = workflowId;
  console.log('[INFO] workflowId=', workflowId);

  console.log('[STEP] wait draft');
  const draft = await waitForDraft(workflowId);
  console.log('[INFO] draftId=', draft.id);

  console.log('[STEP] approve draft');
  await call(`/factory/drafts/${draft.id}/review`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      note: 'wsl live e2e auto approve',
    }),
  });

  console.log('[STEP] wait publish job');
  const job = await waitForPublishJob(draft.id);

  console.log('[DONE] live e2e passed');
  const payload = {
    status: 'passed',
    ...runMeta,
    finishedAt: new Date().toISOString(),
    integrationId,
    workflowId,
    draftId: draft.id,
    publishJobId: job.id,
    publishStatus: job.status,
    scheduledAt: job.scheduleAt,
  };
  writeReport(payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  const payload = {
    status: 'failed',
    ...runMeta,
    finishedAt: new Date().toISOString(),
    workflowId: currentWorkflowId || undefined,
    error: error?.message || String(error),
  };
  writeReport(payload);
  console.error('[FAIL] factory live e2e:', payload.error);
  process.exit(1);
});

function writeReport(payload) {
  try {
    const reportRoot = path.resolve(REPORT_DIR);
    if (!fs.existsSync(reportRoot)) {
      fs.mkdirSync(reportRoot, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(reportRoot, `factory-live-e2e-${stamp}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log('[INFO] report:', filePath);
  } catch (error) {
    console.warn('[WARN] failed to write report:', error?.message || error);
  }
}
