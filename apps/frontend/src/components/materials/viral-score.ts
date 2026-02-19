/**
 * 爆款评分算法 (Viral Score Algorithm) v2
 *
 * 三个核心维度:
 * 1. 互动量 — 点赞、转发、评论是否达到阈值
 * 2. 粉丝效率 — 同样的互动数，粉丝少的更爆
 * 3. 时间速度 — 短时间获得高互动 > 长时间积累
 *
 * 公式:
 *   rawScore = (likes/minLikes)*0.5 + (shares/minShares)*0.3 + (comments/minComments)*0.2
 *
 *   followerMultiplier = clamp(referenceFollowers / max(followers,1), 0.1, 5.0)
 *     - 小号(2000粉): 50000/2000 = 25 → cap 5.0 (大幅加分)
 *     - 大号(100w粉): 50000/1000000 = 0.05 → cap 0.1 (大幅减分)
 *
 *   timeMultiplier = clamp(referenceDays / daysSincePublish, 0.1, 5.0)
 *     - 7天内: 30/7 = 4.28 (最近内容加分)
 *     - 30天: 30/30 = 1.0 (基准)
 *     - 365天: 30/365 = 0.08 → cap 0.1 (老内容减分)
 *
 *   viralScore = rawScore × followerMultiplier × timeMultiplier
 *   isViral = viralScore >= 1.0
 */

export interface ViralThresholds {
    /** 最低点赞数 */
    minLikes: number;
    /** 最低转发数 */
    minShares: number;
    /** 最低评论/互动数 */
    minComments: number;
    /** 参考粉丝数（低于此值加分，高于此值减分） */
    referenceFollowers: number;
    /** 参考天数（发布在此天数内为基准，更新的加分，更老的减分） */
    referenceDays: number;
}

export const DEFAULT_VIRAL_THRESHOLDS: ViralThresholds = {
    minLikes: 1000,
    minShares: 200,
    minComments: 10,
    referenceFollowers: 50000,
    referenceDays: 30,
};

/** 权重常量 */
const W_LIKES = 0.5;
const W_SHARES = 0.3;
const W_COMMENTS = 0.2;

export interface ViralInput {
    likes: number;
    shares: number;
    comments: number;
    collects?: number;
    /** 作者粉丝数 (必选，0 表示未知) */
    followers: number;
    /** 发布时间 (ISO string 或 timestamp) */
    publishedAt?: string | number;
}

export interface ViralResult {
    score: number;
    isViral: boolean;
    /** 互动率 (总互动/粉丝) */
    engagementRate?: number;
    /** 粉丝倍率 */
    followerMultiplier: number;
    /** 时间倍率 */
    timeMultiplier: number;
    /** 发布距今天数 */
    daysSincePublish?: number;
    /** 人类可读的评级 */
    level: 'viral' | 'hot' | 'warm' | 'normal';
}

/**
 * 将日期转换为距今天数
 */
function getDaysSincePublish(publishedAt?: string | number): number | undefined {
    if (!publishedAt) return undefined;

    let pubDate: Date;
    if (typeof publishedAt === 'number') {
        // Unix timestamp (seconds or milliseconds)
        pubDate = new Date(publishedAt < 1e12 ? publishedAt * 1000 : publishedAt);
    } else {
        pubDate = new Date(publishedAt);
    }

    if (isNaN(pubDate.getTime())) return undefined;

    const now = new Date();
    const diffMs = now.getTime() - pubDate.getTime();
    return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
}

/**
 * 计算爆款评分
 */
export function calculateViralScore(
    input: ViralInput,
    thresholds: ViralThresholds = DEFAULT_VIRAL_THRESHOLDS
): ViralResult {
    const { likes, shares, comments, followers, publishedAt } = input;
    const { minLikes, minShares, minComments, referenceFollowers, referenceDays } = thresholds;

    // ── 1. 各维度归一化得分 ──
    const likesScore = minLikes > 0 ? likes / minLikes : 0;
    const sharesScore = minShares > 0 ? shares / minShares : 0;
    const commentsScore = minComments > 0 ? comments / minComments : 0;

    // 加权原始得分
    const rawScore = likesScore * W_LIKES + sharesScore * W_SHARES + commentsScore * W_COMMENTS;

    // ── 2. 粉丝倍率 ──
    let followerMultiplier = 1.0;
    let engagementRate: number | undefined;

    if (followers > 0) {
        // 互动率
        const totalEngagement = likes + shares * 3 + comments * 2;
        engagementRate = totalEngagement / followers;

        // 粉丝倍率: 小号高互动 → 大倍率加分
        followerMultiplier = Math.min(Math.max(referenceFollowers / followers, 0.1), 5.0);
    }
    // 如果 followers=0（未知），followerMultiplier 保持 1.0（不修正）

    // ── 3. 时间倍率 ──
    let timeMultiplier = 1.0;
    const daysSincePublish = getDaysSincePublish(publishedAt);

    if (daysSincePublish !== undefined && daysSincePublish > 0) {
        // 参考天数内的内容为基准(1.0)，更新的加分，更老的减分
        timeMultiplier = Math.min(Math.max(referenceDays / daysSincePublish, 0.1), 5.0);
    }

    // ── 4. 综合得分 ──
    const finalScore = rawScore * followerMultiplier * timeMultiplier;

    // ── 5. 确定等级 ──
    let level: ViralResult['level'];
    if (finalScore >= 3.0) {
        level = 'viral';    // 🔥🔥 超级爆款
    } else if (finalScore >= 1.0) {
        level = 'hot';      // 🔥 爆款
    } else if (finalScore >= 0.5) {
        level = 'warm';     // 📈 小热门
    } else {
        level = 'normal';   // 普通
    }

    return {
        score: Math.round(finalScore * 100) / 100,
        isViral: finalScore >= 1.0,
        engagementRate: engagementRate !== undefined ? Math.round(engagementRate * 10000) / 10000 : undefined,
        followerMultiplier: Math.round(followerMultiplier * 100) / 100,
        timeMultiplier: Math.round(timeMultiplier * 100) / 100,
        daysSincePublish: daysSincePublish !== undefined ? Math.round(daysSincePublish) : undefined,
        level,
    };
}

/**
 * 获取等级对应的显示标签
 */
export function getViralLevelLabel(level: ViralResult['level']): string {
    switch (level) {
        case 'viral': return '🔥🔥 超级爆款';
        case 'hot': return '🔥 爆款';
        case 'warm': return '📈 小热门';
        case 'normal': return '';
    }
}

/**
 * 获取等级对应的颜色
 */
export function getViralLevelColor(level: ViralResult['level']): string {
    switch (level) {
        case 'viral': return '#ff2442';
        case 'hot': return '#ff6b35';
        case 'warm': return '#f59e0b';
        case 'normal': return '#64748b';
    }
}
