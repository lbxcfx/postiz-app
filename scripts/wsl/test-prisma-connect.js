#!/usr/bin/env node
/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: './.env' });

async function run() {
  const url =
    process.env.DATABASE_URL ||
    'postgresql://postiz-local:postiz-local-pwd@127.0.0.1:5432/postiz-db-local';
  console.log('DATABASE_URL=', url);
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe('select 1 as x');
    console.log('OK', rows);
  } catch (error) {
    console.error('FAIL', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
