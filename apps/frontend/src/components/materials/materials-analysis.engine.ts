import { MaterialItem } from '@gitroom/frontend/components/materials/materials.types';
import { calculateViralScore } from '@gitroom/frontend/components/materials/viral-score';

type ScoreDimensionId =
  | 'hook'
  | 'information_density'
  | 'emotion'
  | 'conversion'
  | 'rhythm';

export type IndustryTag =
  | '美妆护肤'
  | '时尚穿搭'
  | '美食餐饮'
  | '家居生活'
  | '数码科技'
  | '职场教育'
  | '健康健身'
  | '母婴亲子'
  | '综合';

export type AnalysisLayerResult = {
  parseLayer: {
    textLength: number;
    tokenCount: number;
    interactionTotal: number;
    interactionRate: number | null;
    estimatedDurationSec: number;
    hasVideo: boolean;
    hasAudioSignal: boolean;
    audio: {
      speechRate: '慢' | '中' | '快';
      emotion: '平稳' | '积极' | '高唤起';
      pauseDensity: number;
      ctaKeywords: string[];
    };
    video: {
      subtitleDensity: number;
      visualHookStrength: number;
      sceneSwitchDensity: number;
    };
  };
  featureLayer: {
    hookStrength: number;
    informationDensity: number;
    emotionStrength: number;
    conversionStrength: number;
    rhythmControl: number;
    visualSignal: number;
  };
  scoreLayer: {
    overallScore: number;
    level: 'S' | 'A' | 'B' | 'C';
    dimensions: {
      id: ScoreDimensionId;
      name: string;
      score: number;
      weight: number;
      reason: string;
    }[];
    confidence: number;
  };
  tagLayer: {
    industry: IndustryTag[];
    styleTags: string[];
    featureTags: string[];
    hotKeywords: string[];
  };
  timeline: {
    index: number;
    startSec: number;
    endSec: number;
    heat: number;
    isHighEnergy: boolean;
    reason: string;
  }[];
};

const INDUSTRY_DICT: Array<{ tag: IndustryTag; keywords: string[] }> = [
  {
    tag: '美妆护肤',
    keywords: ['护肤', '彩妆', '妆容', '粉底', '口红', '美白', '精华', '祛痘', '面膜'],
  },
  {
    tag: '时尚穿搭',
    keywords: ['穿搭', 'ootd', '通勤', '搭配', '鞋子', '裙子', '外套', '显瘦', '时尚'],
  },
  {
    tag: '美食餐饮',
    keywords: ['美食', '餐厅', '探店', '好吃', '菜谱', '烘焙', '火锅', '咖啡', '饮品'],
  },
  {
    tag: '家居生活',
    keywords: ['家居', '收纳', '装修', '卧室', '客厅', '清洁', '居家', '好物'],
  },
  {
    tag: '数码科技',
    keywords: ['数码', '手机', '电脑', '相机', '测评', '芯片', '性能', '科技', 'app'],
  },
  {
    tag: '职场教育',
    keywords: ['职场', '简历', '面试', '学习', '复习', '课程', '英语', '干货', '效率'],
  },
  {
    tag: '健康健身',
    keywords: ['健身', '减脂', '训练', '跑步', '瑜伽', '健康', '饮食管理', '体重'],
  },
  {
    tag: '母婴亲子',
    keywords: ['母婴', '宝宝', '育儿', '亲子', '辅食', '奶粉', '孕期', '早教'],
  },
];

const STYLE_RULES: Array<{ tag: string; keywords: string[] }> = [
  { tag: '教程拆解', keywords: ['步骤', '教程', '怎么', '技巧', '手把手'] },
  { tag: '对比测评', keywords: ['对比', '测评', '实测', '横评', 'pk'] },
  { tag: '避坑清单', keywords: ['避坑', '踩雷', '不推荐', '慎买', '翻车'] },
  { tag: '清单种草', keywords: ['推荐', '合集', '必买', '宝藏', '平替'] },
  { tag: '故事叙事', keywords: ['经历', '故事', '分享', '真实', '复盘'] },
];

const HOOK_KEYWORDS = ['一定要看', '别划走', '3秒', '先说结论', '真的', '太绝了', '立刻'];
const CTA_KEYWORDS = ['评论', '收藏', '关注', '私信', '转发', '点赞', '下期'];
const EMOTION_KEYWORDS = ['惊喜', '震惊', '太香', '哭了', '上头', '炸裂', '绝了', '爱了'];
const STOP_WORDS = new Set([
  '我们',
  '你们',
  '这个',
  '那个',
  '一下',
  '还是',
  '然后',
  '因为',
  '所以',
  '就是',
  '一个',
  '可以',
  '真的',
  '自己',
  '已经',
  '今天',
  '视频',
  '图文',
  '内容',
  '分享',
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
]);

const clamp = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max);
};

const safe = (value?: number) => {
  return Number.isFinite(value) ? (value as number) : 0;
};

const includesAny = (text: string, keywords: string[]) => {
  return keywords.filter((word) => text.includes(word));
};

const inferHasVideo = (item: MaterialItem) => {
  const url = `${item.contentUrl || ''} ${item.coverUrl || ''}`.toLowerCase();
  return /\.(mp4|mov|m3u8|webm|avi)(\?|#|$)/.test(url) || url.includes('/video/');
};

const tokenize = (text: string) => {
  const hits = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]{2,}/g) || [];
  return hits.filter((token) => !STOP_WORDS.has(token));
};

const estimateDurationSec = (
  hasVideo: boolean,
  textLength: number,
  interactions: number
) => {
  const base = hasVideo ? 32 : 18;
  const textFactor = Math.min(28, Math.round(textLength / 12));
  const interactionFactor = Math.min(20, Math.round(Math.log10(Math.max(interactions, 10)) * 6));
  return clamp(base + textFactor + interactionFactor, 15, 130);
};

const calcIndustryTags = (text: string): IndustryTag[] => {
  const tags = INDUSTRY_DICT.filter((group) =>
    group.keywords.some((keyword) => text.includes(keyword))
  ).map((group) => group.tag);
  return tags.length ? tags : ['综合'];
};

const calcStyleTags = (text: string): string[] => {
  const tags = STYLE_RULES.filter((rule) =>
    rule.keywords.some((keyword) => text.includes(keyword))
  ).map((rule) => rule.tag);
  return tags.length ? tags : ['经验分享'];
};

const calcHotKeywords = (tokens: string[]) => {
  const countMap = new Map<string, number>();
  tokens.forEach((token) => {
    countMap.set(token, (countMap.get(token) || 0) + 1);
  });
  return Array.from(countMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([token]) => token);
};

const calcScoreLevel = (score: number): 'S' | 'A' | 'B' | 'C' => {
  if (score >= 82) return 'S';
  if (score >= 70) return 'A';
  if (score >= 58) return 'B';
  return 'C';
};

const calcTimeline = (
  durationSec: number,
  hookStrength: number,
  informationDensity: number,
  emotionStrength: number,
  conversionStrength: number,
  rhythmControl: number
) => {
  const segmentCount = 6;
  const segmentSec = durationSec / segmentCount;
  const baseHeats = [
    35 + hookStrength * 0.6,
    20 + hookStrength * 0.25 + informationDensity * 0.35,
    18 + informationDensity * 0.4 + rhythmControl * 0.3,
    16 + emotionStrength * 0.55 + rhythmControl * 0.25,
    20 + informationDensity * 0.35 + conversionStrength * 0.35,
    15 + conversionStrength * 0.6 + emotionStrength * 0.2,
  ];
  const reasons = [
    '开场钩子集中释放',
    '关键问题与核心观点出现',
    '信息密集段，连续给价值',
    '情绪拉升段，易触发互动',
    '观点总结 + 场景映射',
    'CTA 收束，推动收藏/评论',
  ];
  return baseHeats.map((value, idx) => {
    const heat = clamp(Math.round(value), 0, 100);
    const start = Math.round(idx * segmentSec);
    const end = Math.round((idx + 1) * segmentSec);
    return {
      index: idx + 1,
      startSec: start,
      endSec: Math.max(end, start + 1),
      heat,
      isHighEnergy: heat >= 75,
      reason: reasons[idx],
    };
  });
};

export const buildMaterialAnalysis = (
  item: MaterialItem,
  context: MaterialItem[] = []
): AnalysisLayerResult => {
  const title = item.title || '';
  const desc = item.desc || '';
  const combinedText = `${title} ${desc}`.trim();
  const tokens = tokenize(combinedText);
  const textLength = combinedText.length;

  const likes = safe(item.likedCount);
  const comments = safe(item.commentCount);
  const shares = safe(item.shareCount);
  const collects = safe(item.collectedCount);
  const followers = safe(item.followerCount);
  const interactions = likes + comments * 1.4 + shares * 1.6 + collects * 1.5;
  const interactionRate = followers > 0 ? interactions / followers : null;

  const hasVideo = inferHasVideo(item);
  const durationSec = estimateDurationSec(hasVideo, textLength, interactions);

  const hookHits = includesAny(combinedText, HOOK_KEYWORDS);
  const ctaHits = includesAny(combinedText, CTA_KEYWORDS);
  const emotionHits = includesAny(combinedText, EMOTION_KEYWORDS);
  const punctuationCount = (combinedText.match(/[，。！？、,.!?]/g) || []).length;

  const speechRateRaw = tokens.length / Math.max(durationSec, 1) * 4.5;
  const speechRate: '慢' | '中' | '快' =
    speechRateRaw >= 2.4 ? '快' : speechRateRaw <= 1.4 ? '慢' : '中';
  const pauseDensity = clamp(Math.round((punctuationCount / Math.max(textLength, 1)) * 1200), 0, 100);
  const emotion: '平稳' | '积极' | '高唤起' =
    emotionHits.length >= 3 || (combinedText.match(/!/g) || []).length >= 3
      ? '高唤起'
      : emotionHits.length >= 1
      ? '积极'
      : '平稳';

  const subtitleDensity = clamp(Math.round((tokens.length / Math.max(durationSec, 1)) * 18), 8, 100);
  const visualHookStrength = clamp(40 + hookHits.length * 12 + (hasVideo ? 12 : 0), 0, 100);
  const sceneSwitchDensity = clamp(
    Math.round((hasVideo ? 48 : 26) + Math.min(20, punctuationCount * 2.2)),
    0,
    100
  );

  const vir = item.viralResult
    ? item.viralResult
    : calculateViralScore({
        likes,
        shares,
        comments,
        collects,
        followers,
        publishedAt: item.createdAt,
      });

  const hookStrength = clamp(
    Math.round(32 + hookHits.length * 14 + (vir.timeMultiplier > 1 ? 10 : 0) + (likes > 3000 ? 8 : 0)),
    0,
    100
  );
  const informationDensity = clamp(
    Math.round(
      28 +
        Math.min(32, tokens.length * 0.9) +
        Math.min(14, punctuationCount * 1.4) +
        (comments > 200 ? 8 : 0)
    ),
    0,
    100
  );
  const emotionStrength = clamp(
    Math.round(
      24 +
        emotionHits.length * 14 +
        (shares > 120 ? 10 : 0) +
        ((combinedText.match(/!/g) || []).length >= 2 ? 8 : 0)
    ),
    0,
    100
  );
  const conversionStrength = clamp(
    Math.round(22 + ctaHits.length * 16 + (collects > 150 ? 10 : 0) + (comments > 120 ? 6 : 0)),
    0,
    100
  );
  const rhythmControl = clamp(
    Math.round(
      30 +
        (hasVideo ? 14 : 8) +
        (durationSec <= 60 ? 12 : 6) +
        (speechRate === '中' ? 8 : speechRate === '快' ? 6 : 4)
    ),
    0,
    100
  );
  const visualSignal = clamp(
    Math.round(30 + (hasVideo ? 18 : 10) + visualHookStrength * 0.35 + sceneSwitchDensity * 0.2),
    0,
    100
  );

  const dimensions = [
    {
      id: 'hook' as const,
      name: '开场钩子',
      score: hookStrength,
      weight: 0.24,
      reason: hookHits.length
        ? `命中钩子词：${hookHits.slice(0, 3).join(' / ')}`
        : '开场钩子词较少，建议强化首屏冲击',
    },
    {
      id: 'information_density' as const,
      name: '信息密度',
      score: informationDensity,
      weight: 0.22,
      reason: `有效词 ${tokens.length}，语义停顿密度 ${pauseDensity}%`,
    },
    {
      id: 'emotion' as const,
      name: '情绪感染',
      score: emotionStrength,
      weight: 0.18,
      reason:
        emotion === '高唤起'
          ? '高唤起表达明显，易触发互动'
          : emotion === '积极'
          ? '情绪偏积极，有扩散潜力'
          : '情绪强度偏稳，建议加入对比/反转表达',
    },
    {
      id: 'conversion' as const,
      name: '转化引导',
      score: conversionStrength,
      weight: 0.18,
      reason: ctaHits.length
        ? `命中引导词：${ctaHits.slice(0, 3).join(' / ')}`
        : '缺少明确 CTA，收藏评论引导偏弱',
    },
    {
      id: 'rhythm' as const,
      name: '节奏控制',
      score: rhythmControl,
      weight: 0.18,
      reason: `估计时长 ${durationSec}s，语速 ${speechRate}`,
    },
  ];

  const overallScore = clamp(
    Math.round(dimensions.reduce((sum, dim) => sum + dim.score * dim.weight, 0)),
    0,
    100
  );
  const level = calcScoreLevel(overallScore);
  const confidence = clamp(
    Math.round(
      44 +
        (title ? 10 : 0) +
        (desc ? 12 : 0) +
        (followers > 0 ? 10 : 0) +
        (context.length > 5 ? 8 : 4)
    ),
    40,
    98
  );

  const industry = calcIndustryTags(combinedText);
  const styleTags = calcStyleTags(combinedText);
  const hotKeywords = calcHotKeywords(tokens);
  const featureTags = [
    hookStrength >= 75 ? '强开场' : '开场可提升',
    informationDensity >= 70 ? '高信息密度' : '信息密度一般',
    emotionStrength >= 70 ? '情绪驱动' : '情绪平稳',
    conversionStrength >= 68 ? 'CTA明确' : 'CTA偏弱',
    visualSignal >= 70 ? '画面信号强' : '画面信号中等',
  ];

  const timeline = calcTimeline(
    durationSec,
    hookStrength,
    informationDensity,
    emotionStrength,
    conversionStrength,
    rhythmControl
  );

  return {
    parseLayer: {
      textLength,
      tokenCount: tokens.length,
      interactionTotal: Math.round(interactions),
      interactionRate: interactionRate === null ? null : Number(interactionRate.toFixed(4)),
      estimatedDurationSec: durationSec,
      hasVideo,
      hasAudioSignal: hasVideo || Boolean(desc || title),
      audio: {
        speechRate,
        emotion,
        pauseDensity,
        ctaKeywords: ctaHits,
      },
      video: {
        subtitleDensity,
        visualHookStrength,
        sceneSwitchDensity,
      },
    },
    featureLayer: {
      hookStrength,
      informationDensity,
      emotionStrength,
      conversionStrength,
      rhythmControl,
      visualSignal,
    },
    scoreLayer: {
      overallScore,
      level,
      dimensions,
      confidence,
    },
    tagLayer: {
      industry,
      styleTags,
      featureTags,
      hotKeywords,
    },
    timeline,
  };
};
