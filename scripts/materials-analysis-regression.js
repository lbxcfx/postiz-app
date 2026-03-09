/**
 * Materials analysis regression runner (cross-material concurrency + cache visibility).
 *
 * Prerequisite:
 * 1) Start services: .\run-keepalive.cmd --once
 * 2) Provide AUTH token from frontend login session
 *
 * Usage:
 *   AUTH_TOKEN=xxx node scripts/materials-analysis-regression.js
 */

const axios = require('axios');

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const BASE_URL = process.env.MATERIALS_BASE_URL || 'http://localhost:3000/api';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function triggerAnalysis(client, item, force = false) {
  const resp = await client.post('/materials/analysis/trigger', {
    item,
    force,
  });
  return resp.data;
}

async function pollStatus(client, jobId, timeoutMs = 180_000) {
  const begin = Date.now();
  while (Date.now() - begin < timeoutMs) {
    const resp = await client.get('/materials/analysis/job-status', {
      params: { jobId },
    });
    const data = resp.data || {};
    if (data.state === 'succeeded' || data.state === 'failed' || data.state === 'missing') {
      return data;
    }
    await sleep(1500);
  }
  throw new Error(`poll timeout for jobId=${jobId}`);
}

async function main() {
  if (!AUTH_TOKEN) {
    throw new Error('AUTH_TOKEN is required');
  }

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30_000,
    headers: {
      auth: AUTH_TOKEN,
      'Content-Type': 'application/json',
    },
  });

  const videoUrl1 = process.env.MATERIAL_1_VIDEO_URL || '';
  const videoUrl2 = process.env.MATERIAL_2_VIDEO_URL || '';
  if (!videoUrl1 || !videoUrl2) {
    throw new Error('MATERIAL_1_VIDEO_URL and MATERIAL_2_VIDEO_URL are required');
  }

  const items = [
    {
      platform: 'xhs',
      externalId: `regression-${Date.now()}-1`,
      title: 'Regression Item 1',
      desc: 'materials analysis regression item 1',
      contentUrl: videoUrl1,
    },
    {
      platform: 'xhs',
      externalId: `regression-${Date.now()}-2`,
      title: 'Regression Item 2',
      desc: 'materials analysis regression item 2',
      contentUrl: videoUrl2,
    },
  ];

  console.log('[1/4] Triggering two materials analysis tasks...');
  const [first, second] = await Promise.all([
    triggerAnalysis(client, items[0], false),
    triggerAnalysis(client, items[1], false),
  ]);
  console.log('first:', {
    accepted: first.accepted,
    jobId: first.jobId,
    queueReason: first.queueReason,
    queuePosition: first.queuePosition,
    cacheReason: first.cacheReason,
  });
  console.log('second:', {
    accepted: second.accepted,
    jobId: second.jobId,
    queueReason: second.queueReason,
    queuePosition: second.queuePosition,
    cacheReason: second.cacheReason,
  });

  console.log('[2/4] Re-trigger first item, should reuse inflight/existing job...');
  const retryFirst = await triggerAnalysis(client, items[0], false);
  console.log('retryFirst:', {
    accepted: retryFirst.accepted,
    jobId: retryFirst.jobId,
    reused: retryFirst.reused,
    queueReason: retryFirst.queueReason,
    queuePosition: retryFirst.queuePosition,
    cacheReason: retryFirst.cacheReason,
  });

  console.log('[3/4] Polling jobs...');
  const [firstStatus, secondStatus] = await Promise.all([
    pollStatus(client, first.jobId),
    pollStatus(client, second.jobId),
  ]);
  console.log('firstStatus:', {
    state: firstStatus.state,
    queuePosition: firstStatus.queuePosition,
    resultSource: firstStatus.resultSource,
    cacheHit: firstStatus.cacheHit,
  });
  console.log('secondStatus:', {
    state: secondStatus.state,
    queuePosition: secondStatus.queuePosition,
    resultSource: secondStatus.resultSource,
    cacheHit: secondStatus.cacheHit,
  });

  console.log('[4/4] Done');

  const metricsResp = await client.get('/materials/analysis/metrics');
  console.log('[metrics]', metricsResp.data);

  if (process.env.RUN_CANCEL_SCENARIO === '1') {
    console.log('[cancel] Triggering a job and cancelling immediately...');
    const cancelItem = {
      ...items[0],
      externalId: `regression-${Date.now()}-cancel`,
      title: 'Regression Cancel Item',
    };
    const pending = await triggerAnalysis(client, cancelItem, true);
    if (!pending?.jobId) {
      throw new Error('cancel scenario failed: missing jobId');
    }
    const cancelResp = await client.post('/materials/analysis/cancel', {
      jobId: pending.jobId,
    });
    console.log('cancelResp:', cancelResp.data);
  }
}

main().catch((err) => {
  console.error('regression failed:', err.response?.data || err.message || err);
  process.exit(1);
});
