#!/usr/bin/env node
/* eslint-disable no-console */
const { Connection, Client } = require('@temporalio/client');

const workflowId = process.argv[2];
if (!workflowId) {
  console.error('Usage: node scripts/wsl/temporal-workflow-error.js <workflowId>');
  process.exit(1);
}

const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

function toMessage(failure) {
  if (!failure) return '';
  const lines = [];
  let current = failure;
  let depth = 0;
  while (current && depth < 10) {
    const msg = current.message || '(no message)';
    const src = current.source ? ` [${current.source}]` : '';
    lines.push(`${'  '.repeat(depth)}- ${msg}${src}`);
    current = current.cause || null;
    depth += 1;
  }
  return lines.join('\n');
}

async function main() {
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  const handle = client.workflow.getHandle(workflowId);

  const desc = await handle.describe();
  console.log('workflow:', {
    workflowId,
    status: desc.status.name,
    startTime: desc.startTime,
    closeTime: desc.closeTime,
  });

  const history = await handle.fetchHistory();
  let failedEvent = null;
  let activityFailed = null;

  const events = Array.isArray(history?.events) ? history.events : [];
  for (const event of events) {
    if (event.workflowExecutionFailedEventAttributes) {
      failedEvent = event.workflowExecutionFailedEventAttributes;
    }
    if (event.activityTaskFailedEventAttributes) {
      activityFailed = event.activityTaskFailedEventAttributes;
    }
  }

  if (activityFailed) {
    console.log('\nactivityTaskFailed:');
    console.log('activityId:', activityFailed.scheduledEventId);
    console.log(toMessage(activityFailed.failure));
  } else {
    console.log('\nactivityTaskFailed: none');
  }

  if (failedEvent) {
    console.log('\nworkflowExecutionFailed:');
    console.log(toMessage(failedEvent.failure));
  } else {
    console.log('\nworkflowExecutionFailed: none');
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
