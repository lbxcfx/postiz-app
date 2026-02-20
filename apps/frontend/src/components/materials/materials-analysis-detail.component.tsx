'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import {
  findMaterialFromDataset,
  loadMaterialDataset,
} from '@gitroom/frontend/components/materials/materials-analysis.storage';
import { buildMaterialAnalysis } from '@gitroom/frontend/components/materials/materials-analysis.engine';
import styles from '@gitroom/frontend/components/materials/materials-analysis-detail.module.scss';

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

const formatPercent = (value: number | null) => {
  if (value === null) return '-';
  return `${(value * 100).toFixed(2)}%`;
};

export const MaterialsAnalysisDetail = () => {
  const { backendUrl } = useVariables();
  const router = useRouter();
  const params = useParams();
  const rawId = params?.id;
  const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : '';

  const dataset = useMemo(() => loadMaterialDataset(), []);
  const item = useMemo(() => findMaterialFromDataset(id), [id]);
  const analysis = useMemo(() => {
    if (!item) return null;
    return buildMaterialAnalysis(item, dataset);
  }, [item, dataset]);

  if (!item || !analysis) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.empty}>
            未找到这条爆款素材，请先在素材页爬取并点击「查看分析」进入详情。
          </div>
          <div className={styles.actions}>
            <button className={styles.button} onClick={() => router.push('/materials')}>
              返回素材页
            </button>
          </div>
        </div>
      </div>
    );
  }

  const mediaUrl = getProxiedUrl(
    isVideoUrl(item.contentUrl) ? item.contentUrl : item.coverUrl,
    item.platform,
    backendUrl
  );
  const noteUrl =
    item.platform === 'xhs'
      ? `https://www.xiaohongshu.com/explore/${item.externalId}`
      : item.contentUrl || item.coverUrl || '';

  const highEnergySegments = analysis.timeline.filter((segment) => segment.isHighEnergy);
  const totalHeat = analysis.timeline.reduce((sum, segment) => sum + segment.heat, 0);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>{item.title || '未命名爆款素材'}</h1>
            <p className={styles.subtitle}>
              {item.platform.toUpperCase()} · {item.authorName || '未知作者'} · 外部ID: {item.externalId}
            </p>
          </div>
          <div className={styles.actions}>
            {noteUrl ? (
              <button className={styles.buttonGhost} onClick={() => window.open(noteUrl, '_blank')}>
                打开原帖
              </button>
            ) : null}
            <button className={styles.button} onClick={() => router.push('/materials')}>
              返回素材页
            </button>
          </div>
        </div>
      </div>

      <div className={styles.overview}>
        <div className={styles.overviewCell}>
          <div className={styles.label}>可解释总分</div>
          <div className={styles.value}>{analysis.scoreLayer.overallScore}</div>
          <div className={styles.subtitle}>等级 {analysis.scoreLayer.level}</div>
        </div>
        <div className={styles.overviewCell}>
          <div className={styles.label}>模型置信度</div>
          <div className={styles.value}>{analysis.scoreLayer.confidence}</div>
          <div className={styles.subtitle}>解析/特征可用性</div>
        </div>
        <div className={styles.overviewCell}>
          <div className={styles.label}>高能片段数</div>
          <div className={styles.value}>{highEnergySegments.length}</div>
          <div className={styles.subtitle}>总热度 {Math.round(totalHeat / analysis.timeline.length)}</div>
        </div>
        <div className={styles.overviewCell}>
          <div className={styles.label}>互动规模</div>
          <div className={styles.valueSmall}>{formatNumber(analysis.parseLayer.interactionTotal)}</div>
          <div className={styles.subtitle}>
            互动率 {formatPercent(analysis.parseLayer.interactionRate)}
          </div>
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.card}>
          <h3 className={styles.layerTitle}>素材预览</h3>
          <div className={styles.mediaBox}>
            {mediaUrl ? (
              isVideoUrl(item.contentUrl) ? (
                <video className={styles.media} src={mediaUrl} controls muted playsInline preload="metadata" />
              ) : (
                <img
                  className={styles.media}
                  src={mediaUrl}
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

        <div className={styles.card}>
          <h3 className={styles.layerTitle}>高能时间轴</h3>
          <div className={styles.timelineTrack}>
            {analysis.timeline.map((segment) => (
              <div
                key={segment.index}
                className={styles.timelineSeg}
                style={{ width: `${100 / analysis.timeline.length}%` }}
                title={`${segment.startSec}s-${segment.endSec}s · 热度${segment.heat} · ${segment.reason}`}
              >
                <div
                  className={styles.timelineFill}
                  style={{
                    background: segment.isHighEnergy
                      ? 'linear-gradient(90deg,#fb7185,#ff2442)'
                      : `linear-gradient(90deg, rgba(59,130,246,0.4), rgba(59,130,246,${Math.max(
                          0.45,
                          segment.heat / 100
                        )}))`,
                  }}
                />
              </div>
            ))}
          </div>
          <div className={styles.highEnergyList}>
            {highEnergySegments.length === 0 ? (
              <div className={styles.line}>
                <span>暂无超过阈值的高能片段</span>
                <span>建议增强开场钩子和 CTA</span>
              </div>
            ) : (
              highEnergySegments.map((segment) => (
                <div key={`high_${segment.index}`} className={styles.highEnergyItem}>
                  <span>
                    {segment.startSec}s - {segment.endSec}s
                  </span>
                  <span>{segment.reason}</span>
                  <strong>热度 {segment.heat}</strong>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className={styles.layers}>
        <div className={styles.card}>
          <h3 className={styles.layerTitle}>解析层（声音 / 视频）</h3>
          <div className={styles.line}>
            <span>估计时长</span>
            <strong>{analysis.parseLayer.estimatedDurationSec}s</strong>
          </div>
          <div className={styles.line}>
            <span>音频语速 / 情绪</span>
            <strong>
              {analysis.parseLayer.audio.speechRate} / {analysis.parseLayer.audio.emotion}
            </strong>
          </div>
          <div className={styles.line}>
            <span>停顿密度 / 字幕密度</span>
            <strong>
              {analysis.parseLayer.audio.pauseDensity}% / {analysis.parseLayer.video.subtitleDensity}%
            </strong>
          </div>
          <div className={styles.line}>
            <span>镜头切换密度</span>
            <strong>{analysis.parseLayer.video.sceneSwitchDensity}%</strong>
          </div>
          <div className={styles.line}>
            <span>命中 CTA 词</span>
            <strong>{analysis.parseLayer.audio.ctaKeywords.join(' / ') || '-'}</strong>
          </div>
        </div>

        <div className={styles.card}>
          <h3 className={styles.layerTitle}>特征层</h3>
          {[
            ['开场钩子', analysis.featureLayer.hookStrength],
            ['信息密度', analysis.featureLayer.informationDensity],
            ['情绪感染', analysis.featureLayer.emotionStrength],
            ['转化引导', analysis.featureLayer.conversionStrength],
            ['节奏控制', analysis.featureLayer.rhythmControl],
            ['视觉信号', analysis.featureLayer.visualSignal],
          ].map(([name, score]) => (
            <div key={name} className={styles.barRow}>
              <span>{name}</span>
              <div className={styles.barTrack}>
                <div className={styles.barFill} style={{ width: `${score}%` }} />
              </div>
              <strong>{score}</strong>
            </div>
          ))}
        </div>

        <div className={styles.card}>
          <h3 className={styles.layerTitle}>评分层（可解释）</h3>
          {analysis.scoreLayer.dimensions.map((dimension) => (
            <div key={dimension.id}>
              <div className={styles.barRow}>
                <span>
                  {dimension.name} ({Math.round(dimension.weight * 100)}%)
                </span>
                <div className={styles.barTrack}>
                  <div className={styles.barFill} style={{ width: `${dimension.score}%` }} />
                </div>
                <strong>{dimension.score}</strong>
              </div>
              <p className={styles.dimReason}>{dimension.reason}</p>
            </div>
          ))}
        </div>

        <div className={styles.card}>
          <h3 className={styles.layerTitle}>标签层</h3>
          <div className={styles.label}>行业标签</div>
          <div className={styles.tags}>
            {analysis.tagLayer.industry.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>

          <div className={styles.label} style={{ marginTop: 10 }}>
            风格标签
          </div>
          <div className={styles.tags}>
            {analysis.tagLayer.styleTags.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>

          <div className={styles.label} style={{ marginTop: 10 }}>
            爆款特征标签
          </div>
          <div className={styles.tags}>
            {analysis.tagLayer.featureTags.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>

          <div className={styles.label} style={{ marginTop: 10 }}>
            高频关键词
          </div>
          <div className={styles.tags}>
            {analysis.tagLayer.hotKeywords.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
