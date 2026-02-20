'use client';

import { useMemo, useState } from 'react';
import styles from '@gitroom/frontend/components/materials/insights-center.module.scss';
import { loadMaterialDataset } from '@gitroom/frontend/components/materials/materials-analysis.storage';
import {
  buildMaterialAnalysis,
  IndustryTag,
} from '@gitroom/frontend/components/materials/materials-analysis.engine';

const INDUSTRY_OPTIONS: Array<'ALL' | IndustryTag> = [
  'ALL',
  '美妆护肤',
  '时尚穿搭',
  '美食餐饮',
  '家居生活',
  '数码科技',
  '职场教育',
  '健康健身',
  '母婴亲子',
  '综合',
];

const average = (values: number[]) => {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
};

const clampRate = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 10;
};

export const InsightsCenter = () => {
  const [keyword, setKeyword] = useState('');
  const [industry, setIndustry] = useState<'ALL' | IndustryTag>('ALL');
  const [datasetVersion, setDatasetVersion] = useState(0);

  const dataset = useMemo(() => loadMaterialDataset(), [datasetVersion]);

  const analyzed = useMemo(
    () =>
      dataset.map((item) => ({
        item,
        analysis: buildMaterialAnalysis(item, dataset),
      })),
    [dataset]
  );

  const keywordOptions = useMemo(() => {
    const map = new Map<string, number>();
    analyzed.forEach(({ analysis }) => {
      analysis.tagLayer.hotKeywords.forEach((token) => {
        map.set(token, (map.get(token) || 0) + 1);
      });
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([token]) => token);
  }, [analyzed]);

  const filtered = useMemo(() => {
    const loweredKeyword = keyword.trim().toLowerCase();
    return analyzed.filter(({ item, analysis }) => {
      if (industry !== 'ALL' && !analysis.tagLayer.industry.includes(industry)) {
        return false;
      }
      if (!loweredKeyword) return true;
      const text = `${item.title || ''} ${item.desc || ''}`.toLowerCase();
      if (text.includes(loweredKeyword)) return true;
      return analysis.tagLayer.hotKeywords.some((token) =>
        token.toLowerCase().includes(loweredKeyword)
      );
    });
  }, [analyzed, keyword, industry]);

  const overview = useMemo(() => {
    const scores = filtered.map(({ analysis }) => analysis.scoreLayer.overallScore);
    const highScoreCount = filtered.filter(
      ({ analysis }) => analysis.scoreLayer.overallScore >= 70
    ).length;
    const avgTimelineHeat = average(
      filtered.map(({ analysis }) => average(analysis.timeline.map((segment) => segment.heat)))
    );

    return {
      total: filtered.length,
      avgScore: average(scores),
      viralRate: filtered.length ? clampRate(highScoreCount / filtered.length) : 0,
      avgTimelineHeat,
    };
  }, [filtered]);

  const topFeatures = useMemo(() => {
    const rows = [
      {
        name: '开场钩子',
        values: filtered.map(({ analysis }) => analysis.featureLayer.hookStrength),
      },
      {
        name: '信息密度',
        values: filtered.map(({ analysis }) => analysis.featureLayer.informationDensity),
      },
      {
        name: '情绪感染',
        values: filtered.map(({ analysis }) => analysis.featureLayer.emotionStrength),
      },
      {
        name: '转化引导',
        values: filtered.map(({ analysis }) => analysis.featureLayer.conversionStrength),
      },
      {
        name: '节奏控制',
        values: filtered.map(({ analysis }) => analysis.featureLayer.rhythmControl),
      },
      {
        name: '视觉信号',
        values: filtered.map(({ analysis }) => analysis.featureLayer.visualSignal),
      },
    ];

    return rows
      .map((row) => ({
        name: row.name,
        score: average(row.values),
      }))
      .sort((a, b) => b.score - a.score);
  }, [filtered]);

  const topTags = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach(({ analysis }) => {
      [...analysis.tagLayer.styleTags, ...analysis.tagLayer.featureTags].forEach((tag) => {
        map.set(tag, (map.get(tag) || 0) + 1);
      });
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);
  }, [filtered]);

  const industryStats = useMemo(() => {
    const statsMap = new Map<
      string,
      { count: number; scoreList: number[]; highScoreCount: number }
    >();
    analyzed.forEach(({ analysis }) => {
      analysis.tagLayer.industry.forEach((tag) => {
        const row = statsMap.get(tag) || { count: 0, scoreList: [], highScoreCount: 0 };
        row.count += 1;
        row.scoreList.push(analysis.scoreLayer.overallScore);
        if (analysis.scoreLayer.overallScore >= 70) {
          row.highScoreCount += 1;
        }
        statsMap.set(tag, row);
      });
    });
    return Array.from(statsMap.entries())
      .map(([tag, value]) => ({
        tag,
        count: value.count,
        avgScore: average(value.scoreList),
        viralRate: value.count ? clampRate(value.highScoreCount / value.count) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [analyzed]);

  const topSamples = useMemo(() => {
    return filtered
      .slice()
      .sort((a, b) => b.analysis.scoreLayer.overallScore - a.analysis.scoreLayer.overallScore)
      .slice(0, 6);
  }, [filtered]);

  if (!dataset.length) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.empty}>
            暂无可分析素材。请先去「素材页」爬取爆款内容，再进入洞察中心查看行业规律。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>洞察中心</h1>
            <p className={styles.subtitle}>
              关键词 + 行业双过滤，观察哪些特征更接近爆款内容结构
            </p>
          </div>
          <div className={styles.filters}>
            <input
              className={styles.input}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              list="insights-keywords"
              placeholder="按关键词筛选，如：测评、教程"
            />
            <datalist id="insights-keywords">
              {keywordOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <select
              className={styles.select}
              value={industry}
              onChange={(event) => setIndustry(event.target.value as 'ALL' | IndustryTag)}
            >
              {INDUSTRY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === 'ALL' ? '全部行业' : option}
                </option>
              ))}
            </select>
            <button className={styles.select} onClick={() => setDatasetVersion((v) => v + 1)}>
              刷新数据集
            </button>
          </div>
        </div>
      </div>

      <div className={styles.overview}>
        <div className={styles.overviewCell}>
          <div className={styles.label}>命中素材数</div>
          <div className={styles.value}>{overview.total}</div>
        </div>
        <div className={styles.overviewCell}>
          <div className={styles.label}>平均爆款分</div>
          <div className={styles.value}>{overview.avgScore}</div>
        </div>
        <div className={styles.overviewCell}>
          <div className={styles.label}>高分占比</div>
          <div className={styles.value}>{overview.viralRate}%</div>
        </div>
        <div className={styles.overviewCell}>
          <div className={styles.label}>平均时间轴热度</div>
          <div className={styles.value}>{overview.avgTimelineHeat}</div>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <h3>哪些特征更像爆款</h3>
          {topFeatures.map((feature) => (
            <div key={feature.name} className={styles.featureRow}>
              <span>{feature.name}</span>
              <div className={styles.barTrack}>
                <div className={styles.barFill} style={{ width: `${feature.score}%` }} />
              </div>
              <strong>{feature.score}</strong>
            </div>
          ))}
        </div>

        <div className={styles.card}>
          <h3>行业规律分布</h3>
          {industryStats.map((row) => (
            <div key={row.tag} className={styles.line}>
              <span>{row.tag}</span>
              <span>
                {row.count} 条 · 均分 {row.avgScore} · 高分占比 {row.viralRate}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <h3>高频结构标签</h3>
          <div className={styles.tags}>
            {topTags.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className={styles.card}>
          <h3>样本 TOP6（按可解释总分）</h3>
          {topSamples.map(({ item, analysis }) => (
            <div key={`${item.platform}:${item.externalId}`} className={styles.line}>
              <span>{item.title || item.desc?.slice(0, 24) || '未命名素材'}</span>
              <span>{analysis.scoreLayer.overallScore} 分</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
