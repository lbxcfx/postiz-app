'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useSearchParams } from 'next/navigation';

type SourceContent = {
  id: string;
  platform: string;
  title: string | null;
  authorName: string | null;
  createdAt: string;
  mediaAssets: { id: string; type: string }[];
};

type CreationTask = {
  workflowId: string;
  status: string;
  workflowStatus?: string;
  statusReason?: string | null;
  draftId: string | null;
  reviewStatus: string | null;
  score: number | null;
  generationMode: string;
  videoStrategy: string;
  sourceCount: number;
  createdAt: string;
  imageGeneration?: {
    requested: number | null;
    generated: number;
    failed: number;
    assets: number;
    errors?: string[];
  } | null;
};

type CreationPreviewAsset = {
  id: string;
  path: string;
  type: 'image' | 'video';
};

type CreationPreviewVideo = CreationPreviewAsset & {
  strategy?: string | null;
  createdAt?: string;
};

type CreationTaskDetail = {
  workflowId: string;
  workflowStatus: string;
  createdAt: string | null;
  generationMode: string;
  videoStrategy: string;
  draft: {
    id: string;
    title: string | null;
    content: string | null;
    score: number | null;
    reviewStatus: string;
    reviewNote: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  preview: {
    images: CreationPreviewAsset[];
    videos: CreationPreviewVideo[];
    imageGeneration: {
      requested: number | null;
      generated: number;
      failed: number;
      errors: string[];
    } | null;
    videoGeneration: {
      generated: number;
      errors: string[];
    } | null;
  };
  sourceContents: Array<{
    id: string;
    platform: string;
    title: string | null;
    authorName: string | null;
    createdAt: string;
  }>;
  actions: {
    canApprove: boolean;
    canRegenerate: boolean;
    canDiscard: boolean;
  };
};

type CreationStartResult = {
  workflowId: string;
  draftId: string;
  existed: boolean;
  sourceContentIds: string[];
  generationMode: string;
  videoStrategy: string;
  imageCount?: number | null;
  n8nWorkflowId?: string | null;
  brief: {
    sourceCount: number;
    hasVideo: boolean;
    averageScore: number | null;
    hotKeywords: string[];
    styleTags: string[];
    optimizationSuggestions: string[];
    recommendedMode: string;
  };
};

type N8nWorkflowOption = {
  id: string;
  name: string;
  description: string | null;
};

type IntegrationItem = {
  id: string;
  name: string;
  identifier: string;
  internalId?: string;
  display?: unknown;
  disabled?: boolean;
};

type MaterialsLoginStatus = {
  has_valid_login?: boolean;
  message?: string;
  cookies_found?: string[];
  [key: string]: unknown;
};

type ScheduleCreationResult = {
  ok: boolean;
  workflowId: string;
  draftId: string;
  integrationId: string;
  mediaType: 'image' | 'video';
  immediate?: boolean;
  mediaCount: number;
  scheduleAt: string;
  postIds: string[];
};

type ReviewDraftResult = {
  ok: boolean;
  mediaSync?: {
    total: number;
    created: number;
    existing: number;
    error?: string;
  } | null;
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

const getIntegrationTokens = (integration: IntegrationItem) => {
  const tokens = new Set<string>();
  addHintToken(tokens, integration.id);
  addHintToken(tokens, integration.internalId);
  addHintToken(tokens, integration.name);
  addHintToken(tokens, integration.identifier);
  addHintToken(tokens, integration.display);
  return Array.from(tokens);
};

const getLoginHintTokens = (status: MaterialsLoginStatus | null | undefined) => {
  const tokens = new Set<string>();
  if (!status) {
    return [] as string[];
  }
  addHintToken(tokens, status.message);
  addHintToken(tokens, status.cookies_found);
  XHS_LOGIN_HINT_KEYS.forEach((key) => addHintToken(tokens, status[key]));
  addHintToken(tokens, (status as { account?: unknown }).account);
  addHintToken(tokens, (status as { data?: unknown }).data);
  return Array.from(tokens);
};

const scoreIntegrationByHints = (
  integration: IntegrationItem,
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

const pickDefaultXhsIntegration = (
  integrations: IntegrationItem[],
  loginStatus: MaterialsLoginStatus | null | undefined
) => {
  if (!integrations.length) return '';
  const loginHints = getLoginHintTokens(loginStatus);
  if (!loginHints.length) {
    return integrations[0]?.id || '';
  }

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

export const ContentGenerationConsole = () => {
  const fetcher = useFetch();
  const toaster = useToaster();
  const { uploadDirectory } = useVariables();
  const searchParams = useSearchParams();
  const fetcherRef = useRef(fetcher);
  const scheduleSectionRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState('');
  const [sourceContents, setSourceContents] = useState<SourceContent[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<CreationTask[]>([]);
  const [xhsIntegrations, setXhsIntegrations] = useState<IntegrationItem[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [taskDetail, setTaskDetail] = useState<CreationTaskDetail | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [actioning, setActioning] = useState<'approve' | 'regenerate' | 'discard' | ''>('');
  const [n8nWorkflows, setN8nWorkflows] = useState<N8nWorkflowOption[]>([]);
  const [result, setResult] = useState<CreationStartResult | null>(null);
  const [platformFilter, setPlatformFilter] = useState<'ALL' | 'xhs' | 'dy'>('ALL');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [form, setForm] = useState({
    generationMode: 'text' as 'text' | 'video' | 'hybrid',
    videoStrategy: 'auto' as
      | 'auto'
      | 'qwen-text-to-video'
      | 'qwen-image-to-video'
      | 'qwen-image-to-video-first-last',
    imageCount: 3,
    productProfile: '',
    n8nWorkflowId: '',
    n8nWebhookUrl: '',
  });
  const [scheduleForm, setScheduleForm] = useState({
    scheduleAt: '',
    mediaType: 'image' as 'image' | 'video',
    integrationId: '',
    title: '',
    tags: '',
  });

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    if (scheduleForm.scheduleAt) {
      return;
    }
    const initial = new Date(Date.now() + 30 * 60 * 1000);
    const local = new Date(initial.getTime() - initial.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setScheduleForm((prev) => ({ ...prev, scheduleAt: local }));
  }, [scheduleForm.scheduleAt]);

  const call = useCallback(
    async <T,>(url: string, options?: RequestInit) => {
      const requestInit: RequestInit = {
        method: 'GET',
        ...(options || {}),
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
      };
      const normalizedPath = url.startsWith('/') ? url : `/${url}`;
      const proxyUrl = `/api/backend${normalizedPath}`;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const parseResponseOrThrow = async (response: Response) => {
        if (response.ok) {
          const text = await response.text();
          if (!text) {
            return {} as T;
          }
          try {
            return JSON.parse(text) as T;
          } catch {
            return text as unknown as T;
          }
        }
        let message = `HTTP ${response.status}`;
        try {
          const text = await response.text();
          if (text) {
            let parsedMessage = '';
            try {
              const payload = JSON.parse(text) as { message?: string };
              parsedMessage = typeof payload.message === 'string' ? payload.message : '';
            } catch {
              // ignore
            }
            const fallbackText = text.length > 600 ? `${text.slice(0, 600)}...` : text;
            message = parsedMessage || fallbackText;
          }
        } catch {
          // ignore
        }
        throw new Error(message);
      };

      let lastNetworkError: Error | null = null;
      for (let i = 0; i < 5; i += 1) {
        try {
          const response = await window.fetch(proxyUrl, {
            ...requestInit,
            credentials: 'include',
            cache: 'no-store',
          });
          if (response.status >= 500 && i < 4) {
            await wait(250 * (i + 1));
            continue;
          }
          return await parseResponseOrThrow(response);
        } catch (error) {
          lastNetworkError =
            error instanceof Error ? error : new Error('Network request failed');
          if (i < 4) {
            await wait(250 * (i + 1));
            continue;
          }
        }
      }

      try {
        const directResponse = await fetcherRef.current(url, requestInit);
        return await parseResponseOrThrow(directResponse);
      } catch (error) {
        if (lastNetworkError) {
          throw new Error(
            `${lastNetworkError.message}. backend may be starting, retry in 3-5 seconds.`
          );
        }
        throw error instanceof Error ? error : new Error('Request failed');
      }
    },
    []
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const failedParts: string[] = [];
      const [sourceResp, taskResp, workflowResp, integrationResp, loginStatusResp] =
        await Promise.all([
        call<{ items: SourceContent[] }>(
          `/factory/content/paged?page=1&pageSize=40&sortBy=createdAt&sortOrder=desc`
        ).catch((reason) => {
          failedParts.push(
            reason instanceof Error ? `素材(${reason.message})` : '素材'
          );
          return { items: [] as SourceContent[] };
        }),
        call<{ items: CreationTask[] }>(`/factory/creation/tasks?limit=20`).catch(
          (reason) => {
            failedParts.push(
              reason instanceof Error ? `任务(${reason.message})` : '任务'
            );
            return { items: [] as CreationTask[] };
          }
        ),
        call<{ items: N8nWorkflowOption[] }>(`/factory/creation/n8n-workflows`).catch(() => ({
          items: [] as N8nWorkflowOption[],
        })),
        call<{ integrations: IntegrationItem[] }>(`/integrations/list`).catch((reason) => {
          failedParts.push(
            reason instanceof Error ? `账号(${reason.message})` : '账号'
          );
          return { integrations: [] as IntegrationItem[] };
        }),
        call<MaterialsLoginStatus>(`/materials/login-status?platform=xhs`).catch(
          (reason) => {
            failedParts.push(
              reason instanceof Error
                ? `登录态(${reason.message})`
                : '登录态'
            );
            return { has_valid_login: false } as MaterialsLoginStatus;
          }
        ),
      ]);
      setSourceContents(sourceResp.items || []);
      setTasks(taskResp.items || []);
      setN8nWorkflows(workflowResp.items || []);
      const xhs = (integrationResp.integrations || []).filter(
        (item) =>
          item?.identifier?.toLowerCase().includes('xiaohongshu') && !item.disabled
      );
      setXhsIntegrations(xhs);
      const preferredId = pickDefaultXhsIntegration(xhs, loginStatusResp);
      setScheduleForm((prev) => {
        if (!xhs.length) return prev;
        if (prev.integrationId && xhs.some((item) => item.id === prev.integrationId)) {
          return prev;
        }
        const nextId = preferredId || xhs[0]?.id || '';
        if (!nextId || nextId === prev.integrationId) {
          return prev;
        }
        return { ...prev, integrationId: nextId };
      });

      if (failedParts.length > 0) {
        setError(`部分数据加载失败: ${failedParts.join(' / ')}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Load failed';
      setError(message);
      toaster.show('内容生成数据加载失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [call, toaster]);

  useEffect(() => {
    loadData();
    // loadData must run only on mount; refresh is triggered manually afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedWorkflowId('');
      setTaskDetail(null);
      return;
    }
    if (!selectedWorkflowId) {
      return;
    }
    if (!tasks.some((item) => item.workflowId === selectedWorkflowId)) {
      setSelectedWorkflowId('');
      setTaskDetail(null);
    }
  }, [selectedWorkflowId, tasks]);

  useEffect(() => {
    if (!taskDetail) {
      return;
    }
    const hasImages = taskDetail.preview.images.length > 0;
    const hasVideos = taskDetail.preview.videos.length > 0;
    if (!hasImages && !hasVideos) {
      return;
    }
    if (scheduleForm.mediaType === 'video' && !hasVideos && hasImages) {
      setScheduleForm((prev) => ({ ...prev, mediaType: 'image' }));
      return;
    }
    if (scheduleForm.mediaType === 'image' && !hasImages && hasVideos) {
      setScheduleForm((prev) => ({ ...prev, mediaType: 'video' }));
      return;
    }
    if (!scheduleForm.title.trim() && taskDetail.draft?.title?.trim()) {
      setScheduleForm((prev) => ({
        ...prev,
        title: taskDetail.draft?.title?.trim() || prev.title,
      }));
    }
  }, [scheduleForm.mediaType, scheduleForm.title, taskDetail]);

  const filteredSources = useMemo(() => {
    return sourceContents.filter((item) => {
      if (platformFilter !== 'ALL' && item.platform !== platformFilter) {
        return false;
      }
      if (!keywordFilter.trim()) {
        return true;
      }
      const haystack = `${item.title || ''} ${item.authorName || ''}`.toLowerCase();
      return haystack.includes(keywordFilter.trim().toLowerCase());
    });
  }, [sourceContents, platformFilter, keywordFilter]);

  const startCreation = useCallback(async () => {
    if (selectedSourceIds.length === 0) {
      toaster.show('请至少选择一条素材', 'warning');
      return;
    }

    setStarting(true);
    setError('');
    try {
      const payload = {
        sourceContentIds: selectedSourceIds,
        generationMode: form.generationMode,
        videoStrategy: form.videoStrategy,
        imageCount: Math.max(0, Math.min(Number(form.imageCount || 0) || 0, 12)),
        ...(form.productProfile.trim()
          ? {
              productProfile: (() => {
                try {
                  return JSON.parse(form.productProfile);
                } catch {
                  return { text: form.productProfile.trim() };
                }
              })(),
            }
          : {}),
        ...(form.n8nWorkflowId.trim()
          ? {
              n8nWorkflowId: form.n8nWorkflowId.trim(),
            }
          : {}),
        ...(form.n8nWebhookUrl.trim()
          ? {
              n8nWebhookUrl: form.n8nWebhookUrl.trim(),
            }
          : {}),
      };
      const started = await call<CreationStartResult>(`/factory/creation/start`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setResult(started);
      toaster.show('内容生成任务已启动', 'success');
      await loadData();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Start failed';
      setError(message);
      toaster.show('内容生成任务启动失败', 'warning');
    } finally {
      setStarting(false);
    }
  }, [call, form, loadData, selectedSourceIds, toaster]);

  const prettyStatus = useCallback((status: string) => {
    const normalized = String(status || '').toUpperCase();
    if (normalized === 'COMPLETED') return 'DONE';
    if (normalized === 'FAILED') return 'FAIL';
    if (normalized === 'TERMINATED' || normalized === 'CANCELLED') return 'CANCELLED';
    return normalized || 'UNKNOWN';
  }, []);

  const toMediaSrc = useCallback((path: string) => {
    const normalized = String(path || '').trim().replace(/\\/g, '/');
    if (!normalized) return '';
    if (/^https?:\/\//i.test(normalized)) return normalized;

    const uploadPrefix = String(uploadDirectory || 'uploads')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const uploadRoot = `/${uploadPrefix}`;
    const fromRoot = (suffix: string) =>
      `${uploadRoot}/${suffix.replace(/^\/+/, '')}`;

    if (normalized.startsWith('local:')) {
      return fromRoot(normalized.slice('local:'.length));
    }
    if (normalized.startsWith('materials/')) {
      return fromRoot(normalized.slice('materials/'.length));
    }
    if (normalized.startsWith('/materials/')) {
      return fromRoot(normalized.slice('/materials/'.length));
    }
    if (normalized.startsWith(`${uploadPrefix}/`)) {
      return `/${normalized}`;
    }
    if (normalized.startsWith(`/${uploadPrefix}/`)) {
      return normalized;
    }

    if (/^[a-zA-Z]:\//.test(normalized)) {
      const lower = normalized.toLowerCase();
      const marker = lower.lastIndexOf(`/${uploadPrefix.toLowerCase()}/`);
      if (marker >= 0) {
        return fromRoot(normalized.slice(marker + uploadPrefix.length + 2));
      }
    }

    if (normalized.startsWith('/')) return normalized;
    return `/${normalized}`;
  }, [uploadDirectory]);

  const loadTaskDetail = useCallback(
    async (workflowId: string) => {
      if (!workflowId) return;
      setSelectedWorkflowId(workflowId);
      setDetailLoading(true);
      setDetailError('');
      try {
        const detail = await call<CreationTaskDetail>(`/factory/creation/tasks/${workflowId}`);
        setTaskDetail(detail);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Load task detail failed';
        setDetailError(message);
        setTaskDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [call]
  );

  useEffect(() => {
    if (searchParams.get('schedule') !== '1') {
      return;
    }
    if (!selectedWorkflowId && tasks[0]?.workflowId) {
      loadTaskDetail(tasks[0].workflowId);
      return;
    }
    const timer = setTimeout(() => {
      scheduleSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [loadTaskDetail, searchParams, selectedWorkflowId, tasks]);

  useEffect(() => {
    const scheduleAtFromCalendar = searchParams.get('scheduleAt');
    if (!scheduleAtFromCalendar) {
      return;
    }
    const parsed = new Date(scheduleAtFromCalendar);
    if (Number.isNaN(parsed.getTime())) {
      return;
    }
    const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setScheduleForm((prev) =>
      prev.scheduleAt === local ? prev : { ...prev, scheduleAt: local }
    );
  }, [searchParams]);

  const reviewSelectedTask = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (!taskDetail?.draft?.id) {
        toaster.show('当前任务没有可审核草稿', 'warning');
        return;
      }
      const action = decision === 'approve' ? 'approve' : 'regenerate';
      setActioning(action);
      try {
        const result = await call<ReviewDraftResult>(
          `/factory/drafts/${taskDetail.draft.id}/review`,
          {
          method: 'POST',
          body: JSON.stringify({
            decision,
            note: reviewNote.trim() || undefined,
          }),
          }
        );
        if (decision === 'approve') {
          const synced = result?.mediaSync;
          if (synced?.error) {
            toaster.show(`已通过，但同步媒体库失败：${synced.error}`, 'warning');
          } else if (synced && synced.created > 0) {
            toaster.show(`已通过，已入库 ${synced.created} 个素材`, 'success');
          } else if (synced && synced.total > 0) {
            toaster.show('已通过，素材已存在于媒体库', 'success');
          } else {
            toaster.show('已通过，但没有可入库的素材', 'warning');
          }
        } else {
          toaster.show('已提交重生请求', 'success');
        }
        await Promise.all([loadData(), loadTaskDetail(taskDetail.workflowId)]);
        if (decision === 'approve') {
          window.location.href = '/media';
          return;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Review failed';
        toaster.show(message, 'warning');
      } finally {
        setActioning('');
      }
    },
    [call, loadData, loadTaskDetail, reviewNote, taskDetail, toaster]
  );

  const discardSelectedTask = useCallback(async () => {
    if (!taskDetail?.workflowId) {
      toaster.show('请先选择任务', 'warning');
      return;
    }
    setActioning('discard');
    try {
      await call(`/factory/workflows/${taskDetail.workflowId}/cancel`, {
        method: 'POST',
      });
      toaster.show('任务已丢弃', 'success');
      await Promise.all([loadData(), loadTaskDetail(taskDetail.workflowId)]);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Discard failed';
      toaster.show(message, 'warning');
    } finally {
      setActioning('');
    }
  }, [call, loadData, loadTaskDetail, taskDetail, toaster]);

  const submitScheduleTask = useCallback(async (mode: 'schedule' | 'immediate') => {
    if (!taskDetail?.workflowId) {
      toaster.show('请先选择任务', 'warning');
      return;
    }
    if (!scheduleForm.integrationId) {
      toaster.show('请选择小红书发布账号', 'warning');
      return;
    }
    const isImmediate = mode === 'immediate';
    const scheduleAt = isImmediate
      ? new Date()
      : new Date(String(scheduleForm.scheduleAt || '').trim());
    if (!isImmediate) {
      const scheduleAtLocal = String(scheduleForm.scheduleAt || '').trim();
      if (!scheduleAtLocal) {
        toaster.show('请选择发布时间', 'warning');
        return;
      }
      if (Number.isNaN(scheduleAt.getTime())) {
        toaster.show('发布时间格式不正确', 'warning');
        return;
      }
    }

    setScheduling(true);
    try {
      const tags = scheduleForm.tags
        .split(/[,\n，、]/g)
        .map((item) => item.trim())
        .filter(Boolean);
      const result = await call<ScheduleCreationResult>(
        `/factory/creation/tasks/${taskDetail.workflowId}/schedule`,
        {
          method: 'POST',
          body: JSON.stringify({
            scheduleAt: scheduleAt.toISOString(),
            immediate: isImmediate,
            mediaType: scheduleForm.mediaType,
            integrationId: scheduleForm.integrationId,
            title: scheduleForm.title.trim() || undefined,
            tags,
          }),
        }
      );
      toaster.show(isImmediate
        ? `已提交立即发送（${result.mediaType} ${result.mediaCount} 个素材）`
        : `已定时发送到小红书（${result.mediaType} ${result.mediaCount} 个素材）`,
      'success');
      await Promise.all([loadData(), loadTaskDetail(taskDetail.workflowId)]);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Submit schedule failed';
      toaster.show(message, 'warning');
    } finally {
      setScheduling(false);
    }
  }, [call, loadData, loadTaskDetail, scheduleForm, taskDetail, toaster]);

  const scheduleSelectedTask = useCallback(async () => {
    await submitScheduleTask('schedule');
  }, [submitScheduleTask]);

  const publishNowSelectedTask = useCallback(async () => {
    await submitScheduleTask('immediate');
  }, [submitScheduleTask]);

  return (
    <div className="bg-newBgColorInner p-[20px] flex flex-1 flex-col gap-[16px] transition-all">
      <div className="rounded-[10px] border border-tableBorder bg-main p-[16px]">
        <div className="text-[18px] font-semibold text-textColor">内容生成</div>
        <div className="text-[13px] text-textColor/70 mt-[4px]">
          基于爆款素材分析结果，自动生成图文/视频。发布账号与发布动作统一在发布页面处理。
        </div>
      </div>

      <div className="rounded-[10px] border border-tableBorder bg-main p-[16px]">
        <div className="flex flex-wrap gap-[8px] items-center">
          <select
            className="bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[6px] text-[13px]"
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value as 'ALL' | 'xhs' | 'dy')}
          >
            <option value="ALL">全部平台</option>
            <option value="xhs">xhs</option>
            <option value="dy">dy</option>
          </select>
          <input
            className="bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[6px] text-[13px] min-w-[220px]"
            placeholder="按标题/作者筛选"
            value={keywordFilter}
            onChange={(e) => setKeywordFilter(e.target.value)}
          />
          <button
            className="bg-primary text-white rounded-[6px] px-[12px] py-[6px] text-[13px]"
            onClick={loadData}
            disabled={loading}
          >
            刷新
          </button>
          <button
            className="bg-sixth border border-tableBorder rounded-[6px] px-[12px] py-[6px] text-[13px]"
            onClick={() => setSelectedSourceIds(filteredSources.map((item) => item.id))}
            disabled={loading || filteredSources.length === 0}
          >
            全选当前筛选
          </button>
          <button
            className="bg-sixth border border-tableBorder rounded-[6px] px-[12px] py-[6px] text-[13px]"
            onClick={() => setSelectedSourceIds([])}
            disabled={loading || selectedSourceIds.length === 0}
          >
            清空选择
          </button>
          <div className="text-[12px] text-textColor/70">已选 {selectedSourceIds.length} 条</div>
        </div>

        <div className="overflow-x-auto mt-[12px]">
          <table className="min-w-full text-[12px] text-textColor/90">
            <thead>
              <tr className="text-left border-b border-tableBorder">
                <th className="py-[8px] pr-[8px]">选择</th>
                <th className="py-[8px] pr-[8px]">平台</th>
                <th className="py-[8px] pr-[8px]">标题</th>
                <th className="py-[8px] pr-[8px]">作者</th>
                <th className="py-[8px] pr-[8px]">媒体数</th>
              </tr>
            </thead>
            <tbody>
              {filteredSources.map((item) => (
                <tr key={item.id} className="border-b border-tableBorder/50">
                  <td className="py-[8px] pr-[8px]">
                    <input
                      type="checkbox"
                      checked={selectedSourceIds.includes(item.id)}
                      onChange={(e) =>
                        setSelectedSourceIds((prev) =>
                          e.target.checked
                            ? Array.from(new Set([...prev, item.id]))
                            : prev.filter((id) => id !== item.id)
                        )
                      }
                    />
                  </td>
                  <td className="py-[8px] pr-[8px]">{item.platform}</td>
                  <td className="py-[8px] pr-[8px] max-w-[480px] truncate">
                    {item.title || '-'}
                  </td>
                  <td className="py-[8px] pr-[8px]">{item.authorName || '-'}</td>
                  <td className="py-[8px] pr-[8px]">{item.mediaAssets?.length || 0}</td>
                </tr>
              ))}
              {filteredSources.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-[12px] text-textColor/70">
                    暂无素材
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-[10px] border border-tableBorder bg-main p-[16px]">
        <div className="text-[14px] font-semibold text-textColor mb-[10px]">生成配置</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">
          <div>
            <div className="text-[12px] mb-[4px] text-textColor/70">生成模式</div>
            <select
              className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
              value={form.generationMode}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  generationMode: e.target.value as 'text' | 'video' | 'hybrid',
                }))
              }
            >
              <option value="text">text（图文）</option>
              <option value="video">video（视频）</option>
              <option value="hybrid">hybrid（图文+视频）</option>
            </select>
          </div>
          <div>
            <div className="text-[12px] mb-[4px] text-textColor/70">视频工具策略</div>
            <select
              className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
              value={form.videoStrategy}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  videoStrategy: e.target.value as
                    | 'auto'
                    | 'qwen-text-to-video'
                    | 'qwen-image-to-video'
                    | 'qwen-image-to-video-first-last',
                }))
              }
            >
              <option value="auto">auto</option>
              <option value="qwen-text-to-video">qwen-text-to-video</option>
              <option value="qwen-image-to-video">qwen-image-to-video</option>
              <option value="qwen-image-to-video-first-last">
                qwen-image-to-video-first-last
              </option>
            </select>
          </div>
          <div>
            <div className="text-[12px] mb-[4px] text-textColor/70">生成图片数</div>
            <input
              type="number"
              min={0}
              max={12}
              className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
              value={form.imageCount}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  imageCount: Math.max(
                    0,
                    Math.min(12, Number(e.target.value || 0) || 0)
                  ),
                }))
              }
            />
          </div>
          <div>
            <div className="text-[12px] mb-[4px] text-textColor/70">
              n8n Workflow（预留）
            </div>
            <select
              className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
              value={form.n8nWorkflowId}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, n8nWorkflowId: e.target.value }))
              }
            >
              <option value="">未选择</option>
              {n8nWorkflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <div className="text-[12px] mb-[4px] text-textColor/70">
              产品画像（JSON 或文本）
            </div>
            <textarea
              className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px] min-h-[88px]"
              value={form.productProfile}
              onChange={(e) => setForm((prev) => ({ ...prev, productProfile: e.target.value }))}
              placeholder='{"brand":"xxx","tone":"专业"}'
            />
          </div>
          <div className="md:col-span-2">
            <div className="text-[12px] mb-[4px] text-textColor/70">n8n Webhook（可选）</div>
            <input
              className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
              value={form.n8nWebhookUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, n8nWebhookUrl: e.target.value }))}
              placeholder="https://your-n8n-host/webhook/..."
            />
            <div className="text-[11px] text-textColor/60 mt-[4px]">
              可直接填写 Webhook；若已选择 Workflow 且后端已配置映射，可留空。
            </div>
          </div>
        </div>
        <div className="mt-[12px] flex gap-[10px] items-center">
          <button
            className="bg-primary text-white rounded-[6px] px-[14px] py-[8px] text-[13px]"
            onClick={startCreation}
            disabled={starting || loading}
          >
            {starting ? '启动中...' : '启动内容生成'}
          </button>
          {error ? <span className="text-[12px] text-red-400">{error}</span> : null}
        </div>
      </div>

      <div className="rounded-[10px] border border-tableBorder bg-main p-[16px]">
        <div className="text-[14px] font-semibold text-textColor mb-[10px]">最近任务</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-[12px] text-textColor/90">
            <thead>
              <tr className="text-left border-b border-tableBorder">
                <th className="py-[8px] pr-[8px]">Workflow</th>
                <th className="py-[8px] pr-[8px]">状态</th>
                <th className="py-[8px] pr-[8px]">模式</th>
                <th className="py-[8px] pr-[8px]">视频策略</th>
                <th className="py-[8px] pr-[8px]">素材数</th>
                <th className="py-[8px] pr-[8px]">图片生成</th>
                <th className="py-[8px] pr-[8px]">草稿</th>
                <th className="py-[8px] pr-[8px]">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((item) => (
                <tr
                  key={item.workflowId}
                  className={`border-b border-tableBorder/50 ${selectedWorkflowId === item.workflowId ? 'bg-[#f6f8ff]/60' : ''}`}
                >
                  <td className="py-[8px] pr-[8px]">{item.workflowId.slice(0, 24)}</td>
                  <td className="py-[8px] pr-[8px]">
                    {prettyStatus(item.status)}
                    {item.statusReason ? (
                      <div
                        className="text-red-400 mt-[2px] max-w-[340px] truncate"
                        title={item.statusReason}
                      >
                        {item.statusReason}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-[8px] pr-[8px]">{item.generationMode}</td>
                  <td className="py-[8px] pr-[8px]">{item.videoStrategy}</td>
                  <td className="py-[8px] pr-[8px]">{item.sourceCount}</td>
                  <td className="py-[8px] pr-[8px]">
                    {item.imageGeneration ? (
                      <>
                        {`${item.imageGeneration.generated}/${item.imageGeneration.requested ?? '-'}（失败${item.imageGeneration.failed}）`}
                        {item.imageGeneration.errors?.length ? (
                          <div
                            className="text-red-400 mt-[2px] max-w-[340px] truncate"
                            title={item.imageGeneration.errors[0]}
                          >
                            {item.imageGeneration.errors[0]}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="py-[8px] pr-[8px]">{item.draftId ? item.draftId.slice(0, 8) : '-'}</td>
                  <td className="py-[8px] pr-[8px]">
                    <button
                      className="bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[4px] text-[12px]"
                      onClick={() => loadTaskDetail(item.workflowId)}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
              {tasks.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-[12px] text-textColor/70">
                    暂无任务
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-[10px] border border-tableBorder bg-main p-[16px]">
        <div className="flex items-center justify-between gap-[10px]">
          <div className="text-[14px] font-semibold text-textColor">预览与审核</div>
          {selectedWorkflowId ? (
            <button
              className="bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[5px] text-[12px]"
              onClick={() => loadTaskDetail(selectedWorkflowId)}
              disabled={detailLoading}
            >
              {detailLoading ? '刷新中...' : '刷新详情'}
            </button>
          ) : null}
        </div>
        {!selectedWorkflowId ? (
          <div className="text-[12px] text-textColor/70 mt-[10px]">
            请在最近任务中点击“查看”，进入预览与审核流程。
          </div>
        ) : null}
        {detailError ? <div className="text-[12px] text-red-400 mt-[10px]">{detailError}</div> : null}
        {taskDetail ? (
          <div className="mt-[12px] flex flex-col gap-[12px]">
            <div className="text-[12px] text-textColor/80">
              workflow: {taskDetail.workflowId} / 状态: {prettyStatus(taskDetail.workflowStatus)}
            </div>
            <div className="text-[12px] text-textColor/80">
              草稿状态: {taskDetail.draft?.reviewStatus || '-'} / 分数:{' '}
              {taskDetail.draft?.score ?? '-'}
            </div>
            <div className="text-[13px] font-semibold text-textColor">
              {taskDetail.draft?.title || '（无标题）'}
            </div>
            <div className="text-[12px] text-textColor/85 whitespace-pre-wrap leading-[1.6] rounded-[8px] border border-tableBorder p-[10px] bg-sixth/30 max-h-[260px] overflow-auto">
              {taskDetail.draft?.content || '-'}
            </div>

            <div className="text-[12px] text-textColor/80">
              图片生成: {taskDetail.preview.imageGeneration?.generated || 0}/
              {taskDetail.preview.imageGeneration?.requested ?? '-'}（失败
              {taskDetail.preview.imageGeneration?.failed || 0}）
            </div>
            {taskDetail.preview.imageGeneration?.errors?.length ? (
              <div className="text-[12px] text-red-400">
                图片错误: {taskDetail.preview.imageGeneration.errors[0]}
              </div>
            ) : null}

            {taskDetail.preview.images.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-[10px]">
                {taskDetail.preview.images.map((asset) => (
                  <img
                    key={asset.id}
                    src={toMediaSrc(asset.path)}
                    alt="generated"
                    className="w-full h-[180px] object-cover rounded-[8px] border border-tableBorder"
                  />
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-textColor/70">暂无生成图片</div>
            )}

            <div className="text-[12px] text-textColor/80">
              生成视频: {taskDetail.preview.videoGeneration?.generated || 0}
            </div>
            {taskDetail.preview.videoGeneration?.errors?.length ? (
              <div className="text-[12px] text-red-400">
                视频错误: {taskDetail.preview.videoGeneration.errors[0]}
              </div>
            ) : null}
            {taskDetail.preview.videos.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-[10px]">
                {taskDetail.preview.videos.map((asset) => (
                  <video
                    key={asset.id}
                    src={toMediaSrc(asset.path)}
                    controls
                    preload="metadata"
                    className="w-full rounded-[8px] border border-tableBorder bg-black"
                  />
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-textColor/70">暂无生成视频</div>
            )}

            <div className="rounded-[8px] border border-tableBorder p-[10px]">
              <div className="text-[12px] text-textColor/70 mb-[6px]">审核备注（可选）</div>
              <textarea
                className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px] min-h-[72px]"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="通过/重生时可填写原因"
              />
              <div className="mt-[10px] flex flex-wrap gap-[8px]">
                <button
                  className="bg-green-600 text-white rounded-[6px] px-[12px] py-[7px] text-[12px] disabled:opacity-60"
                  disabled={!taskDetail.actions.canApprove || actioning !== ''}
                  onClick={() => reviewSelectedTask('approve')}
                >
                  {actioning === 'approve' ? '处理中...' : '通过并进入媒体库'}
                </button>
                <button
                  className="bg-amber-500 text-white rounded-[6px] px-[12px] py-[7px] text-[12px] disabled:opacity-60"
                  disabled={!taskDetail.actions.canRegenerate || actioning !== ''}
                  onClick={() => reviewSelectedTask('reject')}
                >
                  {actioning === 'regenerate' ? '处理中...' : '不完美，重新生成'}
                </button>
                <button
                  className="bg-red-500 text-white rounded-[6px] px-[12px] py-[7px] text-[12px] disabled:opacity-60"
                  disabled={!taskDetail.actions.canDiscard || actioning !== ''}
                  onClick={discardSelectedTask}
                >
                  {actioning === 'discard' ? '处理中...' : '不好，直接丢弃'}
                </button>
                <a
                  href="/media"
                  className="bg-sixth border border-tableBorder rounded-[6px] px-[12px] py-[7px] text-[12px]"
                >
                  打开媒体库
                </a>
              </div>
            </div>

            <div
              id="creation-schedule"
              ref={scheduleSectionRef}
              className="rounded-[8px] border border-tableBorder p-[10px]"
            >
              <div className="text-[13px] font-semibold text-textColor mb-[8px]">
                发送到小红书（立即/定时）
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-[10px]">
                <div>
                  <div className="text-[12px] mb-[4px] text-textColor/70">发布时间</div>
                  <input
                    type="datetime-local"
                    className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
                    value={scheduleForm.scheduleAt}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, scheduleAt: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <div className="text-[12px] mb-[4px] text-textColor/70">素材类型</div>
                  <select
                    className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
                    value={scheduleForm.mediaType}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        mediaType: e.target.value as 'image' | 'video',
                      }))
                    }
                  >
                    <option value="image" disabled={taskDetail.preview.images.length === 0}>
                      图文（{taskDetail.preview.images.length}）
                    </option>
                    <option value="video" disabled={taskDetail.preview.videos.length === 0}>
                      视频（{taskDetail.preview.videos.length}）
                    </option>
                  </select>
                </div>
                <div>
                  <div className="text-[12px] mb-[4px] text-textColor/70">发布账号（小红书）</div>
                  <select
                    className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
                    value={scheduleForm.integrationId}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, integrationId: e.target.value }))
                    }
                  >
                    <option value="">请选择账号</option>
                    {xhsIntegrations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.identifier})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-[12px] mb-[4px] text-textColor/70">标题（可选）</div>
                  <input
                    className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
                    value={scheduleForm.title}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, title: e.target.value }))
                    }
                    placeholder="默认使用草稿标题（20字以内）"
                  />
                </div>
                <div className="md:col-span-2">
                  <div className="text-[12px] mb-[4px] text-textColor/70">
                    话题标签（可选，逗号分隔）
                  </div>
                  <input
                    className="w-full bg-sixth border border-tableBorder rounded-[6px] px-[10px] py-[7px] text-[13px]"
                    value={scheduleForm.tags}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({ ...prev, tags: e.target.value }))
                    }
                    placeholder="美妆, 护肤, 评测"
                  />
                </div>
              </div>

              <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
                <button
                  className="bg-[#ff2442] text-white rounded-[6px] px-[12px] py-[7px] text-[12px] disabled:opacity-60"
                  disabled={
                    scheduling ||
                    !scheduleForm.integrationId ||
                    (!taskDetail.preview.images.length &&
                      !taskDetail.preview.videos.length)
                  }
                  onClick={publishNowSelectedTask}
                >
                  {scheduling ? '提交中...' : '立即发送到小红书'}
                </button>
                <button
                  className="bg-primary text-white rounded-[6px] px-[12px] py-[7px] text-[12px] disabled:opacity-60"
                  disabled={
                    scheduling ||
                    !scheduleForm.integrationId ||
                    (!taskDetail.preview.images.length &&
                      !taskDetail.preview.videos.length)
                  }
                  onClick={scheduleSelectedTask}
                >
                  {scheduling ? '提交中...' : '定时发送到小红书'}
                </button>
                <a
                  href="/launches"
                  className="bg-sixth border border-tableBorder rounded-[6px] px-[12px] py-[7px] text-[12px]"
                >
                  打开日历
                </a>
                {xhsIntegrations.length === 0 ? (
                  <span className="text-[12px] text-amber-500">
                    未检测到可用的小红书账号，请先在 Integrations 连接。
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="rounded-[10px] border border-tableBorder bg-main p-[16px]">
          <div className="text-[14px] font-semibold text-textColor mb-[6px]">本次启动结果</div>
          <div className="text-[12px] text-textColor/80">
            workflow: {result.workflowId} / draft: {result.draftId}
          </div>
          <div className="text-[12px] text-textColor/80 mt-[4px]">
            推荐模式: {result.brief?.recommendedMode || '-'}，均分:{' '}
            {result.brief?.averageScore ?? '-'}
          </div>
          <div className="text-[12px] text-textColor/80 mt-[4px]">
            图片生成: {result.imageCount ?? 0}，n8n workflow: {result.n8nWorkflowId || '-'}
          </div>
          <div className="text-[12px] text-textColor/80 mt-[4px]">
            关键词: {(result.brief?.hotKeywords || []).join('、') || '-'}
          </div>
        </div>
      ) : null}
    </div>
  );
};
