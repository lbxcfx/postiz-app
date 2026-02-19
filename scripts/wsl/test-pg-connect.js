#!/usr/bin/env node
/* eslint-disable no-console */
const { Client } = require('pg');
require('dotenv').config({ path: './.env' });

const urls = [
  process.env.DATABASE_URL || '',
  'postgresql://postiz-local:postiz-local-pwd@127.0.0.1:5432/postiz-db-local',
  'postgresql://postiz-local:postiz-local-pwd@127.0.0.1:5432/postiz-db-local?sslmode=disable',
  'postgresql://postiz-local:postiz-local-pwd@127.0.0.1:55432/postiz-db-local',
  'postgresql://postiz-local:postiz-local-pwd@127.0.0.1:55432/postiz-db-local?sslmode=disable',
  'postgresql://postiz-local:postiz-local-pwd@host.docker.internal:5432/postiz-db-local?sslmode=disable',
];

async function testOne(url) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  const started = Date.now();
  try {
    await client.connect();
    const res = await client.query('select current_database() as db, current_user as usr');
    console.log(
      `[OK] ${url} -> ${JSON.stringify(res.rows[0])} in ${Date.now() - started}ms`
    );
  } catch (error) {
    console.log(
      `[FAIL] ${url} -> ${error.code || 'UNKNOWN'}: ${error.message} in ${
        Date.now() - started
      }ms`
    );
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

async function main() {
  for (const url of urls.filter(Boolean)) {
    await testOne(url);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
