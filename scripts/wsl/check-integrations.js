#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

async function main() {
  const base = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
  const tokenPath = process.env.AUTH_TOKEN_FILE || path.resolve(process.cwd(), '.runtime/auth_token.txt');
  const showOrgPath = process.env.SHOWORG_FILE || path.resolve(process.cwd(), '.runtime/showorg.txt');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const showorg = process.env.SHOWORG || (fs.existsSync(showOrgPath) ? fs.readFileSync(showOrgPath, 'utf8').trim() : '');
  const res = await fetch(`${base}/integrations/list`, {
    headers: {
      auth: token,
      ...(showorg ? { showorg } : {}),
    },
  });
  const txt = await res.text();
  console.log('status=', res.status);
  if (showorg) {
    console.log('showorg=', showorg);
  }
  console.log(txt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
