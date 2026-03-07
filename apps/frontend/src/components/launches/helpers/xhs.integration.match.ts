'use client';

type IntegrationCandidate = {
  id: string;
  name?: string | null;
  identifier?: string | null;
  internalId?: string | null;
  display?: unknown;
};

type MaterialsLoginStatus = {
  has_valid_login?: boolean;
  message?: string;
  cookies_found?: string[];
  [key: string]: unknown;
};

export const isXhsIdentifier = (identifier: unknown) => {
  const value = String(identifier || '').trim().toLowerCase();
  if (!value) return false;
  return value.includes('xiaohongshu') || value === 'xhs';
};

const XHS_LOGIN_HINT_KEYS = [
  'account_id',
  'accountId',
  'account_name',
  'accountName',
  'username',
  'user_name',
  'nickname',
  'user_id',
  'userId',
  'session_id',
  'sessionId',
] as const;

const addHintToken = (target: Set<string>, value: unknown) => {
  if (value === null || value === undefined) return;
  if (typeof value === 'number') {
    const token = String(value).trim().toLowerCase();
    if (token) target.add(token);
    return;
  }
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (!raw) return;
    target.add(raw);
    const base = raw.split(/[\\/]/).pop();
    if (base && base !== raw) target.add(base);
    raw
      .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length >= 2)
      .forEach((item) => target.add(item));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => addHintToken(target, item));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) =>
      addHintToken(target, item)
    );
  }
};

const getIntegrationTokens = (integration: IntegrationCandidate) => {
  const tokens = new Set<string>();
  addHintToken(tokens, integration.id);
  addHintToken(tokens, integration.internalId);
  addHintToken(tokens, integration.name);
  addHintToken(tokens, integration.identifier);
  addHintToken(tokens, integration.display);
  return Array.from(tokens);
};

const getLoginHintTokens = (
  status: MaterialsLoginStatus | null | undefined
) => {
  const tokens = new Set<string>();
  if (!status) return [] as string[];
  addHintToken(tokens, status.message);
  addHintToken(tokens, status.cookies_found);
  XHS_LOGIN_HINT_KEYS.forEach((key) => addHintToken(tokens, status[key]));
  addHintToken(tokens, (status as { account?: unknown }).account);
  addHintToken(tokens, (status as { data?: unknown }).data);
  return Array.from(tokens);
};

const scoreIntegrationByHints = (
  integration: IntegrationCandidate,
  loginHints: string[]
) => {
  if (loginHints.length === 0) return 0;
  const integrationTokens = getIntegrationTokens(integration);
  if (integrationTokens.length === 0) return 0;

  let score = 0;
  const idTokens = [integration.id, integration.internalId]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);

  for (const hint of loginHints) {
    for (const candidate of integrationTokens) {
      if (!hint || !candidate) continue;
      if (hint === candidate) {
        score += idTokens.includes(candidate) ? 24 : 10;
        continue;
      }
      if (
        hint.length >= 4 &&
        candidate.length >= 4 &&
        (hint.includes(candidate) || candidate.includes(hint))
      ) {
        score += 4;
      }
    }
  }
  return score;
};

export const pickDefaultXhsIntegration = (
  integrations: IntegrationCandidate[],
  loginStatus: MaterialsLoginStatus | null | undefined
) => {
  if (!integrations.length) return '';
  const loginHints = getLoginHintTokens(loginStatus);
  if (!loginHints.length) return integrations[0]?.id || '';

  const ranked = integrations
    .map((item) => ({
      id: item.id,
      score: scoreIntegrationByHints(item, loginHints),
    }))
    .sort((a, b) => b.score - a.score);

  if ((ranked[0]?.score || 0) <= 0) {
    return integrations[0]?.id || '';
  }
  return ranked[0]?.id || '';
};
