import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
initializeSentry('backend', true);

import { loadSwagger } from '@gitroom/helpers/swagger/load.swagger';
import { json } from 'express';
import { Runtime } from '@temporalio/worker';
if (process.env.ENABLE_TEMPORAL_RUNTIME_INSTALL === '1') {
  Runtime.install({ shutdownSignals: [] });
}

process.env.TZ = 'UTC';

import cookieParser from 'cookie-parser';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import { SubscriptionExceptionFilter } from '@gitroom/backend/services/auth/permissions/subscription.exception';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { ConfigurationChecker } from '@gitroom/helpers/configuration/configuration.checker';
import { startMcp } from '@gitroom/nestjs-libraries/chat/start.mcp';

async function start() {
  const allowedOrigins = new Set(
    [
      process.env.FRONTEND_URL,
      process.env.MAIN_URL,
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://[::1]:4200',
      'http://localhost:6274',
      'http://127.0.0.1:6274',
      'http://[::1]:6274',
    ].filter((item): item is string => Boolean(item))
  );

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    cors: {
      ...(!process.env.NOT_SECURED ? { credentials: true } : {}),
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'auth',
        'showorg',
        'impersonate',
        'sentry-trace',
        'baggage',
        'x-copilotkit-runtime-client-gql-version',
      ],
      exposedHeaders: [
        'reload',
        'onboarding',
        'activate',
        'x-copilotkit-runtime-client-gql-version',
        ...(process.env.NOT_SECURED ? ['auth', 'showorg', 'impersonate'] : []),
      ],
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        try {
          const parsed = new URL(origin);
          const isLocalHost =
            parsed.hostname === 'localhost' ||
            parsed.hostname === '127.0.0.1' ||
            parsed.hostname === '::1' ||
            parsed.hostname === '[::1]';
          const isAllowedPort = parsed.port === '4200' || parsed.port === '6274';
          if (isLocalHost && isAllowedPort) {
            callback(null, true);
            return;
          }
        } catch {
          // Ignore parse errors and fall through to deny.
        }
        callback(null, false);
      },
    },
  });

  if (process.env.DISABLE_MCP !== '1') {
    void startMcp(app).catch((error) => {
      Logger.warn(
        `MCP bootstrap failed and will be skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    })
  );

  app.use('/copilot/*', (req: any, res: any, next: any) => {
    json({ limit: '50mb' })(req, res, next);
  });

  app.use(cookieParser());
  app.useGlobalFilters(new SubscriptionExceptionFilter());
  app.useGlobalFilters(new HttpExceptionFilter());

  loadSwagger(app);

  const port = process.env.PORT || 3000;

  try {
    await app.listen(port);

    checkConfiguration(); // Do this last, so that users will see obvious issues at the end of the startup log without having to scroll up.

    Logger.log(`🚀 Backend is running on: http://localhost:${port}`);
  } catch (e) {
    Logger.error(`Backend failed to start on port ${port}`, e);
  }
}

function checkConfiguration() {
  const checker = new ConfigurationChecker();
  checker.readEnvFromProcess();
  checker.check();

  if (checker.hasIssues()) {
    for (const issue of checker.getIssues()) {
      Logger.warn(issue, 'Configuration issue');
    }

    Logger.warn('Configuration issues found: ' + checker.getIssuesCount());
  } else {
    Logger.log('Configuration check completed without any issues');
  }
}

start();
