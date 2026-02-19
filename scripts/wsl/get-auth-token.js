#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const outFile =
  process.env.AUTH_TOKEN_OUT_FILE || path.resolve(process.cwd(), '.runtime/auth_token.txt');

async function main() {
  const ts = Date.now();
  const email = `factory.e2e.${ts}@example.com`;
  const password = 'Password123!';

  const response = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      company: 'Factory E2E',
      provider: 'LOCAL',
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`register failed ${response.status}: ${body}`);
  }

  const authHeader = response.headers.get('auth');
  const setCookie = response.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/(?:^|;\s*)auth=([^;]+)/);
  const token = authHeader || (cookieMatch ? cookieMatch[1] : '');

  if (!token) {
    throw new Error('auth token not found in response headers');
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${token}\n`, 'utf8');

  console.log(`[OK] auth token saved -> ${outFile}`);
  console.log(`[INFO] account -> ${email}`);
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message || error}`);
  process.exit(1);
});
