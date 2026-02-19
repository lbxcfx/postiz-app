import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: false,
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^@gitroom/backend/(.*)$': '<rootDir>/src/$1',
    '^@gitroom/frontend/(.*)$': '<rootDir>/../frontend/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/../../libraries/helpers/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/../../libraries/nestjs-libraries/src/$1',
    '^@gitroom/react/(.*)$': '<rootDir>/../../libraries/react-shared-libraries/src/$1',
    '^@gitroom/plugins/(.*)$': '<rootDir>/../../libraries/plugins/src/$1',
    '^@gitroom/orchestrator/(.*)$': '<rootDir>/../orchestrator/src/$1',
  },
  collectCoverageFrom: ['<rootDir>/src/services/factory/factory.service.ts'],
};

export default config;
