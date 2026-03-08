'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  findMaterialFromDataset,
  loadMaterialDataset,
} from '@gitroom/frontend/components/materials/materials-analysis.storage';
import { AnalysisLayerResult } from '@gitroom/frontend/components/materials/materials-analysis.engine';
import { useCachedMediaUrl } from '@gitroom/frontend/components/materials/materials-media-cache';
import styles from '@gitroom/frontend/components/materials/materials-analysis-detail.module.scss';

type RemoteAnalysisPayload = {
  source?: 'qwen' | 'rule';
  analysis?: AnalysisLayerResult;
  summaryLayer?: {
    oneSentenceSummary?: string;
    highlights?: string[];
    optimizationSuggestions?: string[];
  };
  aiDetailLayer?: {
    vision?: {
      modelUsed?: string;
      confidence?: number;
      mediaUrl?: string;
      mediaType?: 'video' | 'image' | 'unknown';
      summary?: string;
      keywords?: string[];
      scenes?: string[];
      keyframes?: string[];
      rawText?: string;
    };
    asr?: {
      modelUsed?: string;
      confidence?: number;
      audioSource?: string;
      transcript?: string;
      language?: string;
      emotion?: string;
      rawText?: string;
    };
    semantic?: {
      modelUsed?: string;
      confidence?: number;
      summary?: string;
      highlights?: string[];
      keywords?: string[];
      insights?: string[];
      tone?: string;
      fullSummary360?: string;
      profile360?: {
        speakingFormat?: string;
        narratorRole?: string;
        productionApproach?: string[];
        expressionStyle?: string[];
        persuasionPath?: string[];
        authoritySignals?: string[];
        complianceSignals?: string[];
        audienceFit?: string[];
        risks?: string[];
        reusableAngles?: string[];
      };
      rawText?: string;
    };
  };
};

type AiState = 'idle' | 'checking' | 'queued' | 'running' | 'succeeded' | 'failed';

const needsProxy = (url: string): boolean => {
  if (!url) return false;
  const proxyDomains = [
    'xhscdn.com',
    'xiaohongshu.com',
    'douyinpic.com',
    'douyinvod.com',
    'byteimg.com',
    'pstatp.com',
  ];
  try {
    const parsed = new URL(url);
    return proxyDomains.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
};

const getProxiedUrl = (url: string | undefined, platform: string, backendUrl: string): string => {
  if (!url || !needsProxy(url) || !backendUrl) return url || '';
  const encodedUrl = encodeURIComponent(url);
  return `${backendUrl}/materials/image-proxy?url=${encodedUrl}&platform=${platform}`;
};

const isVideoUrl = (url?: string) => {
  if (!url) return false;
  return /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url);
};

const formatNumber = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  if (value >= 10000) return `${(value / 10000).toFixed(1)}w`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
};

export const MaterialsAnalysisDetail = () => {
  const fetch = useFetch();
  const { backendUrl } = useVariables();
  const router = useRouter();
  const params = useParams();
  const rawId = params?.id;
  const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : '';

  const [aiState, setAiState] = useState<AiState>('idle');
  const [aiJobId, setAiJobId] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState<RemoteAnalysisPayload | null>(null);
  const autoTriggeredRef = useRef(false);

  const backToMaterials = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/materials');
  };

  const dataset = useMemo(() => loadMaterialDataset(), []);
  const item = useMemo(() => findMaterialFromDataset(id), [id, dataset]);

  const hasAiPayloadContent = (payload?: RemoteAnalysisPayload | null) =>
    Boolean(payload && (payload.analysis || payload.summaryLayer || payload.aiDetailLayer));

  const shouldForceRefreshAi = (payload?: RemoteAnalysisPayload | null) => {
    if (!payload || payload.source !== 'qwen') return false;
    const visionRaw = String(payload.aiDetailLayer?.vision?.rawText || '').toLowerCase();
    const asrRaw = String(payload.aiDetailLayer?.asr?.rawText || '').toLowerCase();
    const semanticRaw = String(payload.aiDetailLayer?.semantic?.rawText || '').toLowerCase();
    const isFallback = (text: string) =>
      text.includes('fallback:') || text.includes('timeout after') || text.includes('this operation was aborted');
    return isFallback(visionRaw) || isFallback(asrRaw) || isFallback(semanticRaw);
  };

  const pollAiJob = useCallback(
    async (jobId: string) => {
      if (!item) {
        return;
      }
      const maxAttempts = 180;
      let transientErrors = 0;
      for (let i = 0; i < maxAttempts; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        let status: any;
        try {
          const statusResp = await fetch(
            `/materials/analysis/job-status?jobId=${encodeURIComponent(jobId)}`
          );
          if (!statusResp.ok) {
            throw new Error(`status ${statusResp.status}`);
          }
          status = await statusResp.json();
          transientErrors = 0;
        } catch {
          transientErrors += 1;
          if (transientErrors <= 8) {
            setAiState('running');
            setAiMessage('AI任务状态查询波动，正在自动重试...');
            continue;
          }
          setAiState('failed');
          setAiMessage('AI状态查询失败，请重试AI分析。');
          return;
        }
        if (status?.state === 'queued') {
          setAiState('queued');
          setAiMessage(status?.message || 'AI任务排队中...');
          continue;
        }
        if (status?.state === 'running') {
          setAiState('running');
          setAiMessage(status?.message || 'AI正在分析中...');
          continue;
        }
        if (status?.state === 'succeeded') {
          const result = status?.result?.data as RemoteAnalysisPayload | undefined;
          if (result?.source === 'qwen' && hasAiPayloadContent(result)) {
            setAiAnalysis(result);
            setAiState('succeeded');
            setAiMessage('');
            setAiJobId(null);
            return;
          }
          setAiState('failed');
          setAiMessage('AI分析完成，但暂未返回可用的千问结果，可重试AI分析。');
          setAiJobId(null);
          return;
        }
        if (status?.state === 'failed' || status?.state === 'missing') {
          setAiState('failed');
          setAiMessage(status?.error || status?.message || 'AI分析失败，可重试AI分析。');
          setAiJobId(null);
          return;
        }
      }

      const routeKey = decodeURIComponent(id || '');
      const [routePlatform, routeExternalId] = routeKey.includes(':')
        ? routeKey.split(':', 2)
        : ['', ''];
      const normalizedPlatform = String(item.platform || routePlatform || '').trim().toLowerCase();
      const normalizedExternalId = String(item.externalId || routeExternalId || '').trim();
      if (normalizedPlatform && normalizedExternalId) {
        try {
          const qs = `platform=${encodeURIComponent(normalizedPlatform)}&externalId=${encodeURIComponent(
            normalizedExternalId
          )}`;
          const cachedResp = await fetch(`/materials/analysis?${qs}`);
          const cachedData = await cachedResp.json();
          if (
            cachedData?.found &&
            cachedData?.data?.source === 'qwen' &&
            hasAiPayloadContent(cachedData?.data)
          ) {
            if (shouldForceRefreshAi(cachedData.data)) {
              setAiState('failed');
              setAiMessage('检测到历史AI结果不完整，请点击「重试AI分析」。');
              setAiJobId(null);
              return;
            }
            setAiAnalysis(cachedData.data);
            setAiState('succeeded');
            setAiMessage('');
            setAiJobId(null);
            return;
          }
        } catch {
          // Ignore final cache check errors.
        }
      }
      setAiState('failed');
      setAiMessage('AI分析耗时较长，可稍后重试，或继续等待当前任务。');
    },
    [fetch, id, item]
  );

  const handleAiAnalyze = useCallback(async () => {
    if (!item) return;
    const aiInProgress = aiState === 'checking' || aiState === 'queued' || aiState === 'running';
    if (aiInProgress) return;

    if (aiAnalysis?.source === 'qwen' && hasAiPayloadContent(aiAnalysis) && !shouldForceRefreshAi(aiAnalysis)) {
      setAiState('succeeded');
      setAiMessage('');
      return;
    }

    if (aiJobId && aiState === 'failed') {
      setAiState('running');
      setAiMessage('正在继续查询AI任务状态...');
      await pollAiJob(aiJobId);
      return;
    }

    setAiState('checking');
    setAiMessage('正在检查AI分析缓存...');
    setAiJobId(null);

    try {
      const routeKey = decodeURIComponent(id || '');
      const [routePlatform, routeExternalId] = routeKey.includes(':')
        ? routeKey.split(':', 2)
        : ['', ''];
      const normalizedPlatform = String(item.platform || routePlatform || '').trim().toLowerCase();
      const normalizedExternalId = String(item.externalId || routeExternalId || '').trim();
      if (!normalizedPlatform || !normalizedExternalId) {
        throw new Error('素材缺少平台或外部ID，无法启动AI分析');
      }

      const qs = `platform=${encodeURIComponent(normalizedPlatform)}&externalId=${encodeURIComponent(
        normalizedExternalId
      )}`;
      const cachedResp = await fetch(`/materials/analysis?${qs}`);
      const cachedData = await cachedResp.json();
      if (
        cachedData?.found &&
        cachedData?.data?.source === 'qwen' &&
        hasAiPayloadContent(cachedData?.data)
      ) {
        if (!shouldForceRefreshAi(cachedData.data)) {
          setAiAnalysis(cachedData.data);
          setAiState('succeeded');
          setAiMessage('');
          return;
        }
        setAiMessage('检测到历史AI结果不完整，正在重跑分析...');
      }

      setAiMessage('正在启动AI分析任务...');
      const triggerResp = await fetch('/materials/analysis/trigger', {
        method: 'POST',
        body: JSON.stringify({
          item: {
            platform: normalizedPlatform,
            externalId: normalizedExternalId,
            title: item.title,
            desc: item.desc,
            coverUrl: item.coverUrl,
            contentUrl: item.contentUrl,
            authorName: item.authorName,
            authorUserId: item.authorUserId,
            createdAt: item.createdAt,
            likedCount: item.likedCount,
            collectedCount: item.collectedCount,
            commentCount: item.commentCount,
            shareCount: item.shareCount,
            followerCount: item.followerCount,
          },
          force: true,
        }),
      });
      if (!triggerResp.ok) {
        const text = await triggerResp.text();
        throw new Error(text || `HTTP ${triggerResp.status}`);
      }
      const triggerData = await triggerResp.json();

      if (
        triggerData?.found &&
        triggerData?.data?.source === 'qwen' &&
        hasAiPayloadContent(triggerData?.data)
      ) {
        if (!shouldForceRefreshAi(triggerData.data)) {
          setAiAnalysis(triggerData.data);
          setAiState('succeeded');
          setAiMessage('');
          return;
        }
        setAiMessage('检测到历史AI结果不完整，正在重跑分析...');
      }

      if (triggerData?.accepted && triggerData?.jobId) {
        const nextJobId = String(triggerData.jobId);
        setAiJobId(nextJobId);
        setAiState(triggerData?.state === 'running' ? 'running' : 'queued');
        setAiMessage(triggerData?.state === 'running' ? 'AI正在分析中...' : 'AI任务排队中...');
        await pollAiJob(nextJobId);
        return;
      }

      throw new Error('AI任务创建失败');
    } catch {
      setAiState('failed');
      setAiMessage('AI分析启动失败，请稍后重试。');
    }
  }, [aiAnalysis, aiJobId, aiState, fetch, id, item, pollAiJob]);

  useEffect(() => {
    if (!item || autoTriggeredRef.current) {
      return;
    }
    autoTriggeredRef.current = true;
    void handleAiAnalyze();
  }, [handleAiAnalyze, item]);

  if (!item) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.empty}>
            未找到这条爆款素材，请先在素材页爬取并点击「查看分析」进入详情。
          </div>
          <div className={styles.actions}>
            <button className={styles.button} onClick={backToMaterials}>
              返回素材页
            </button>
          </div>
        </div>
      </div>
    );
  }

  const aiInProgress = aiState === 'checking' || aiState === 'queued' || aiState === 'running';
  const hasAiResult = aiState === 'succeeded' && !!aiAnalysis;
  const sourceLabel = hasAiResult ? '千问AI' : aiInProgress ? 'AI分析中...' : 'AI分析';
  const mediaUrl = getProxiedUrl(
    isVideoUrl(item.contentUrl) ? item.contentUrl : item.coverUrl,
    item.platform,
    backendUrl
  );
  const cachedMediaUrl = useCachedMediaUrl(mediaUrl, Boolean(mediaUrl));
  const noteUrl =
    item.platform === 'xhs'
      ? `https://www.xiaohongshu.com/explore/${item.externalId}`
      : item.contentUrl || item.coverUrl || '';
  const aiVision = aiAnalysis?.aiDetailLayer?.vision;
  const aiAsr = aiAnalysis?.aiDetailLayer?.asr;
  const aiSemantic = aiAnalysis?.aiDetailLayer?.semantic;
  const aiProfile = aiSemantic?.profile360;

  const renderTags = (items?: string[]) => {
    if (!Array.isArray(items) || !items.length) return <span className={styles.subtitle}>暂无</span>;
    return (
      <div className={styles.tags}>
        {items.map((tag, idx) => (
          <span key={`${tag}_${idx}`} className={styles.tag}>
            {tag}
          </span>
        ))}
      </div>
    );
  };

  const renderRawText = (text?: string) => {
    if (!text) {
      return <p className={styles.subtitle}>无模型原始输出</p>;
    }
    return (
      <div className={styles.rawBlock}>
        <pre className={styles.rawText}>{text}</pre>
      </div>
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>{item.title || '未命名爆款素材'}</h1>
            <p className={styles.subtitle}>
              {item.platform.toUpperCase()} · {item.authorName || '未知作者'} · 外部ID: {item.externalId}
            </p>
            <p className={styles.subtitle}>分析来源：{sourceLabel}</p>
            {aiMessage ? <p className={styles.subtitle}>{aiMessage}</p> : null}
          </div>
          <div className={styles.actions}>
            <button className={styles.button} onClick={handleAiAnalyze} disabled={aiInProgress}>
              {aiInProgress ? 'AI分析中...' : aiState === 'failed' ? '重试AI分析' : '重新AI分析'}
            </button>
            {noteUrl ? (
              <button className={styles.buttonGhost} onClick={() => window.open(noteUrl, '_blank')}>
                打开原帖
              </button>
            ) : null}
            <button className={styles.button} onClick={backToMaterials}>
              返回素材页
            </button>
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <h3 className={styles.layerTitle}>素材预览</h3>
        <div className={styles.mediaBox}>
          {mediaUrl ? (
            isVideoUrl(item.contentUrl) ? (
              <video
                className={styles.media}
                src={cachedMediaUrl || mediaUrl}
                controls
                muted
                playsInline
                preload="metadata"
              />
            ) : (
              <img
                className={styles.media}
                src={cachedMediaUrl || mediaUrl}
                alt={item.title || 'material'}
                loading="lazy"
              />
            )
          ) : (
            <span className={styles.subtitle}>无可预览的媒体资源</span>
          )}
        </div>
        <div className={styles.line}>
          <span>点赞 / 收藏 / 评论 / 转发</span>
          <span>
            {formatNumber(item.likedCount)} / {formatNumber(item.collectedCount)} /{' '}
            {formatNumber(item.commentCount)} / {formatNumber(item.shareCount)}
          </span>
        </div>
        <div className={styles.line}>
          <span>发布时间</span>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {aiInProgress ? (
        <div className={styles.card}>
          <div className={styles.aiStatusCard}>
            <div className={styles.aiSpinner} />
            <h3 className={styles.layerTitle}>AI分析中</h3>
            <p className={styles.subtitle}>
              {aiMessage || '正在调用千问进行语音、画面和语义分析，请稍候...'}
            </p>
            {aiJobId ? <p className={styles.subtitle}>任务ID: {aiJobId}</p> : null}
          </div>
        </div>
      ) : hasAiResult && aiAnalysis ? (
        <>
          <div className={styles.card}>
            <h3 className={styles.layerTitle}>AI总结</h3>
            <p className={styles.subtitle}>
              {aiAnalysis.summaryLayer?.oneSentenceSummary || aiSemantic?.summary || '暂无一句话总结'}
            </p>
            <div className={styles.label} style={{ marginTop: 10 }}>
              核心亮点
            </div>
            {renderTags(aiAnalysis.summaryLayer?.highlights || aiSemantic?.highlights)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              优化建议
            </div>
            {renderTags(aiAnalysis.summaryLayer?.optimizationSuggestions || aiSemantic?.insights)}
          </div>

          <div className={styles.card}>
            <h3 className={styles.layerTitle}>360度内容画像</h3>
            <div className={styles.line}>
              <span>口播形态</span>
              <strong>{aiProfile?.speakingFormat || '未知'}</strong>
            </div>
            <div className={styles.line}>
              <span>主播角色</span>
              <strong>{aiProfile?.narratorRole || '未知'}</strong>
            </div>
            <div className={styles.label} style={{ marginTop: 10 }}>
              制作方式
            </div>
            {renderTags(aiProfile?.productionApproach)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              表达风格
            </div>
            {renderTags(aiProfile?.expressionStyle)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              说服路径
            </div>
            {renderTags(aiProfile?.persuasionPath)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              权威信号
            </div>
            {renderTags(aiProfile?.authoritySignals)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              合规信号
            </div>
            {renderTags(aiProfile?.complianceSignals)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              适配人群
            </div>
            {renderTags(aiProfile?.audienceFit)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              风险点
            </div>
            {renderTags(aiProfile?.risks)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              可复用角度
            </div>
            {renderTags(aiProfile?.reusableAngles)}
            <div className={styles.label} style={{ marginTop: 10 }}>
              360度总结
            </div>
            <p className={styles.subtitle}>
              {aiSemantic?.fullSummary360 || '暂无360度总结，建议重试AI分析。'}
            </p>
          </div>

          <div className={styles.layers}>
            <div className={styles.card}>
              <h3 className={styles.layerTitle}>音频ASR原始结果</h3>
              <div className={styles.line}>
                <span>模型</span>
                <strong>{aiAsr?.modelUsed || 'unknown'}</strong>
              </div>
              <div className={styles.line}>
                <span>置信度</span>
                <strong>{aiAsr?.confidence ?? '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>音频来源</span>
                <strong>{aiAsr?.audioSource || '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>语言 / 情绪</span>
                <strong>
                  {aiAsr?.language || '-'} / {aiAsr?.emotion || '-'}
                </strong>
              </div>
              <div className={styles.label} style={{ marginTop: 10 }}>
                转写文本
              </div>
              {renderRawText(aiAsr?.transcript)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                模型原始输出
              </div>
              {renderRawText(aiAsr?.rawText)}
            </div>

            <div className={styles.card}>
              <h3 className={styles.layerTitle}>视觉/VL关键帧原始结果</h3>
              <div className={styles.line}>
                <span>模型</span>
                <strong>{aiVision?.modelUsed || 'unknown'}</strong>
              </div>
              <div className={styles.line}>
                <span>置信度</span>
                <strong>{aiVision?.confidence ?? '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>媒体类型</span>
                <strong>{aiVision?.mediaType || '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>媒体URL</span>
                <strong>{aiVision?.mediaUrl || '-'}</strong>
              </div>
              <div className={styles.label} style={{ marginTop: 10 }}>
                视觉总结
              </div>
              <p className={styles.subtitle}>{aiVision?.summary || '暂无视觉总结'}</p>
              <div className={styles.label} style={{ marginTop: 10 }}>
                关键词
              </div>
              {renderTags(aiVision?.keywords)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                场景识别
              </div>
              {renderTags(aiVision?.scenes)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                关键帧描述
              </div>
              {renderTags(aiVision?.keyframes)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                模型原始输出
              </div>
              {renderRawText(aiVision?.rawText)}
            </div>

            <div className={styles.card}>
              <h3 className={styles.layerTitle}>语义LLM原始结果</h3>
              <div className={styles.line}>
                <span>模型</span>
                <strong>{aiSemantic?.modelUsed || 'unknown'}</strong>
              </div>
              <div className={styles.line}>
                <span>置信度</span>
                <strong>{aiSemantic?.confidence ?? '-'}</strong>
              </div>
              <div className={styles.line}>
                <span>语气</span>
                <strong>{aiSemantic?.tone || '-'}</strong>
              </div>
              <div className={styles.label} style={{ marginTop: 10 }}>
                语义总结
              </div>
              <p className={styles.subtitle}>{aiSemantic?.summary || '暂无语义总结'}</p>
              <div className={styles.label} style={{ marginTop: 10 }}>
                亮点
              </div>
              {renderTags(aiSemantic?.highlights)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                关键词
              </div>
              {renderTags(aiSemantic?.keywords)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                洞察建议
              </div>
              {renderTags(aiSemantic?.insights)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                360度总结原文
              </div>
              {renderRawText(aiSemantic?.fullSummary360)}
              <div className={styles.label} style={{ marginTop: 10 }}>
                模型原始输出
              </div>
              {renderRawText(aiSemantic?.rawText)}
            </div>
          </div>
        </>
      ) : (
        <div className={styles.card}>
          <div className={styles.aiStatusCard}>
            <h3 className={styles.layerTitle}>{aiState === 'failed' ? 'AI分析失败' : '暂无AI分析结果'}</h3>
            <p className={styles.subtitle}>
              {aiMessage || '正在准备AI分析结果，可点击「重新AI分析」触发。'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

