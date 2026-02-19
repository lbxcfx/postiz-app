#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const tokenPath = process.argv[2] || path.resolve(process.cwd(), '.runtime/auth_token.txt');
const token = fs.readFileSync(tokenPath, 'utf8').trim();
const parts = token.split('.');
if (parts.length < 2) {
  throw new Error('invalid jwt');
}
const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
console.log(JSON.stringify(payload, null, 2));
