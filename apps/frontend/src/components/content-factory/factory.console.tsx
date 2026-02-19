'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import styles from '@gitroom/frontend/components/content-factory/factory.page.module.scss';
import { useToaster } from '@gitroom/react/toaster/toaster';

type View = 'dashboard' | 'tasks' | 'content' | 'generate' | 'publish' | 'logs';

type Draft = {
  id: string;
  title: string | null;
  score: number | null;
  reviewStatus: string;
  workflowId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PublishJob = {
  id: string;
  status: string;
  integrationId: string;
  contentDraftId: string;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  scheduleAt: string | null;
  publishedAt: string | null;
  createdAt: string;
};

type SourceContent = {
  id: string;
  platform: string;
  title: string | null;
  authorName: string | null;
  externalId: string;
  createdAt: string;
  mediaAssets: { id: string; type: string }[];
};

type AuditLog = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  traceId: string | null;
  operator: string;
  createdAt: string;
  detail?: Record<string, unknown> | null;
};

type IntegrationItem = {
  id: string;
  name: string;
  identifier: string;
  disabled: boolean;
};

type Metrics = {
  windowDays: number;
  publish: {
    total: number;
    published: number;
    failed: number;
    retryUsed: number;
    successRate: number;
    failRate: number;
  };
  review: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    regenerating: number;
    manualTakeoverRate: number;
  };
  workflow: {
    created: number;
    cancelled: number;
    failed: number;
    completedApprox: number;
  };
};

type WorkflowItem = {
  workflowId: string;
  status: string;
  draftId: string;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
};

type StageDistribution = {
  windowDays: number;
  stages: {
    COLLECTING: number;
    GENERATING: number;
    REVIEWING: number;
    PUBLISHING: number;
    COMPLETED: number;
    FAILED: number;
  };
};

type MetricsTrend = {
  windowDays: number;
  series: {
    date: string;
    publishSuccess: number;
    publishFailed: number;
    draftApproved: number;
    draftRejected: number;
    workflowCreated: number;
    workflowFailed: number;
    workflowCancelled: number;
  }[];
};

type RetryInsights = {
  windowDays: number;
  maxRetryCount: number;
  failedTotal: number;
  retryableTotal: number;
  byErrorCode: {
    errorCode: string;
    count: number;
    retryable: number;
  }[];
};

type RetryPreview = {
  skipped: boolean;
  reason: string | null;
  cooldownUntil: string | null;
  estimatedTotal: number;
  candidateSampleIds: string[];
  criteria: {
    errorCode: string | null;
    maxRetryCount: number;
    batchSize: number;
    cooldownMinutes: number;
    concurrency: number;
    force: boolean;
  };
};

type RetryHistory = {
  windowDays: number;
  items: {
    id: string;
    operator: string;
    createdAt: string;
    mode: string | null;
    skippedByCooldown: boolean;
    cooldownUntil: string | null;
    criteria: {
      errorCode: string | null;
      maxRetryCount: number;
      batchSize: number;
      cooldownMinutes: number;
      concurrency: number;
      force: boolean;
    };
    selectedCount: number;
    result: {
      total: number;
      succeeded: number;
      failed: number;
    };
  }[];
};

type RetryHistorySummary = {
  windowDays: number;
  totalBatches: number;
  skippedBatches: number;
  executedBatches: number;
  succeededJobs: number;
  failedJobs: number;
  byOperator: {
    operator: string;
    total: number;
    skipped: number;
    succeeded: number;
    failed: number;
  }[];
};

type RetryHistoryDetail = {
  id: string;
  operator: string;
  createdAt: string;
  mode: string | null;
  skippedByCooldown: boolean;
  cooldownUntil: string | null;
  criteria: {
    errorCode: string | null;
    maxRetryCount: number;
    batchSize: number;
    cooldownMinutes: number;
    concurrency: number;
    force: boolean;
  };
  selectedCount: number;
  selectedIds: string[];
  result: {
    total: number;
    succeeded: number;
    failed: number;
    failures: { publishJobId: string | null; error: string | null }[];
  };
};

type PagedResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
};

const formatTime = (value?: string | null) => {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return '-';
  return d.toLocaleString();
};

const parseProfile = (value: string) => {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
};

export const FactoryConsole = ({
  view,
  title,
  subtitle,
  badge,
}: {
  view: View;
  title: string;
  subtitle: string;
  badge: string;
}) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [publishJobs, setPublishJobs] = useState<PublishJob[]>([]);
  const [sourceContents, setSourceContents] = useState<SourceContent[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [workflowStatus, setWorkflowStatus] = useState<Record<string, string>>({});
  const [integrations, setIntegrations] = useState<IntegrationItem[]>([]);
  const [traceId, setTraceId] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [selectedDraftIds, setSelectedDraftIds] = useState<string[]>([]);
  const [selectedPublishJobIds, setSelectedPublishJobIds] = useState<string[]>([]);
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<string[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [workflowPage, setWorkflowPage] = useState(1);
  const [workflowPageSize, setWorkflowPageSize] = useState(20);
  const [workflowStatusFilter, setWorkflowStatusFilter] = useState<
    'ALL' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  >('ALL');
  const [workflowSortBy, setWorkflowSortBy] = useState<'createdAt' | 'updatedAt'>('createdAt');
  const [workflowSortOrder, setWorkflowSortOrder] = useState<'asc' | 'desc'>('desc');
  const [workflowTotalPages, setWorkflowTotalPages] = useState(1);
  const [draftPage, setDraftPage] = useState(1);
  const [draftPageSize, setDraftPageSize] = useState(20);
  const [draftSortBy, setDraftSortBy] = useState<
    'createdAt' | 'updatedAt' | 'reviewStatus' | 'score'
  >(
    'createdAt'
  );
  const [draftSortOrder, setDraftSortOrder] = useState<'asc' | 'desc'>('desc');
  const [draftTotalPages, setDraftTotalPages] = useState(1);
  const [publishPage, setPublishPage] = useState(1);
  const [publishPageSize, setPublishPageSize] = useState(20);
  const [publishSortBy, setPublishSortBy] = useState<
    'createdAt' | 'updatedAt' | 'status' | 'publishedAt' | 'retryCount'
  >('createdAt');
  const [publishSortOrder, setPublishSortOrder] = useState<'asc' | 'desc'>('desc');
  const [publishTotalPages, setPublishTotalPages] = useState(1);
  const [contentPage, setContentPage] = useState(1);
  const [contentPageSize, setContentPageSize] = useState(20);
  const [contentSortBy, setContentSortBy] = useState<'createdAt' | 'platform' | 'authorName'>(
    'createdAt'
  );
  const [contentSortOrder, setContentSortOrder] = useState<'asc' | 'desc'>('desc');
  const [contentTotalPages, setContentTotalPages] = useState(1);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(50);
  const [logsSortBy, setLogsSortBy] = useState<'createdAt' | 'action' | 'operator' | 'resourceType'>(
    'createdAt'
  );
  const [logsSortOrder, setLogsSortOrder] = useState<'asc' | 'desc'>('desc');
  const [logsTotalPages, setLogsTotalPages] = useState(1);
  const [metricsDays, setMetricsDays] = useState(7);
  const [form, setForm] = useState({
    platform: 'xhs',
    keywords: '',
    pageLimit: 1,
    integrationId: '',
    scheduleAt: '',
    productProfile: '',
  });
  const [latestWorkflowId, setLatestWorkflowId] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [stageDistribution, setStageDistribution] = useState<StageDistribution | null>(null);
  const [metricsTrend, setMetricsTrend] = useState<MetricsTrend | null>(null);
  const [retryInsights, setRetryInsights] = useState<RetryInsights | null>(null);
  const [retryErrorCodeFilter, setRetryErrorCodeFilter] = useState('');
  const [retryMaxCount, setRetryMaxCount] = useState(3);
  const [retryBatchSize, setRetryBatchSize] = useState(100);
  const [retryCooldownMinutes, setRetryCooldownMinutes] = useState(10);
  const [retryConcurrency, setRetryConcurrency] = useState(5);
  const [retryForce, setRetryForce] = useState(false);
  const [retryPreview, setRetryPreview] = useState<RetryPreview | null>(null);
  const [retryHistory, setRetryHistory] = useState<RetryHistory | null>(null);
  const [retryHistorySummary, setRetryHistorySummary] = useState<RetryHistorySummary | null>(null);
  const [retryHistoryDays, setRetryHistoryDays] = useState(7);
  const [retryHistoryLimit, setRetryHistoryLimit] = useState(20);
  const [retryHistoryOperatorFilter, setRetryHistoryOperatorFilter] = useState('');
  const [retryHistorySkippedFilter, setRetryHistorySkippedFilter] = useState<'all' | 'true' | 'false'>(
    'all'
  );
  const [retryHistoryErrorCodeFilter, setRetryHistoryErrorCodeFilter] = useState('');
  const [retryHistoryDetailMap, setRetryHistoryDetailMap] = useState<
    Record<string, RetryHistoryDetail>
  >({});
  const [expandedRetryHistoryIds, setExpandedRetryHistoryIds] = useState<string[]>([]);
  const [trendMode, setTrendMode] = useState<'publish' | 'review' | 'workflow'>('publish');
  const [expandedBulkLogIds, setExpandedBulkLogIds] = useState<string[]>([]);

  const call = useCallback(
    async <T,>(url: string, options?: RequestInit): Promise<T> => {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok) {
        const rawMessage =
          data && typeof data.message === 'string'
            ? data.message
            : Array.isArray(data?.message)
            ? data.message.join(', ')
            : data?.error || 'Request failed';
        const code = data?.code || data?.errorCode || 'FACTORY_REQUEST_FAILED';
        throw new Error(`${code}: ${rawMessage}`);
      }
      return data as T;
    },
    [fetch]
  );

  const loadIntegrations = useCallback(async () => {
    const data = await call<{ integrations: IntegrationItem[] }>('/integrations/list');
    const xhs = (data.integrations || []).filter(
      (item) => item.identifier?.toLowerCase().includes('xiaohongshu') && !item.disabled
    );
    setIntegrations(xhs);
    if (!form.integrationId && xhs[0]?.id) {
      setForm((prev) => ({ ...prev, integrationId: xhs[0].id }));
    }
  }, [call, form.integrationId]);

  const loadCoreData = useCallback(async () => {
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const requests: Promise<unknown>[] = [];
      if (view === 'dashboard' || view === 'tasks') {
        const query = new URLSearchParams({
          page: String(workflowPage),
          pageSize: String(workflowPageSize),
          status: workflowStatusFilter,
          sortBy: workflowSortBy,
          sortOrder: workflowSortOrder,
        });
        requests.push(
          call<PagedResult<WorkflowItem>>(`/factory/workflows/paged?${query.toString()}`).then(
            (res) => {
              setWorkflows(res.items || []);
              setWorkflowTotalPages(res.totalPages || 1);
            }
          )
        );
      }
      if (view === 'dashboard' || view === 'tasks' || view === 'generate') {
        const query = new URLSearchParams({
          page: String(draftPage),
          pageSize: String(draftPageSize),
          sortBy: draftSortBy,
          sortOrder: draftSortOrder,
        });
        requests.push(
          call<PagedResult<Draft>>(`/factory/drafts/paged?${query.toString()}`).then((res) => {
            setDrafts(res.items || []);
            setDraftTotalPages(res.totalPages || 1);
          })
        );
      }
      if (view === 'dashboard' || view === 'publish') {
        const query = new URLSearchParams({
          page: String(publishPage),
          pageSize: String(publishPageSize),
          sortBy: publishSortBy,
          sortOrder: publishSortOrder,
        });
        requests.push(
          call<PagedResult<PublishJob>>(`/factory/publish-jobs/paged?${query.toString()}`).then(
            (res) => {
              setPublishJobs(res.items || []);
              setPublishTotalPages(res.totalPages || 1);
            }
          )
        );
      }
      if (view === 'dashboard' || view === 'content') {
        const query = new URLSearchParams({
          page: String(contentPage),
          pageSize: String(contentPageSize),
          sortBy: contentSortBy,
          sortOrder: contentSortOrder,
        });
        requests.push(
          call<PagedResult<SourceContent>>(`/factory/content/paged?${query.toString()}`).then(
            (res) => {
              setSourceContents(res.items || []);
              setContentTotalPages(res.totalPages || 1);
            }
          )
        );
      }
      if (view === 'dashboard' || view === 'logs') {
        const search = new URLSearchParams();
        search.set('page', String(logsPage));
        search.set('pageSize', String(logsPageSize));
        search.set('sortBy', logsSortBy);
        search.set('sortOrder', logsSortOrder);
        if (traceId) search.set('trace_id', traceId);
        if (operatorFilter) search.set('operator', operatorFilter);
        if (actionFilter) search.set('action', actionFilter);
        if (fromTime) search.set('from', new Date(fromTime).toISOString());
        if (toTime) search.set('to', new Date(toTime).toISOString());
        const query = `?${search.toString()}`;
        requests.push(
          call<PagedResult<AuditLog>>(`/factory/logs/paged${query}`).then((res) => {
            setLogs(res.items || []);
            setLogsTotalPages(res.totalPages || 1);
          })
        );
      }
      if (view === 'generate' || view === 'publish') {
        requests.push(loadIntegrations());
      }
      if (view === 'dashboard') {
        requests.push(call<Metrics>(`/factory/metrics?days=${metricsDays}`).then(setMetrics));
        requests.push(
          call<StageDistribution>(`/factory/metrics/stages?days=${metricsDays}`).then(
            setStageDistribution
          )
        );
        requests.push(
          call<MetricsTrend>(`/factory/metrics/trend?days=${metricsDays}`).then(setMetricsTrend)
        );
        requests.push(
          call<RetryInsights>(
            `/factory/publish-jobs/retry-insights?days=${metricsDays}&maxRetryCount=${retryMaxCount}`
          ).then(setRetryInsights)
        );
        requests.push(
          call<RetryPreview>(
            `/factory/publish-jobs/retry-preview?maxRetryCount=${retryMaxCount}&batchSize=${retryBatchSize}&cooldownMinutes=${retryCooldownMinutes}&concurrency=${retryConcurrency}&force=${
              retryForce ? '1' : '0'
            }${
              retryErrorCodeFilter ? `&errorCode=${encodeURIComponent(retryErrorCodeFilter)}` : ''
            }`
          ).then(setRetryPreview)
        );
        requests.push(
          call<RetryHistory>(
            `/factory/publish-jobs/retry-history?days=${retryHistoryDays}&limit=${retryHistoryLimit}${
              retryHistoryOperatorFilter ? `&operator=${encodeURIComponent(retryHistoryOperatorFilter)}` : ''
            }${
              retryHistorySkippedFilter !== 'all' ? `&skipped=${retryHistorySkippedFilter}` : ''
            }${
              retryHistoryErrorCodeFilter
                ? `&errorCode=${encodeURIComponent(retryHistoryErrorCodeFilter)}`
                : ''
            }`
          ).then(setRetryHistory)
        );
        requests.push(
          call<RetryHistorySummary>(
            `/factory/publish-jobs/retry-history/summary?days=${retryHistoryDays}${
              retryHistoryOperatorFilter ? `&operator=${encodeURIComponent(retryHistoryOperatorFilter)}` : ''
            }${
              retryHistorySkippedFilter !== 'all' ? `&skipped=${retryHistorySkippedFilter}` : ''
            }${
              retryHistoryErrorCodeFilter
                ? `&errorCode=${encodeURIComponent(retryHistoryErrorCodeFilter)}`
                : ''
            }`
          ).then(setRetryHistorySummary)
        );
      }
      if (view === 'publish') {
        requests.push(
          call<RetryInsights>(
            `/factory/publish-jobs/retry-insights?days=${metricsDays}&maxRetryCount=${retryMaxCount}`
          ).then(setRetryInsights)
        );
        requests.push(
          call<RetryPreview>(
            `/factory/publish-jobs/retry-preview?maxRetryCount=${retryMaxCount}&batchSize=${retryBatchSize}&cooldownMinutes=${retryCooldownMinutes}&concurrency=${retryConcurrency}&force=${
              retryForce ? '1' : '0'
            }${
              retryErrorCodeFilter ? `&errorCode=${encodeURIComponent(retryErrorCodeFilter)}` : ''
            }`
          ).then(setRetryPreview)
        );
        requests.push(
          call<RetryHistory>(
            `/factory/publish-jobs/retry-history?days=${retryHistoryDays}&limit=${retryHistoryLimit}${
              retryHistoryOperatorFilter ? `&operator=${encodeURIComponent(retryHistoryOperatorFilter)}` : ''
            }${
              retryHistorySkippedFilter !== 'all' ? `&skipped=${retryHistorySkippedFilter}` : ''
            }${
              retryHistoryErrorCodeFilter
                ? `&errorCode=${encodeURIComponent(retryHistoryErrorCodeFilter)}`
                : ''
            }`
          ).then(setRetryHistory)
        );
        requests.push(
          call<RetryHistorySummary>(
            `/factory/publish-jobs/retry-history/summary?days=${retryHistoryDays}${
              retryHistoryOperatorFilter ? `&operator=${encodeURIComponent(retryHistoryOperatorFilter)}` : ''
            }${
              retryHistorySkippedFilter !== 'all' ? `&skipped=${retryHistorySkippedFilter}` : ''
            }${
              retryHistoryErrorCodeFilter
                ? `&errorCode=${encodeURIComponent(retryHistoryErrorCodeFilter)}`
                : ''
            }`
          ).then(setRetryHistorySummary)
        );
      }
      await Promise.all(requests);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Load failed';
      const [code, ...rest] = message.split(':');
      if (rest.length > 0) {
        setErrorCode(code.trim());
        setError(rest.join(':').trim());
      } else {
        setErrorCode('FACTORY_LOAD_FAILED');
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [
    actionFilter,
    call,
    contentPage,
    contentPageSize,
    contentSortBy,
    contentSortOrder,
    draftPage,
    draftPageSize,
    draftSortBy,
    draftSortOrder,
    fromTime,
    loadIntegrations,
    operatorFilter,
    publishPage,
    publishPageSize,
    publishSortBy,
    publishSortOrder,
    retryBatchSize,
    retryHistoryDays,
    retryHistoryErrorCodeFilter,
    retryHistoryLimit,
    retryHistoryOperatorFilter,
    retryHistorySkippedFilter,
    retryConcurrency,
    retryCooldownMinutes,
    retryErrorCodeFilter,
    retryForce,
    retryMaxCount,
    workflowPage,
    workflowPageSize,
    workflowSortBy,
    workflowSortOrder,
    workflowStatusFilter,
    logsPage,
    logsPageSize,
    logsSortBy,
    logsSortOrder,
    metricsDays,
    toTime,
    traceId,
    view,
  ]);

  useEffect(() => {
    loadCoreData();
  }, [loadCoreData]);

  useEffect(() => {
    setSelectedDraftIds((prev) => prev.filter((id) => drafts.some((item) => item.id === id)));
  }, [drafts]);

  useEffect(() => {
    setSelectedPublishJobIds((prev) =>
      prev.filter((id) => publishJobs.some((item) => item.id === id))
    );
  }, [publishJobs]);

  useEffect(() => {
    setSelectedWorkflowIds((prev) =>
      prev.filter((id) => workflows.some((item) => item.workflowId === id))
    );
  }, [workflows]);

  const syncWorkflowStatuses = useCallback(async () => {
    const workflowIds = drafts
      .map((item) => item.workflowId)
      .filter((item): item is string => Boolean(item));
    if (workflowIds.length === 0) {
      return;
    }
    try {
      const response = await call<{ statuses: { workflowId: string; status: string }[] }>(
        '/factory/workflows/status/batch',
        {
          method: 'POST',
          body: JSON.stringify({ workflowIds }),
        }
      );
      const next = (response.statuses || []).reduce<Record<string, string>>((acc, item) => {
        acc[item.workflowId] = item.status;
        return acc;
      }, {});
      setWorkflowStatus((prev) => ({ ...prev, ...next }));
    } catch (e) {
      // Keep current status cache if sync fails.
    }
  }, [call, drafts]);

  useEffect(() => {
    if (!['tasks', 'dashboard', 'generate'].includes(view)) {
      return;
    }
    syncWorkflowStatuses();
    const timer = setInterval(syncWorkflowStatuses, 8000);
    return () => clearInterval(timer);
  }, [syncWorkflowStatuses, view]);

  const startWorkflow = useCallback(async () => {
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const payload = {
        integrationId: form.integrationId,
        collectParams: {
          platform: form.platform as 'xhs' | 'dy',
          keywords: form.keywords,
          pageLimit: Number(form.pageLimit || 1),
        },
        productProfile: parseProfile(form.productProfile),
        ...(form.scheduleAt ? { scheduleAt: new Date(form.scheduleAt).toISOString() } : {}),
      };
      const result = await call<{ workflowId: string }>('/factory/workflows/start', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setLatestWorkflowId(result.workflowId);
      toaster.show('工作流已启动', 'success');
      await loadCoreData();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Start failed';
      const [code, ...rest] = message.split(':');
      setErrorCode((rest.length > 0 ? code : 'FACTORY_START_FAILED').trim());
      setError((rest.length > 0 ? rest.join(':') : message).trim());
      toaster.show('工作流启动失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [call, form, loadCoreData]);

  const review = useCallback(
    async (draftId: string, decision: 'approve' | 'reject') => {
      setLoading(true);
      setError('');
      setErrorCode('');
      try {
        await call(`/factory/drafts/${draftId}/review`, {
          method: 'POST',
          body: JSON.stringify({
            decision,
            note: reviewNote || undefined,
          }),
        });
        setReviewNote('');
        toaster.show(decision === 'approve' ? '审核通过已提交' : '驳回已提交', 'success');
        await loadCoreData();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Review failed';
        const [code, ...rest] = message.split(':');
        setErrorCode((rest.length > 0 ? code : 'FACTORY_REVIEW_FAILED').trim());
        setError((rest.length > 0 ? rest.join(':') : message).trim());
        toaster.show('审核操作失败', 'warning');
      } finally {
        setLoading(false);
      }
    },
    [call, loadCoreData, reviewNote, toaster]
  );

  const bulkReview = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (selectedDraftIds.length === 0) {
        setError('请先选择至少一个草稿');
        setErrorCode('FACTORY_DRAFT_SELECTION_REQUIRED');
        toaster.show('请先选择草稿', 'warning');
        return;
      }
      setLoading(true);
      setError('');
      setErrorCode('');
      try {
        await call('/factory/drafts/review/bulk', {
          method: 'POST',
          body: JSON.stringify({
            draftIds: selectedDraftIds,
            decision,
            note: reviewNote || undefined,
          }),
        });
        setSelectedDraftIds([]);
        toaster.show('批量审核已提交', 'success');
        await loadCoreData();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Bulk review failed';
        const [code, ...rest] = message.split(':');
        setErrorCode((rest.length > 0 ? code : 'FACTORY_BULK_REVIEW_FAILED').trim());
        setError((rest.length > 0 ? rest.join(':') : message).trim());
        toaster.show('批量审核失败', 'warning');
      } finally {
        setLoading(false);
      }
    },
    [call, loadCoreData, reviewNote, selectedDraftIds, toaster]
  );

  const cancelWorkflow = useCallback(
    async (workflowId: string) => {
      setLoading(true);
      setError('');
      setErrorCode('');
      try {
        await call(`/factory/workflows/${workflowId}/cancel`, {
          method: 'POST',
        });
        setWorkflowStatus((prev) => ({ ...prev, [workflowId]: 'TERMINATED' }));
        toaster.show('任务已取消', 'success');
        await loadCoreData();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Cancel workflow failed';
        const [code, ...rest] = message.split(':');
        setErrorCode((rest.length > 0 ? code : 'FACTORY_CANCEL_FAILED').trim());
        setError((rest.length > 0 ? rest.join(':') : message).trim());
        toaster.show('取消任务失败', 'warning');
      } finally {
        setLoading(false);
      }
    },
    [call, loadCoreData, toaster]
  );

  const bulkCancelWorkflows = useCallback(async () => {
    if (selectedWorkflowIds.length === 0) {
      setError('请先选择至少一个工作流');
      setErrorCode('FACTORY_WORKFLOW_SELECTION_REQUIRED');
      toaster.show('请先选择工作流', 'warning');
      return;
    }
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      await call('/factory/workflows/cancel/bulk', {
        method: 'POST',
        body: JSON.stringify({
          workflowIds: selectedWorkflowIds,
        }),
      });
      setSelectedWorkflowIds([]);
      toaster.show('批量取消已提交', 'success');
      await loadCoreData();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Bulk cancel failed';
      const [code, ...rest] = message.split(':');
      setErrorCode((rest.length > 0 ? code : 'FACTORY_BULK_CANCEL_FAILED').trim());
      setError((rest.length > 0 ? rest.join(':') : message).trim());
      toaster.show('批量取消失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [call, loadCoreData, selectedWorkflowIds, toaster]);

  const retryPublishJob = useCallback(
    async (publishJobId: string) => {
      setLoading(true);
      setError('');
      setErrorCode('');
      try {
        await call(`/factory/publish-jobs/${publishJobId}/retry`, {
          method: 'POST',
        });
        toaster.show('发布重试已触发', 'success');
        await loadCoreData();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Retry publish failed';
        const [code, ...rest] = message.split(':');
        setErrorCode((rest.length > 0 ? code : 'FACTORY_RETRY_FAILED').trim());
        setError((rest.length > 0 ? rest.join(':') : message).trim());
        toaster.show('发布重试失败', 'warning');
      } finally {
        setLoading(false);
      }
    },
    [call, loadCoreData, toaster]
  );

  const bulkRetryPublishJobs = useCallback(async () => {
    if (selectedPublishJobIds.length === 0) {
      setErrorCode('FACTORY_PUBLISH_SELECTION_REQUIRED');
      setError('请先选择至少一个发布任务');
      toaster.show('请先选择发布任务', 'warning');
      return;
    }
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      await call('/factory/publish-jobs/retry/bulk', {
        method: 'POST',
        body: JSON.stringify({
          publishJobIds: selectedPublishJobIds,
          concurrency: retryConcurrency,
        }),
      });
      setSelectedPublishJobIds([]);
      toaster.show('批量重试已触发', 'success');
      await loadCoreData();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Bulk retry failed';
      const [code, ...rest] = message.split(':');
      setErrorCode((rest.length > 0 ? code : 'FACTORY_BULK_RETRY_FAILED').trim());
      setError((rest.length > 0 ? rest.join(':') : message).trim());
      toaster.show('批量重试失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [call, loadCoreData, retryConcurrency, selectedPublishJobIds, toaster]);

  const loadRetryPreview = useCallback(async () => {
    try {
      const preview = await call<RetryPreview>(
        `/factory/publish-jobs/retry-preview?maxRetryCount=${retryMaxCount}&batchSize=${retryBatchSize}&cooldownMinutes=${retryCooldownMinutes}&concurrency=${retryConcurrency}&force=${
          retryForce ? '1' : '0'
        }${
          retryErrorCodeFilter ? `&errorCode=${encodeURIComponent(retryErrorCodeFilter)}` : ''
        }`
      );
      setRetryPreview(preview);
      return preview;
    } catch {
      return null;
    }
  }, [
    call,
    retryBatchSize,
    retryConcurrency,
    retryCooldownMinutes,
    retryErrorCodeFilter,
    retryForce,
    retryMaxCount,
  ]);

  const applyRetryHistoryCriteria = useCallback(
    (item: RetryHistory['items'][number]) => {
      setRetryMaxCount(item.criteria.maxRetryCount || 3);
      setRetryBatchSize(item.criteria.batchSize || 50);
      setRetryCooldownMinutes(item.criteria.cooldownMinutes || 0);
      setRetryConcurrency(item.criteria.concurrency || 5);
      setRetryForce(Boolean(item.criteria.force));
      setRetryErrorCodeFilter(item.criteria.errorCode || '');
      toaster.show('已回填历史策略参数', 'success');
    },
    [toaster]
  );

  const replayRetryHistoryItem = useCallback(
    async (item: RetryHistory['items'][number], useCurrentCriteria = false) => {
      setLoading(true);
      setError('');
      setErrorCode('');
      try {
        await call(`/factory/publish-jobs/retry-history/${item.id}/replay`, {
          method: 'POST',
          body: JSON.stringify(
            useCurrentCriteria
              ? {
                  errorCode: retryErrorCodeFilter || undefined,
                  maxRetryCount: retryMaxCount,
                  batchSize: retryBatchSize,
                  cooldownMinutes: retryCooldownMinutes,
                  concurrency: retryConcurrency,
                  force: retryForce,
                }
              : {}
          ),
        });
        toaster.show('历史批次已触发复跑', 'success');
        await loadCoreData();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Replay retry history failed';
        const [code, ...rest] = message.split(':');
        setErrorCode((rest.length > 0 ? code : 'FACTORY_REPLAY_RETRY_HISTORY_FAILED').trim());
        setError((rest.length > 0 ? rest.join(':') : message).trim());
        toaster.show('复跑历史批次失败', 'warning');
      } finally {
        setLoading(false);
      }
    },
    [
      call,
      loadCoreData,
      retryBatchSize,
      retryConcurrency,
      retryCooldownMinutes,
      retryErrorCodeFilter,
      retryForce,
      retryMaxCount,
      toaster,
    ]
  );

  const toggleRetryHistoryDetail = useCallback(
    async (item: RetryHistory['items'][number]) => {
      const isExpanded = expandedRetryHistoryIds.includes(item.id);
      if (isExpanded) {
        setExpandedRetryHistoryIds((prev) => prev.filter((id) => id !== item.id));
        return;
      }

      if (!retryHistoryDetailMap[item.id]) {
        try {
          const detail = await call<RetryHistoryDetail>(
            `/factory/publish-jobs/retry-history/${item.id}`
          );
          setRetryHistoryDetailMap((prev) => ({ ...prev, [item.id]: detail }));
        } catch (e) {
          toaster.show('加载历史详情失败', 'warning');
          return;
        }
      }

      setExpandedRetryHistoryIds((prev) => [...prev, item.id]);
    },
    [call, expandedRetryHistoryIds, retryHistoryDetailMap, toaster]
  );

  const bulkRetryFailedPublishJobs = useCallback(async () => {
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const preview = await loadRetryPreview();
      if (preview && preview.skipped && preview.reason === 'COOLDOWN_ACTIVE') {
        toaster.show(
          `冷却窗口生效，跳过执行（至 ${formatTime(preview.cooldownUntil || '')}）`,
          'warning'
        );
        return;
      }
      if (preview && preview.estimatedTotal <= 0) {
        toaster.show('当前无可执行的失败任务', 'warning');
        return;
      }
      const result = await call<{
        skipped?: boolean;
        reason?: string;
        cooldownUntil?: string;
      }>('/factory/publish-jobs/retry/failed', {
        method: 'POST',
        body: JSON.stringify({
          errorCode: retryErrorCodeFilter || undefined,
          maxRetryCount: retryMaxCount,
          batchSize: retryBatchSize,
          cooldownMinutes: retryCooldownMinutes,
          concurrency: retryConcurrency,
          force: retryForce,
        }),
      });
      if (result?.skipped && result?.reason === 'COOLDOWN_ACTIVE') {
        toaster.show(
          `冷却窗口生效，跳过执行（至 ${formatTime(result.cooldownUntil || '')}）`,
          'warning'
        );
      } else {
        toaster.show('失败任务自动重试已触发', 'success');
      }
      await loadCoreData();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Auto retry failed';
      const [code, ...rest] = message.split(':');
      setErrorCode((rest.length > 0 ? code : 'FACTORY_AUTO_RETRY_FAILED').trim());
      setError((rest.length > 0 ? rest.join(':') : message).trim());
      toaster.show('失败任务自动重试失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [
    call,
    loadRetryPreview,
    loadCoreData,
    retryBatchSize,
    retryConcurrency,
    retryCooldownMinutes,
    retryErrorCodeFilter,
    retryForce,
    retryMaxCount,
    toaster,
  ]);

  const exportLogsCsv = useCallback(async () => {
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const search = new URLSearchParams();
      search.set('limit', '2000');
      if (traceId) search.set('trace_id', traceId);
      if (operatorFilter) search.set('operator', operatorFilter);
      if (actionFilter) search.set('action', actionFilter);
      if (fromTime) search.set('from', new Date(fromTime).toISOString());
      if (toTime) search.set('to', new Date(toTime).toISOString());

      const response = await fetch(`/factory/logs/export.csv?${search.toString()}`);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`FACTORY_LOG_EXPORT_FAILED: ${text || 'Export failed'}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `factory_audit_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toaster.show('日志已导出为 CSV', 'success');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Export failed';
      const [code, ...rest] = message.split(':');
      setErrorCode((rest.length > 0 ? code : 'FACTORY_LOG_EXPORT_FAILED').trim());
      setError((rest.length > 0 ? rest.join(':') : message).trim());
      toaster.show('导出日志失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [actionFilter, fromTime, operatorFilter, toTime, toaster, traceId]);

  const exportTrendCsv = useCallback(() => {
    if (!metricsTrend?.series?.length) {
      setErrorCode('FACTORY_TREND_EXPORT_EMPTY');
      setError('暂无趋势数据可导出');
      toaster.show('暂无趋势数据', 'warning');
      return;
    }
    const rows = metricsTrend.series.map((item) => {
      if (trendMode === 'publish') {
        return [item.date, item.publishSuccess, item.publishFailed];
      }
      if (trendMode === 'review') {
        return [item.date, item.draftApproved, item.draftRejected];
      }
      return [item.date, item.workflowCreated, item.workflowFailed, item.workflowCancelled];
    });
    const header =
      trendMode === 'publish'
        ? ['date', 'publish_success', 'publish_failed']
        : trendMode === 'review'
        ? ['date', 'draft_approved', 'draft_rejected']
        : ['date', 'workflow_created', 'workflow_failed', 'workflow_cancelled'];
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `factory_trend_${trendMode}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    toaster.show('趋势 CSV 已导出', 'success');
  }, [metricsTrend, toaster, trendMode]);

  const exportRetryHistoryCsv = useCallback(async () => {
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const response = await fetch(
        `/factory/publish-jobs/retry-history/export.csv?days=${retryHistoryDays}&limit=${Math.max(
          retryHistoryLimit,
          200
        )}${
          retryHistoryOperatorFilter ? `&operator=${encodeURIComponent(retryHistoryOperatorFilter)}` : ''
        }${
          retryHistorySkippedFilter !== 'all' ? `&skipped=${retryHistorySkippedFilter}` : ''
        }${
          retryHistoryErrorCodeFilter
            ? `&errorCode=${encodeURIComponent(retryHistoryErrorCodeFilter)}`
            : ''
        }`
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`FACTORY_RETRY_HISTORY_EXPORT_FAILED: ${text || 'Export failed'}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `factory_retry_history_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toaster.show('重试历史 CSV 已导出', 'success');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Export failed';
      const [code, ...rest] = message.split(':');
      setErrorCode((rest.length > 0 ? code : 'FACTORY_RETRY_HISTORY_EXPORT_FAILED').trim());
      setError((rest.length > 0 ? rest.join(':') : message).trim());
      toaster.show('导出重试历史失败', 'warning');
    } finally {
      setLoading(false);
    }
  }, [
    fetch,
    retryHistoryDays,
    retryHistoryErrorCodeFilter,
    retryHistoryLimit,
    retryHistoryOperatorFilter,
    retryHistorySkippedFilter,
    toaster,
  ]);

  const queryWorkflowStatus = useCallback(
    async (workflowId: string) => {
      try {
        const status = await call<{ status: string }>(`/factory/workflows/${workflowId}`);
        setWorkflowStatus((prev) => ({ ...prev, [workflowId]: status.status }));
      } catch (e) {
        setWorkflowStatus((prev) => ({ ...prev, [workflowId]: 'ERROR' }));
      }
    },
    [call]
  );

  const kpis = useMemo(() => {
    const published = publishJobs.filter((job) => job.status === 'PUBLISHED').length;
    const failed = publishJobs.filter((job) => job.status === 'FAILED').length;
    const pendingReview = drafts.filter((draft) => draft.reviewStatus === 'PENDING').length;
    const totalPublish = publishJobs.length || 1;
    const successRate = ((published / totalPublish) * 100).toFixed(1);
    return { published, failed, pendingReview, successRate };
  }, [drafts, publishJobs]);

  return (
    <div className={styles.factoryPage}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{title}</div>
          <div className={styles.subtitle}>{subtitle}</div>
        </div>
        <div className={styles.badge}>{badge}</div>
      </div>

      <div className={styles.grid}>
        {(view === 'dashboard' || view === 'tasks' || view === 'publish') && (
          <div className={styles.card}>
            <div className={styles.kpis}>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>发布成功率</div>
                <div className={styles.kpiValue}>
                  {view === 'dashboard' && metrics ? metrics.publish.successRate : kpis.successRate}%
                </div>
              </div>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>发布失败率</div>
                <div className={styles.kpiValue}>
                  {view === 'dashboard' && metrics ? metrics.publish.failRate : '-'}%
                </div>
              </div>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>重试使用率</div>
                <div className={styles.kpiValue}>
                  {view === 'dashboard' && metrics && metrics.publish.total > 0
                    ? ((metrics.publish.retryUsed / metrics.publish.total) * 100).toFixed(1)
                    : '-'}
                  %
                </div>
              </div>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>人工接管率</div>
                <div className={styles.kpiValue}>
                  {view === 'dashboard' && metrics ? metrics.review.manualTakeoverRate : '-'}%
                </div>
              </div>
            </div>
            {view === 'dashboard' && metrics ? (
              <div style={{ marginTop: 8 }}>
                <div className={styles.actions} style={{ marginBottom: 6 }}>
                  <span className={styles.muted}>统计窗口</span>
                  <select
                    className={styles.select}
                    style={{ maxWidth: 140 }}
                    value={metricsDays}
                    onChange={(e) => setMetricsDays(Number(e.target.value))}
                  >
                    <option value={7}>最近 7 天</option>
                    <option value={14}>最近 14 天</option>
                    <option value={30}>最近 30 天</option>
                  </select>
                </div>
                <div className={styles.muted}>
                  workflow: created {metrics.workflow.created} / cancelled {metrics.workflow.cancelled} / failed{' '}
                  {metrics.workflow.failed}
                </div>
                {stageDistribution ? (
                  <div className={styles.muted} style={{ marginTop: 4 }}>
                    stages: collect {stageDistribution.stages.COLLECTING} / generate{' '}
                    {stageDistribution.stages.GENERATING} / review {stageDistribution.stages.REVIEWING} /
                    publishing {stageDistribution.stages.PUBLISHING} / completed{' '}
                    {stageDistribution.stages.COMPLETED} / failed {stageDistribution.stages.FAILED}
                  </div>
                ) : null}
                {metricsTrend?.series?.length ? (
                  <div style={{ marginTop: 6 }}>
                    <div className={styles.actions} style={{ marginBottom: 6 }}>
                      <span className={styles.muted}>趋势维度</span>
                      <select
                        className={styles.select}
                        style={{ maxWidth: 160 }}
                        value={trendMode}
                        onChange={(e) =>
                          setTrendMode(e.target.value as 'publish' | 'review' | 'workflow')
                        }
                      >
                        <option value="publish">发布趋势</option>
                        <option value="review">审核趋势</option>
                        <option value="workflow">工作流趋势</option>
                      </select>
                      <button
                        className={styles.buttonGhost}
                        style={{ padding: '4px 10px' }}
                        onClick={exportTrendCsv}
                      >
                        导出趋势 CSV
                      </button>
                    </div>
                    {(() => {
                      const points = metricsTrend.series.slice(-7);
                      const valueOf = (item: (typeof points)[number]) => {
                        if (trendMode === 'publish') {
                          return Math.max(item.publishSuccess, item.publishFailed);
                        }
                        if (trendMode === 'review') {
                          return Math.max(item.draftApproved, item.draftRejected);
                        }
                        return Math.max(
                          item.workflowCreated,
                          item.workflowFailed,
                          item.workflowCancelled
                        );
                      };
                      const maxValue = Math.max(1, ...points.map(valueOf));
                      return (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(0, 1fr))`,
                            gap: 6,
                            alignItems: 'end',
                            height: 70,
                            marginBottom: 8,
                          }}
                        >
                          {points.map((item) => (
                            <div key={`bar_${item.date}`} style={{ textAlign: 'center' }}>
                              <div
                                style={{
                                  height: `${Math.max(8, Math.round((valueOf(item) / maxValue) * 56))}px`,
                                  background:
                                    trendMode === 'publish'
                                      ? 'linear-gradient(180deg,#20c997,#0ca678)'
                                      : trendMode === 'review'
                                      ? 'linear-gradient(180deg,#ffd43b,#fab005)'
                                      : 'linear-gradient(180deg,#74c0fc,#1c7ed6)',
                                  borderRadius: 4,
                                }}
                              />
                              <div className={styles.muted} style={{ marginTop: 4, fontSize: 11 }}>
                                {item.date.slice(5)}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    <div className={styles.logs}>
                      {metricsTrend.series.slice(-7).map((item) => (
                        <div key={item.date}>
                          {trendMode === 'publish'
                            ? `${item.date} publish_success=${item.publishSuccess} publish_failed=${item.publishFailed}`
                            : trendMode === 'review'
                            ? `${item.date} draft_approved=${item.draftApproved} draft_rejected=${item.draftRejected}`
                            : `${item.date} workflow_created=${item.workflowCreated} workflow_failed=${item.workflowFailed} workflow_cancelled=${item.workflowCancelled}`}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {(view === 'generate' || view === 'publish') && (
          <div className={styles.card}>
            <h3>创建内容工厂任务</h3>
            <div className={styles.row}>
              <div className={styles.fieldThird}>
                <div className={styles.label}>平台</div>
                <select
                  className={styles.select}
                  value={form.platform}
                  onChange={(e) => setForm((prev) => ({ ...prev, platform: e.target.value }))}
                >
                  <option value="xhs">xhs</option>
                  <option value="dy">dy</option>
                </select>
              </div>
              <div className={styles.fieldThird}>
                <div className={styles.label}>关键词</div>
                <input
                  className={styles.input}
                  value={form.keywords}
                  onChange={(e) => setForm((prev) => ({ ...prev, keywords: e.target.value }))}
                  placeholder="例如：防晒测评"
                />
              </div>
              <div className={styles.fieldThird}>
                <div className={styles.label}>页数</div>
                <input
                  className={styles.input}
                  type="number"
                  min={1}
                  max={20}
                  value={form.pageLimit}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, pageLimit: Number(e.target.value || 1) }))
                  }
                />
              </div>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>发布账号（小红书 Integration）</div>
                <select
                  className={styles.select}
                  value={form.integrationId}
                  onChange={(e) => setForm((prev) => ({ ...prev, integrationId: e.target.value }))}
                >
                  <option value="">请选择账号</option>
                  {integrations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.identifier})
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>定时发布时间（可选）</div>
                <input
                  className={styles.input}
                  type="datetime-local"
                  value={form.scheduleAt}
                  onChange={(e) => setForm((prev) => ({ ...prev, scheduleAt: e.target.value }))}
                />
              </div>
              <div className={styles.field}>
                <div className={styles.label}>产品画像（JSON 或文本）</div>
                <textarea
                  className={styles.textarea}
                  value={form.productProfile}
                  onChange={(e) => setForm((prev) => ({ ...prev, productProfile: e.target.value }))}
                  placeholder='{"brand":"xxx","tone":"专业"}'
                />
              </div>
            </div>
            <div className={styles.actions} style={{ marginTop: 12 }}>
              <button
                className={styles.button}
                onClick={startWorkflow}
                disabled={loading || !form.integrationId || !form.keywords}
              >
                启动工作流
              </button>
              <button className={styles.buttonGhost} onClick={loadCoreData} disabled={loading}>
                刷新数据
              </button>
              {latestWorkflowId ? <span className={styles.pill}>workflow: {latestWorkflowId}</span> : null}
            </div>
          </div>
        )}

        {(view === 'tasks' || view === 'dashboard') && (
          <div className={styles.card}>
            <h3>工作流看板</h3>
            <div className={styles.actions} style={{ marginBottom: 10 }}>
              <button
                className={styles.button}
                onClick={bulkCancelWorkflows}
                disabled={loading || selectedWorkflowIds.length === 0}
              >
                批量取消 ({selectedWorkflowIds.length})
              </button>
              <select
                className={styles.select}
                style={{ maxWidth: 150 }}
                value={workflowStatusFilter}
                onChange={(e) => {
                  setWorkflowPage(1);
                  setWorkflowStatusFilter(
                    e.target.value as 'ALL' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
                  );
                }}
              >
                <option value="ALL">全部状态</option>
                <option value="RUNNING">运行中</option>
                <option value="COMPLETED">已完成</option>
                <option value="FAILED">失败</option>
                <option value="CANCELLED">已取消</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 150 }}
                value={workflowSortBy}
                onChange={(e) => setWorkflowSortBy(e.target.value as 'createdAt' | 'updatedAt')}
              >
                <option value="createdAt">按创建时间</option>
                <option value="updatedAt">按更新时间</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={workflowSortOrder}
                onChange={(e) => setWorkflowSortOrder(e.target.value as 'asc' | 'desc')}
              >
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={workflowPageSize}
                onChange={(e) => {
                  setWorkflowPage(1);
                  setWorkflowPageSize(Number(e.target.value));
                }}
              >
                <option value={10}>10 / 页</option>
                <option value={20}>20 / 页</option>
                <option value={50}>50 / 页</option>
              </select>
              <button
                className={styles.buttonGhost}
                onClick={() => setWorkflowPage((p) => Math.max(1, p - 1))}
                disabled={loading || workflowPage <= 1}
              >
                上一页
              </button>
              <button
                className={styles.buttonGhost}
                onClick={() => setWorkflowPage((p) => Math.min(workflowTotalPages, p + 1))}
                disabled={loading || workflowPage >= workflowTotalPages}
              >
                下一页
              </button>
              <span className={styles.muted}>
                第 {workflowPage} / {workflowTotalPages} 页
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={
                          workflows.length > 0 && selectedWorkflowIds.length === workflows.length
                        }
                        onChange={(e) =>
                          setSelectedWorkflowIds(
                            e.target.checked ? workflows.map((item) => item.workflowId) : []
                          )
                        }
                      />
                    </th>
                    <th>Workflow</th>
                    <th>状态</th>
                    <th>草稿ID</th>
                    <th>审核状态</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {workflows.map((item) => (
                    <tr key={item.workflowId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedWorkflowIds.includes(item.workflowId)}
                          onChange={(e) =>
                            setSelectedWorkflowIds((prev) =>
                              e.target.checked
                                ? Array.from(new Set([...prev, item.workflowId]))
                                : prev.filter((id) => id !== item.workflowId)
                            )
                          }
                        />
                      </td>
                      <td>{item.workflowId.slice(0, 18)}</td>
                      <td>
                        <span className={styles.pill}>{item.status}</span>
                      </td>
                      <td>{item.draftId.slice(0, 8)}</td>
                      <td>{item.reviewStatus}</td>
                      <td>{formatTime(item.createdAt)}</td>
                      <td>
                        {item.status === 'RUNNING' ? (
                          <button
                            className={styles.buttonGhost}
                            style={{ padding: '6px 10px' }}
                            onClick={() => cancelWorkflow(item.workflowId)}
                            disabled={loading}
                          >
                            取消任务
                          </button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(view === 'tasks' || view === 'generate' || view === 'dashboard') && (
          <div className={styles.card}>
            <h3>草稿与审核</h3>
            <div className={styles.row}>
              <div className={styles.field}>
                <div className={styles.label}>审核意见</div>
                <input
                  className={styles.input}
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="驳回时建议填写，例如：语气更口语化，增加真实场景"
                />
              </div>
            </div>
            <div className={styles.actions} style={{ marginTop: 10, marginBottom: 10 }}>
              <button className={styles.button} onClick={() => bulkReview('approve')} disabled={loading}>
                批量通过 ({selectedDraftIds.length})
              </button>
              <button
                className={styles.buttonGhost}
                onClick={() => bulkReview('reject')}
                disabled={loading}
              >
                批量驳回 ({selectedDraftIds.length})
              </button>
            </div>
            <div className={styles.actions} style={{ marginBottom: 10 }}>
              <select
                className={styles.select}
                style={{ maxWidth: 170 }}
                value={draftSortBy}
                onChange={(e) =>
                  setDraftSortBy(
                    e.target.value as 'createdAt' | 'updatedAt' | 'reviewStatus' | 'score'
                  )
                }
              >
                <option value="createdAt">按创建时间</option>
                <option value="updatedAt">按更新时间</option>
                <option value="reviewStatus">按审核状态</option>
                <option value="score">按评分</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={draftSortOrder}
                onChange={(e) => setDraftSortOrder(e.target.value as 'asc' | 'desc')}
              >
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={draftPageSize}
                onChange={(e) => {
                  setDraftPage(1);
                  setDraftPageSize(Number(e.target.value));
                }}
              >
                <option value={10}>10 / 页</option>
                <option value={20}>20 / 页</option>
                <option value={50}>50 / 页</option>
              </select>
              <button
                className={styles.buttonGhost}
                onClick={() => setDraftPage((p) => Math.max(1, p - 1))}
                disabled={loading || draftPage <= 1}
              >
                上一页
              </button>
              <button
                className={styles.buttonGhost}
                onClick={() => setDraftPage((p) => Math.min(draftTotalPages, p + 1))}
                disabled={loading || draftPage >= draftTotalPages}
              >
                下一页
              </button>
              <span className={styles.muted}>
                第 {draftPage} / {draftTotalPages} 页
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={drafts.length > 0 && selectedDraftIds.length === drafts.length}
                        onChange={(e) =>
                          setSelectedDraftIds(
                            e.target.checked ? drafts.map((item) => item.id) : []
                          )
                        }
                      />
                    </th>
                    <th>草稿ID</th>
                    <th>标题</th>
                    <th>评分</th>
                    <th>审核状态</th>
                    <th>工作流</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft) => (
                    <tr key={draft.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedDraftIds.includes(draft.id)}
                          onChange={(e) =>
                            setSelectedDraftIds((prev) =>
                              e.target.checked
                                ? Array.from(new Set([...prev, draft.id]))
                                : prev.filter((item) => item !== draft.id)
                            )
                          }
                        />
                      </td>
                      <td>{draft.id.slice(0, 8)}</td>
                      <td>{draft.title || '-'}</td>
                      <td>{typeof draft.score === 'number' ? draft.score.toFixed(1) : '-'}</td>
                      <td>
                        <span className={styles.pill}>{draft.reviewStatus}</span>
                      </td>
                      <td>
                        {draft.workflowId ? (
                          <>
                            {draft.workflowId.slice(0, 18)}
                            <br />
                            <button
                              className={styles.buttonGhost}
                              style={{ marginTop: 6, padding: '4px 8px' }}
                              onClick={() => queryWorkflowStatus(draft.workflowId!)}
                            >
                              查询状态
                            </button>
                            <button
                              className={styles.buttonGhost}
                              style={{ marginTop: 6, marginLeft: 6, padding: '4px 8px' }}
                              onClick={() => cancelWorkflow(draft.workflowId!)}
                            >
                              取消任务
                            </button>
                            {workflowStatus[draft.workflowId] ? (
                              <div className={styles.muted}>{workflowStatus[draft.workflowId]}</div>
                            ) : null}
                          </>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>{formatTime(draft.createdAt)}</td>
                      <td>
                        <div className={styles.actions}>
                          <button
                            className={styles.button}
                            style={{ padding: '6px 10px' }}
                            onClick={() => review(draft.id, 'approve')}
                            disabled={loading}
                          >
                            通过
                          </button>
                          <button
                            className={styles.buttonGhost}
                            style={{ padding: '6px 10px' }}
                            onClick={() => review(draft.id, 'reject')}
                            disabled={loading}
                          >
                            驳回
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(view === 'publish' || view === 'dashboard') && retryInsights ? (
          <div className={styles.card}>
            <h3>失败重试策略</h3>
            <div className={styles.actions} style={{ marginBottom: 10 }}>
              <span className={styles.muted}>
                最近 {retryInsights.windowDays} 天失败 {retryInsights.failedTotal} 条，可重试{' '}
                {retryInsights.retryableTotal} 条（最大重试 {retryInsights.maxRetryCount} 次）
              </span>
            </div>
            <div className={styles.actions} style={{ marginBottom: 10 }}>
              <select
                className={styles.select}
                style={{ maxWidth: 180 }}
                value={retryMaxCount}
                onChange={(e) => setRetryMaxCount(Number(e.target.value))}
              >
                <option value={1}>最大重试 1 次</option>
                <option value={2}>最大重试 2 次</option>
                <option value={3}>最大重试 3 次</option>
                <option value={5}>最大重试 5 次</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 180 }}
                value={retryBatchSize}
                onChange={(e) => setRetryBatchSize(Number(e.target.value))}
              >
                <option value={20}>批次 20</option>
                <option value={50}>批次 50</option>
                <option value={100}>批次 100</option>
                <option value={200}>批次 200</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 180 }}
                value={retryCooldownMinutes}
                onChange={(e) => setRetryCooldownMinutes(Number(e.target.value))}
              >
                <option value={0}>无冷却</option>
                <option value={5}>冷却 5 分钟</option>
                <option value={10}>冷却 10 分钟</option>
                <option value={30}>冷却 30 分钟</option>
                <option value={60}>冷却 60 分钟</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 170 }}
                value={retryConcurrency}
                onChange={(e) => setRetryConcurrency(Number(e.target.value))}
              >
                <option value={1}>并发 1</option>
                <option value={3}>并发 3</option>
                <option value={5}>并发 5</option>
                <option value={8}>并发 8</option>
                <option value={10}>并发 10</option>
              </select>
              <label className={styles.muted} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={retryForce}
                  onChange={(e) => setRetryForce(e.target.checked)}
                />
                忽略冷却强制执行
              </label>
              <select
                className={styles.select}
                style={{ maxWidth: 220 }}
                value={retryErrorCodeFilter}
                onChange={(e) => setRetryErrorCodeFilter(e.target.value)}
              >
                <option value="">全部错误码</option>
                {retryInsights.byErrorCode.map((item) => (
                  <option key={item.errorCode} value={item.errorCode}>
                    {item.errorCode} ({item.count})
                  </option>
                ))}
              </select>
              <button className={styles.button} onClick={bulkRetryFailedPublishJobs} disabled={loading}>
                自动重试失败任务
              </button>
              <button className={styles.buttonGhost} onClick={loadRetryPreview} disabled={loading}>
                预览本次任务
              </button>
            </div>
            {retryPreview ? (
              <div className={styles.logs} style={{ marginBottom: 8 }}>
                <div>
                  预览: total={retryPreview.estimatedTotal} skipped=
                  {retryPreview.skipped ? 'yes' : 'no'} reason={retryPreview.reason || '-'}{' '}
                  {retryPreview.cooldownUntil ? `cooldownUntil=${formatTime(retryPreview.cooldownUntil)}` : ''}
                </div>
                <div>
                  criteria: retry&lt;{retryPreview.criteria.maxRetryCount} batch=
                  {retryPreview.criteria.batchSize} cooldown={retryPreview.criteria.cooldownMinutes}m
                  concurrency={retryPreview.criteria.concurrency} force=
                  {retryPreview.criteria.force ? 'true' : 'false'}
                </div>
                {retryPreview.candidateSampleIds.length > 0 ? (
                  <div>sample: {retryPreview.candidateSampleIds.map((id) => id.slice(0, 8)).join(', ')}</div>
                ) : null}
              </div>
            ) : null}
            {retryHistory ? (
              <div className={styles.logs} style={{ marginBottom: 8 }}>
                <div className={styles.actions} style={{ marginBottom: 6 }}>
                  <div className={styles.muted}>最近重试批次</div>
                  <select
                    className={styles.select}
                    style={{ maxWidth: 150 }}
                    value={retryHistoryDays}
                    onChange={(e) => setRetryHistoryDays(Number(e.target.value))}
                  >
                    <option value={7}>最近 7 天</option>
                    <option value={14}>最近 14 天</option>
                    <option value={30}>最近 30 天</option>
                  </select>
                  <select
                    className={styles.select}
                    style={{ maxWidth: 140 }}
                    value={retryHistoryLimit}
                    onChange={(e) => setRetryHistoryLimit(Number(e.target.value))}
                  >
                    <option value={10}>10 条</option>
                    <option value={20}>20 条</option>
                    <option value={50}>50 条</option>
                  </select>
                  <button
                    className={styles.buttonGhost}
                    style={{ padding: '2px 8px' }}
                    onClick={exportRetryHistoryCsv}
                    disabled={loading}
                  >
                    导出历史 CSV
                  </button>
                  <input
                    className={styles.input}
                    style={{ maxWidth: 180 }}
                    value={retryHistoryOperatorFilter}
                    onChange={(e) => setRetryHistoryOperatorFilter(e.target.value)}
                    placeholder="按 operator 过滤"
                  />
                  <select
                    className={styles.select}
                    style={{ maxWidth: 150 }}
                    value={retryHistorySkippedFilter}
                    onChange={(e) =>
                      setRetryHistorySkippedFilter(e.target.value as 'all' | 'true' | 'false')
                    }
                  >
                    <option value="all">跳过状态: 全部</option>
                    <option value="true">仅冷却跳过</option>
                    <option value="false">仅执行批次</option>
                  </select>
                  <input
                    className={styles.input}
                    style={{ maxWidth: 180 }}
                    value={retryHistoryErrorCodeFilter}
                    onChange={(e) => setRetryHistoryErrorCodeFilter(e.target.value)}
                    placeholder="按错误码过滤"
                  />
                  <button
                    className={styles.buttonGhost}
                    style={{ padding: '2px 8px' }}
                    onClick={() => {
                      setRetryHistoryOperatorFilter('');
                      setRetryHistorySkippedFilter('all');
                      setRetryHistoryErrorCodeFilter('');
                    }}
                    disabled={loading}
                  >
                    清空筛选
                  </button>
                </div>
                {retryHistorySummary ? (
                  <div className={styles.muted} style={{ marginBottom: 6 }}>
                    summary: batches={retryHistorySummary.totalBatches} executed=
                    {retryHistorySummary.executedBatches} skipped={retryHistorySummary.skippedBatches}{' '}
                    jobs_ok={retryHistorySummary.succeededJobs} jobs_fail={retryHistorySummary.failedJobs}
                  </div>
                ) : null}
                {retryHistory.items.slice(0, 8).map((item) => (
                  <div key={item.id}>
                    [{formatTime(item.createdAt)}] op={item.operator} selected={item.selectedCount}{' '}
                    ok={item.result.succeeded} fail={item.result.failed} cooldown=
                    {item.criteria.cooldownMinutes}m force={item.criteria.force ? '1' : '0'}{' '}
                    err={item.criteria.errorCode || 'ALL'}
                    <button
                      className={styles.buttonGhost}
                      style={{ marginLeft: 8, padding: '2px 8px' }}
                      onClick={() => applyRetryHistoryCriteria(item)}
                    >
                      回填参数
                    </button>
                    <button
                      className={styles.buttonGhost}
                      style={{ marginLeft: 6, padding: '2px 8px' }}
                      onClick={() => replayRetryHistoryItem(item, false)}
                      disabled={loading}
                    >
                      复跑该批次
                    </button>
                    <button
                      className={styles.buttonGhost}
                      style={{ marginLeft: 6, padding: '2px 8px' }}
                      onClick={() => replayRetryHistoryItem(item, true)}
                      disabled={loading}
                    >
                      按当前参数复跑
                    </button>
                    <button
                      className={styles.buttonGhost}
                      style={{ marginLeft: 6, padding: '2px 8px' }}
                      onClick={() => toggleRetryHistoryDetail(item)}
                      disabled={loading}
                    >
                      {expandedRetryHistoryIds.includes(item.id) ? '收起详情' : '查看详情'}
                    </button>
                    {expandedRetryHistoryIds.includes(item.id) ? (
                      <div style={{ marginTop: 4, marginLeft: 8 }}>
                        {retryHistoryDetailMap[item.id] ? (
                          <>
                            <div className={styles.muted}>
                              selectedIds: {retryHistoryDetailMap[item.id].selectedIds
                                .slice(0, 10)
                                .map((id) => id.slice(0, 8))
                                .join(', ')}
                            </div>
                            {retryHistoryDetailMap[item.id].result.failures.slice(0, 10).map((f, idx) => (
                              <div key={`${item.id}_failure_${idx}`} className={styles.danger}>
                                job={f.publishJobId || '-'} error={f.error || '-'}
                              </div>
                            ))}
                            {retryHistoryDetailMap[item.id].result.failures.length === 0 ? (
                              <div className={styles.muted}>无失败明细</div>
                            ) : null}
                          </>
                        ) : (
                          <div className={styles.muted}>加载中...</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                ))}
                {retryHistory.items.length === 0 ? <div className={styles.muted}>暂无历史批次</div> : null}
              </div>
            ) : null}
            <div className={styles.logs}>
              {retryInsights.byErrorCode.map((item) => (
                <div key={item.errorCode}>
                  error={item.errorCode} total={item.count} retryable={item.retryable}
                </div>
              ))}
              {retryInsights.byErrorCode.length === 0 ? <div>[INFO] 当前无失败任务</div> : null}
            </div>
          </div>
        ) : null}

        {(view === 'publish' || view === 'dashboard') && (
          <div className={styles.card}>
            <h3>发布任务</h3>
            <div className={styles.actions} style={{ marginBottom: 10 }}>
              <button
                className={styles.button}
                onClick={bulkRetryPublishJobs}
                disabled={loading || selectedPublishJobIds.length === 0}
              >
                批量重试 ({selectedPublishJobIds.length})
              </button>
              <select
                className={styles.select}
                style={{ maxWidth: 180 }}
                value={publishSortBy}
                onChange={(e) =>
                  setPublishSortBy(
                    e.target.value as
                      | 'createdAt'
                      | 'updatedAt'
                      | 'status'
                      | 'publishedAt'
                      | 'retryCount'
                  )
                }
              >
                <option value="createdAt">按创建时间</option>
                <option value="updatedAt">按更新时间</option>
                <option value="status">按状态</option>
                <option value="publishedAt">按发布时间</option>
                <option value="retryCount">按重试次数</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={publishSortOrder}
                onChange={(e) => setPublishSortOrder(e.target.value as 'asc' | 'desc')}
              >
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={publishPageSize}
                onChange={(e) => {
                  setPublishPage(1);
                  setPublishPageSize(Number(e.target.value));
                }}
              >
                <option value={10}>10 / 页</option>
                <option value={20}>20 / 页</option>
                <option value={50}>50 / 页</option>
              </select>
              <button
                className={styles.buttonGhost}
                onClick={() => setPublishPage((p) => Math.max(1, p - 1))}
                disabled={loading || publishPage <= 1}
              >
                上一页
              </button>
              <button
                className={styles.buttonGhost}
                onClick={() => setPublishPage((p) => Math.min(publishTotalPages, p + 1))}
                disabled={loading || publishPage >= publishTotalPages}
              >
                下一页
              </button>
              <span className={styles.muted}>
                第 {publishPage} / {publishTotalPages} 页
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={
                          publishJobs.length > 0 &&
                          selectedPublishJobIds.length === publishJobs.length
                        }
                        onChange={(e) =>
                          setSelectedPublishJobIds(
                            e.target.checked ? publishJobs.map((item) => item.id) : []
                          )
                        }
                      />
                    </th>
                    <th>任务ID</th>
                    <th>状态</th>
                    <th>Integration</th>
                    <th>重试</th>
                    <th>定时</th>
                    <th>发布时间</th>
                    <th>错误</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {publishJobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedPublishJobIds.includes(job.id)}
                          onChange={(e) =>
                            setSelectedPublishJobIds((prev) =>
                              e.target.checked
                                ? Array.from(new Set([...prev, job.id]))
                                : prev.filter((id) => id !== job.id)
                            )
                          }
                        />
                      </td>
                      <td>{job.id.slice(0, 8)}</td>
                      <td>
                        <span className={styles.pill}>{job.status}</span>
                      </td>
                      <td>{job.integrationId.slice(0, 8)}</td>
                      <td>{job.retryCount}</td>
                      <td>{formatTime(job.scheduleAt)}</td>
                      <td>{formatTime(job.publishedAt)}</td>
                      <td className={job.errorMessage ? styles.danger : ''}>
                        {job.errorCode || job.errorMessage || '-'}
                      </td>
                      <td>
                        {job.status === 'FAILED' ? (
                          <button
                            className={styles.buttonGhost}
                            style={{ padding: '6px 10px' }}
                            onClick={() => retryPublishJob(job.id)}
                            disabled={loading}
                          >
                            重试发布
                          </button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(view === 'content' || view === 'dashboard') && (
          <div className={styles.card}>
            <h3>采集内容库</h3>
            <div className={styles.actions} style={{ marginBottom: 10 }}>
              <select
                className={styles.select}
                style={{ maxWidth: 170 }}
                value={contentSortBy}
                onChange={(e) =>
                  setContentSortBy(e.target.value as 'createdAt' | 'platform' | 'authorName')
                }
              >
                <option value="createdAt">按采集时间</option>
                <option value="platform">按平台</option>
                <option value="authorName">按作者</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={contentSortOrder}
                onChange={(e) => setContentSortOrder(e.target.value as 'asc' | 'desc')}
              >
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
              <select
                className={styles.select}
                style={{ maxWidth: 130 }}
                value={contentPageSize}
                onChange={(e) => {
                  setContentPage(1);
                  setContentPageSize(Number(e.target.value));
                }}
              >
                <option value={10}>10 / 页</option>
                <option value={20}>20 / 页</option>
                <option value={50}>50 / 页</option>
              </select>
              <button
                className={styles.buttonGhost}
                onClick={() => setContentPage((p) => Math.max(1, p - 1))}
                disabled={loading || contentPage <= 1}
              >
                上一页
              </button>
              <button
                className={styles.buttonGhost}
                onClick={() => setContentPage((p) => Math.min(contentTotalPages, p + 1))}
                disabled={loading || contentPage >= contentTotalPages}
              >
                下一页
              </button>
              <span className={styles.muted}>
                第 {contentPage} / {contentTotalPages} 页
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>平台</th>
                    <th>标题</th>
                    <th>作者</th>
                    <th>媒体数量</th>
                    <th>外部ID</th>
                    <th>采集时间</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceContents.map((item) => (
                    <tr key={item.id}>
                      <td>{item.id.slice(0, 8)}</td>
                      <td>{item.platform}</td>
                      <td>{item.title || '-'}</td>
                      <td>{item.authorName || '-'}</td>
                      <td>{item.mediaAssets.length}</td>
                      <td>{item.externalId}</td>
                      <td>{formatTime(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(view === 'logs' || view === 'dashboard') && (
          <div className={styles.card}>
            <h3>审计日志</h3>
            <div className={styles.row}>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>trace_id 过滤</div>
                <input
                  className={styles.input}
                  value={traceId}
                  onChange={(e) => {
                    setLogsPage(1);
                    setTraceId(e.target.value);
                  }}
                  placeholder="输入 trace_id 后点击刷新"
                />
              </div>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>operator 过滤</div>
                <input
                  className={styles.input}
                  value={operatorFilter}
                  onChange={(e) => {
                    setLogsPage(1);
                    setOperatorFilter(e.target.value);
                  }}
                  placeholder="userId 或 system"
                />
              </div>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>action 过滤</div>
                <input
                  className={styles.input}
                  value={actionFilter}
                  onChange={(e) => {
                    setLogsPage(1);
                    setActionFilter(e.target.value);
                  }}
                  placeholder="create/review/publish_retry..."
                />
              </div>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>开始时间</div>
                <input
                  className={styles.input}
                  type="datetime-local"
                  value={fromTime}
                  onChange={(e) => {
                    setLogsPage(1);
                    setFromTime(e.target.value);
                  }}
                />
              </div>
              <div className={styles.fieldHalf}>
                <div className={styles.label}>结束时间</div>
                <input
                  className={styles.input}
                  type="datetime-local"
                  value={toTime}
                  onChange={(e) => {
                    setLogsPage(1);
                    setToTime(e.target.value);
                  }}
                />
              </div>
              <div className={styles.fieldHalf} style={{ display: 'flex', alignItems: 'end' }}>
                <div className={styles.actions}>
                  <select
                    className={styles.select}
                    style={{ maxWidth: 160 }}
                    value={logsSortBy}
                    onChange={(e) =>
                      setLogsSortBy(
                        e.target.value as 'createdAt' | 'action' | 'operator' | 'resourceType'
                      )
                    }
                  >
                    <option value="createdAt">按时间</option>
                    <option value="action">按动作</option>
                    <option value="operator">按操作人</option>
                    <option value="resourceType">按资源类型</option>
                  </select>
                  <select
                    className={styles.select}
                    style={{ maxWidth: 130 }}
                    value={logsSortOrder}
                    onChange={(e) => setLogsSortOrder(e.target.value as 'asc' | 'desc')}
                  >
                    <option value="desc">降序</option>
                    <option value="asc">升序</option>
                  </select>
                  <select
                    className={styles.select}
                    style={{ maxWidth: 130 }}
                    value={logsPageSize}
                    onChange={(e) => {
                      setLogsPage(1);
                      setLogsPageSize(Number(e.target.value));
                    }}
                  >
                    <option value={20}>20 / 页</option>
                    <option value={50}>50 / 页</option>
                    <option value={100}>100 / 页</option>
                  </select>
                  <button className={styles.button} onClick={loadCoreData} disabled={loading}>
                    刷新日志
                  </button>
                  <button className={styles.buttonGhost} onClick={exportLogsCsv} disabled={loading}>
                    导出 CSV
                  </button>
                  <button
                    className={styles.buttonGhost}
                    onClick={() => {
                      setTraceId('');
                      setOperatorFilter('');
                      setActionFilter('');
                      setFromTime('');
                      setToTime('');
                      setLogsPage(1);
                    }}
                    disabled={loading}
                  >
                    清空过滤
                  </button>
                  <button
                    className={styles.buttonGhost}
                    onClick={() => setLogsPage((p) => Math.max(1, p - 1))}
                    disabled={loading || logsPage <= 1}
                  >
                    上一页
                  </button>
                  <button
                    className={styles.buttonGhost}
                    onClick={() => setLogsPage((p) => Math.min(logsTotalPages, p + 1))}
                    disabled={loading || logsPage >= logsTotalPages}
                  >
                    下一页
                  </button>
                  <span className={styles.muted}>
                    第 {logsPage} / {logsTotalPages} 页
                  </span>
                </div>
              </div>
            </div>
            <div className={styles.logs} style={{ marginTop: 10 }}>
              {logs.map((log) => {
                const detail = (log.detail || {}) as any;
                const isBulkRetry = log.action === 'publish_retry_bulk';
                const isExpanded = expandedBulkLogIds.includes(log.id);
                const failures = Array.isArray(detail?.result?.failures)
                  ? (detail.result.failures as { publishJobId?: string; error?: string }[])
                  : [];
                return (
                  <div key={log.id}>
                    {isBulkRetry ? (
                      <>
                        [{new Date(log.createdAt).toLocaleString()}] action={log.action} operator=
                        {log.operator} mode={String(detail?.mode || '-')} selected=
                        {String(detail?.selectedCount ?? '-')} success=
                        {String(detail?.result?.succeeded ?? '-')} failed=
                        {String(detail?.result?.failed ?? '-')} errorCode=
                        {String(detail?.criteria?.errorCode ?? 'ALL')} cooldown=
                        {String(detail?.criteria?.cooldownMinutes ?? 0)}m
                        {failures.length > 0 ? (
                          <button
                            className={styles.buttonGhost}
                            style={{ marginLeft: 8, padding: '2px 8px' }}
                            onClick={() =>
                              setExpandedBulkLogIds((prev) =>
                                prev.includes(log.id)
                                  ? prev.filter((id) => id !== log.id)
                                  : [...prev, log.id]
                              )
                            }
                          >
                            {isExpanded ? '收起失败详情' : `展开失败详情(${failures.length})`}
                          </button>
                        ) : null}
                        {detail?.skippedByCooldown ? (
                          <span className={styles.muted}>
                            {' '}
                            {'[cooldown until '}
                            {formatTime(detail?.cooldownUntil || '')}
                            {']'}
                          </span>
                        ) : null}
                        {isExpanded ? (
                          <div style={{ marginTop: 4, marginLeft: 8 }}>
                            {failures.map((f, idx) => (
                              <div key={`${log.id}_${idx}`} className={styles.danger}>
                                job={f.publishJobId || '-'} error={f.error || '-'}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        [{new Date(log.createdAt).toLocaleString()}] action={log.action} type=
                        {log.resourceType} resource={log.resourceId} operator={log.operator}{' '}
                        {log.traceId ? `trace=${log.traceId}` : ''}
                      </>
                    )}
                  </div>
                );
              })}
              {logs.length === 0 ? <div>[INFO] 暂无日志数据</div> : null}
            </div>
          </div>
        )}

        {error ? (
          <div className={styles.card}>
            <div className={styles.danger}>
              错误: {error}
              {errorCode ? ` (code: ${errorCode})` : ''}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
