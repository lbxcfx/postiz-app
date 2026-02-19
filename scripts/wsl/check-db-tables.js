#!/usr/bin/env node
/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRawUnsafe(
    "select tablename from pg_tables where schemaname='public' order by tablename"
  );
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
