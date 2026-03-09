/**
 * Frontend-flow E2E regression for Materials AI analysis page.
 *
 * Covers 3 scenarios:
 * 1) Cache hit path
 * 2) Multi-click dedupe/queue behavior
 * 3) Retry path after cancellation
 *
 * Prerequisite:
 *   .\run-keepalive.cmd --once
 *
 * Usage:
 *   AUTH_TOKEN=xxx MATERIAL_E2E_VIDEO_URL=https://... node scripts/materials-ai-frontend-e2e.js
 */

const axios = require('axios');

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const BASE_URL = process.env.MATERIALS_BASE_URL || 'http://localhost:3000/api';
const PLATFORM = process.env.MATERIAL_E2E_PLATFORM || 'xhs';
const VIDEO_URL = process.env.MATERIAL_E2E_VIDEO_URL || '';
const POLL_INTERVAL_MS = Number(process.env.MATERIAL_E2E_POLL_INTERVAL_MS || 1800);
const POLL_TIMEOUT_MS = Number(process.env.MATERIAL_E2E_POLL_TIMEOUT_MS || 240000);
const REPORT_ONLY = process.env.MATERIAL_E2E_REPORT_ONLY === '1';
const MULTI_CLICK_REQUESTS = Math.max(
  2,
  Number(process.env.MATERIAL_E2E_MULTI_CLICK_REQUESTS || 6)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertOrWarn(condition, message, payload) {
  if (condition) return;
  const detail = payload ? ` | ${JSON.stringify(payload)}` : '';
  if (REPORT_ONLY) {
    console.warn(`[warn] ${message}${detail}`);
    return;
  }
  throw new Error(`${message}${detail}`);
}

function buildItem(suffix) {
  const now = Date.now();
  return {
    platform: PLATFORM,
    externalId: `frontend-e2e-${now}-${suffix}`,
    title: `Frontend E2E ${suffix}`,
    desc: `frontend e2e scenario ${suffix}`,
    contentUrl: VIDEO_URL,
    coverUrl: VIDEO_URL,
  };
}

function createClient() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 45000,
    headers: {
      auth: AUTH_TOKEN,
      'Content-Type': 'application/json',
    },
  });
}

async function pollStatus(client, jobId, timeoutMs = POLL_TIMEOUT_MS) {
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs) {
    const resp = await client.get('/materials/analysis/job-status', {
      params: { jobId },
    });
    const data = resp.data || {};
    if (['succeeded', 'failed', 'cancelled', 'missing'].includes(data.state)) {
      return data;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`poll timeout for jobId=${jobId}`);
}

async function ensureReadyResult(client, item) {
  const existing = await client.get('/materials/analysis', {
    params: { platform: item.platform, externalId: item.externalId },
  });
  if (existing.data?.found) {
    return { fromCache: true, source: existing.data?.data?.source || 'unknown' };
  }

  const trigger = await client.post('/materials/analysis/trigger', {
    item,
    force: true,
  });
  if (!trigger.data?.accepted || !trigger.data?.jobId) {
    throw new Error(`ensureReadyResult trigger failed: ${JSON.stringify(trigger.data)}`);
  }
  const status = await pollStatus(client, trigger.data.jobId);
  if (status.state !== 'succeeded') {
    throw new Error(`ensureReadyResult not succeeded: ${JSON.stringify(status)}`);
  }
  return {
    fromCache: false,
    source: status?.result?.data?.source || status?.resultSource || 'unknown',
  };
}

async function scenarioCacheHit(client) {
  const item = buildItem('cache-hit');
  const prep = await ensureReadyResult(client, item);

  const query = await client.get('/materials/analysis', {
    params: { platform: item.platform, externalId: item.externalId },
  });
  if (!query.data?.found) {
    throw new Error(`cache scenario query not found: ${JSON.stringify(query.data)}`);
  }

  const trigger = await client.post('/materials/analysis/trigger', {
    item,
    force: false,
  });
  const hitLike = Boolean(trigger.data?.found) || Boolean(trigger.data?.cacheHit);
  if (!hitLike) {
    throw new Error(`cache scenario trigger not hit-like: ${JSON.stringify(trigger.data)}`);
  }

  return {
    scenario: 'cache_hit',
    prep,
    query: {
      found: query.data?.found,
      source: query.data?.data?.source,
      cacheHit: query.data?.cacheHit,
      cacheReason: query.data?.cacheReason,
    },
    trigger: {
      found: trigger.data?.found,
      accepted: trigger.data?.accepted,
      cacheHit: trigger.data?.cacheHit,
      cacheReason: trigger.data?.cacheReason,
    },
  };
}

async function scenarioMultiClickQueue(client) {
  const item = buildItem('multi-click');

  const triggerResponses = await Promise.all(
    Array.from({ length: MULTI_CLICK_REQUESTS }, () =>
      client.post('/materials/analysis/trigger', { item, force: true })
    )
  );
  const records = triggerResponses.map((entry) => entry.data || {});
  const accepted = records.filter((entry) => Boolean(entry.accepted && entry.jobId));
  const uniqueJobIds = [...new Set(accepted.map((entry) => String(entry.jobId)))];
  const newCount = records.filter((entry) => String(entry.queueReason || '') === 'new').length;
  const reuseCount = records.filter((entry) =>
    ['inflight', 'existing'].includes(String(entry.queueReason || ''))
  ).length;

  assertOrWarn(accepted.length > 0, 'multi-click no accepted responses', { records });
  assertOrWarn(uniqueJobIds.length <= 1, 'multi-click produced multiple jobIds', {
    uniqueJobIds,
    records,
  });
  assertOrWarn(newCount <= 1, 'multi-click produced multiple new queue entries', {
    newCount,
    records,
  });
  assertOrWarn(reuseCount >= 1 || uniqueJobIds.length === 1, 'multi-click dedupe not observed', {
    reuseCount,
    uniqueJobIds,
    records,
  });

  const pollJobId = String(uniqueJobIds[0] || accepted[0]?.jobId || '');
  assertOrWarn(Boolean(pollJobId), 'multi-click missing poll jobId', { records });
  const status = await pollStatus(client, pollJobId);

  return {
    scenario: 'multi_click_queue',
    requestCount: MULTI_CLICK_REQUESTS,
    acceptedCount: accepted.length,
    uniqueJobIds,
    queueReasonStats: {
      new: newCount,
      inflight: records.filter((entry) => String(entry.queueReason || '') === 'inflight').length,
      existing: records.filter((entry) => String(entry.queueReason || '') === 'existing').length,
      unknown: records.filter((entry) =>
        !['new', 'inflight', 'existing'].includes(String(entry.queueReason || ''))
      ).length,
    },
    samples: records.slice(0, 3).map((entry) => ({
      accepted: entry.accepted,
      jobId: entry.jobId,
      queueReason: entry.queueReason,
      queuePosition: entry.queuePosition,
    })),
    dedupe: {
      sameJob: uniqueJobIds.length <= 1,
      hasReuseReason: reuseCount >= 1,
    },
    finalStatus: {
      state: status.state,
      queuePosition: status.queuePosition,
      cacheHit: status.cacheHit,
      resultSource: status.resultSource,
    },
  };
}

async function scenarioRetryAfterCancel(client) {
  const item = buildItem('retry');
  const first = await client.post('/materials/analysis/trigger', {
    item,
    force: true,
  });
  const firstData = first.data || {};
  if (!firstData.accepted || !firstData.jobId) {
    throw new Error(`retry scenario first trigger failed: ${JSON.stringify(firstData)}`);
  }

  const cancel = await client.post('/materials/analysis/cancel', {
    jobId: firstData.jobId,
  });
  const cancelData = cancel.data || {};

  const second = await client.post('/materials/analysis/trigger', {
    item,
    force: true,
  });
  const secondData = second.data || {};
  if (!secondData.accepted || !secondData.jobId) {
    throw new Error(`retry scenario second trigger failed: ${JSON.stringify(secondData)}`);
  }
  const secondStatus = await pollStatus(client, secondData.jobId);

  return {
    scenario: 'retry_after_cancel',
    first: {
      jobId: firstData.jobId,
      queueReason: firstData.queueReason,
    },
    cancel: {
      cancelled: cancelData.cancelled,
      state: cancelData.state,
      message: cancelData.message,
    },
    second: {
      jobId: secondData.jobId,
      queueReason: secondData.queueReason,
      queuePosition: secondData.queuePosition,
    },
    secondStatus: {
      state: secondStatus.state,
      resultSource: secondStatus.resultSource,
      cacheHit: secondStatus.cacheHit,
    },
  };
}

async function main() {
  if (!AUTH_TOKEN) {
    throw new Error('AUTH_TOKEN is required');
  }
  if (!VIDEO_URL) {
    throw new Error('MATERIAL_E2E_VIDEO_URL is required');
  }

  const client = createClient();
  const startedAt = new Date().toISOString();
  const output = {
    startedAt,
    baseUrl: BASE_URL,
    platform: PLATFORM,
    reportOnly: REPORT_ONLY,
    scenarios: [],
  };

  output.scenarios.push(await scenarioCacheHit(client));
  output.scenarios.push(await scenarioMultiClickQueue(client));
  output.scenarios.push(await scenarioRetryAfterCancel(client));

  const metrics = await client.get('/materials/analysis/metrics');
  output.metrics = metrics.data;
  output.finishedAt = new Date().toISOString();
  output.status = 'passed';
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  const payload = {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    platform: PLATFORM,
    error: error?.response?.data || error?.message || String(error),
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
