#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const tokenPath =
      process.env.AUTH_TOKEN_FILE || path.resolve(process.cwd(), '.runtime/auth_token.txt');
    const showOrgOutFile =
      process.env.SHOWORG_OUT_FILE || path.resolve(process.cwd(), '.runtime/showorg.txt');
    let userId = process.env.FACTORY_USER_ID || '';
    if (!userId && fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        userId = payload?.id || '';
      }
    }

    const orgs = await prisma.organization.findMany({
      where: userId
        ? {
            users: {
              some: {
                userId,
                disabled: false,
              },
            },
          }
        : undefined,
      select: { id: true },
    });

    if (!orgs.length) {
      throw new Error('no user organization found');
    }

    const pickedOrgId = process.env.FACTORY_ORG_ID || orgs[0].id;
    const internalId = `factory-e2e-${Date.now()}`;
    const integration = await prisma.integration.create({
      data: {
        organizationId: pickedOrgId,
        internalId,
        name: 'Factory E2E Xiaohongshu',
        providerIdentifier: 'xiaohongshu',
        type: 'social',
        token: `e2e-token-${Date.now()}`,
        disabled: false,
      },
    });

    fs.mkdirSync(path.dirname(showOrgOutFile), { recursive: true });
    fs.writeFileSync(showOrgOutFile, `${pickedOrgId}\n`, 'utf8');

    console.log('[OK] integration created');
    if (userId) {
      console.log(`userId=${userId}`);
    }
    console.log(`organizationId=${pickedOrgId}`);
    console.log(`integrationId=${integration.id}`);
    console.log(`[OK] showorg saved -> ${showOrgOutFile}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message || error}`);
  process.exit(1);
});
