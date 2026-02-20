
"use client";

import { useVariables } from "@gitroom/react/helpers/variable.context";
import { ViralResult, getViralLevelLabel, getViralLevelColor } from "./viral-score";

export interface MaterialItem {
    id: string;
    platform: string;
    externalId: string;
    title?: string;
    desc?: string;
    coverUrl?: string;
    contentUrl?: string;
    authorName?: string;
    authorAvatar?: string;
    authorUserId?: string;
    createdAt: string;
    /** 互动数据 */
    likedCount?: number;
    collectedCount?: number;
    commentCount?: number;
    shareCount?: number;
    /** 作者粉丝数 (二次爬取获取) */
    followerCount?: number;
    /** 爆款评分结果 (前端计算后附加) */
    viralResult?: ViralResult;
}

/**
 * Check if a URL needs to be proxied (e.g., Xiaohongshu CDN with anti-hotlinking)
 */
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
        return proxyDomains.some(domain => parsed.hostname.includes(domain));
    } catch {
        return false;
    }
};

/**
 * Get the proxied URL for images that need anti-hotlinking bypass
 */
const getProxiedUrl = (url: string, platform: string, backendUrl: string): string => {
    if (!url || !needsProxy(url)) return url;
    const encodedUrl = encodeURIComponent(url);
    if (!backendUrl) return url;
    return `${backendUrl}/materials/image-proxy?url=${encodedUrl}&platform=${platform}`;
};

const isLikelyVideoUrl = (url?: string): boolean => {
    if (!url) return false;
    return /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url);
};

/**
 * 格式化数字: 1000 -> 1k, 10000 -> 1w
 */
const formatCount = (count?: number): string => {
    if (count === undefined || count === null) return '-';
    if (count >= 10000) return (count / 10000).toFixed(1) + 'w';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return String(count);
};

export const MaterialsResults = ({ items }: { items: MaterialItem[] }) => {
    const { backendUrl } = useVariables();

    if (!items || items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                <svg className="w-16 h-16 mb-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <p className="text-sm">输入关键词搜索爆款内容</p>
            </div>
        );
    }

    return (
        <div className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-3 mt-2">
            {items.map((item) => {
                const displayCoverUrl = item.coverUrl
                    ? getProxiedUrl(item.coverUrl, item.platform, backendUrl)
                    : undefined;
                const fallbackCoverUrl = item.coverUrl;
                const displayVideoUrl = isLikelyVideoUrl(item.contentUrl)
                    ? getProxiedUrl(item.contentUrl!, item.platform, backendUrl)
                    : undefined;

                const viralLevel = item.viralResult?.level;
                const viralLabel = item.viralResult ? getViralLevelLabel(item.viralResult.level) : '';
                const viralColor = item.viralResult ? getViralLevelColor(item.viralResult.level) : '';
                const isViral = item.viralResult?.isViral;

                // XHS note URL
                const noteUrl = item.platform === 'xhs'
                    ? `https://www.xiaohongshu.com/explore/${item.externalId}`
                    : item.contentUrl;

                return (
                    <div
                        key={item.id}
                        className="break-inside-avoid mb-3 group cursor-pointer"
                        onClick={() => noteUrl && window.open(noteUrl, '_blank')}
                    >
                        <div
                            className={`bg-sixth rounded-xl overflow-hidden transition-all duration-200 hover:shadow-lg hover:shadow-black/20 hover:-translate-y-0.5 ${isViral ? 'ring-1 ring-red-500/30' : 'border border-fifth/50'
                                }`}
                        >
                            {/* Cover Image */}
                            <div className="relative w-full bg-gray-800">
                                {displayCoverUrl ? (
                                    <img
                                        src={displayCoverUrl}
                                        alt={item.title || ""}
                                        className="w-full object-cover"
                                        style={{ minHeight: '120px', maxHeight: '300px' }}
                                        loading="lazy"
                                        onError={(e) => {
                                            const target = e.target as HTMLImageElement;
                                            if (
                                                fallbackCoverUrl &&
                                                target.dataset.fallbackApplied !== '1' &&
                                                target.src !== fallbackCoverUrl
                                            ) {
                                                target.dataset.fallbackApplied = '1';
                                                target.src = fallbackCoverUrl;
                                                return;
                                            }
                                            target.style.display = 'none';
                                            const parent = target.parentElement;
                                            if (parent) {
                                                parent.innerHTML = '';
                                                if (displayVideoUrl) {
                                                    const video = document.createElement('video');
                                                    video.src = displayVideoUrl;
                                                    video.controls = true;
                                                    video.muted = true;
                                                    video.playsInline = true;
                                                    video.preload = 'metadata';
                                                    video.className = 'w-full object-cover';
                                                    video.style.minHeight = '120px';
                                                    video.style.maxHeight = '300px';
                                                    parent.appendChild(video);
                                                    return;
                                                }
                                                parent.innerHTML = `<div class="w-full flex items-center justify-center text-gray-500 text-xs" style="height:160px">图片加载失败</div>`;
                                            }
                                        }}
                                    />
                                ) : displayVideoUrl ? (
                                    <video
                                        src={displayVideoUrl}
                                        className="w-full object-cover"
                                        style={{ minHeight: '120px', maxHeight: '300px' }}
                                        controls
                                        muted
                                        playsInline
                                        preload="metadata"
                                    />
                                ) : (
                                    <div className="w-full flex items-center justify-center text-gray-500 text-xs" style={{ height: '160px' }}>
                                        暂无封面
                                    </div>
                                )}

                                {/* Viral Badge */}
                                {viralLabel && (
                                    <div
                                        className="absolute top-2 left-2 px-2 py-0.5 rounded-full text-white text-[10px] font-bold shadow-lg backdrop-blur-sm"
                                        style={{ backgroundColor: viralColor + 'dd' }}
                                    >
                                        {viralLabel}
                                    </div>
                                )}

                                {/* Score Badge */}
                                {item.viralResult && item.viralResult.score > 0 && (
                                    <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm px-1.5 py-0.5 rounded text-[10px] text-white font-mono">
                                        {item.viralResult.score.toFixed(1)}
                                    </div>
                                )}
                            </div>

                            {/* Content */}
                            <div className="p-3">
                                {/* Title */}
                                <h3 className="text-[13px] font-medium text-white leading-snug line-clamp-2 mb-2">
                                    {item.title || item.desc?.slice(0, 40) || '无标题'}
                                </h3>

                                {/* Author Row */}
                                <div className="flex items-center gap-1.5 mb-1">
                                    {item.authorAvatar ? (
                                        <img
                                            src={getProxiedUrl(item.authorAvatar, item.platform, backendUrl)}
                                            alt=""
                                            className="w-4 h-4 rounded-full object-cover"
                                            loading="lazy"
                                            onError={(e) => {
                                                const target = e.target as HTMLImageElement;
                                                if (
                                                    target.dataset.fallbackApplied !== '1' &&
                                                    target.src !== item.authorAvatar
                                                ) {
                                                    target.dataset.fallbackApplied = '1';
                                                    target.src = item.authorAvatar!;
                                                    return;
                                                }
                                                target.style.display = 'none';
                                            }}
                                        />
                                    ) : (
                                        <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center text-[8px] text-gray-400">
                                            {(item.authorName || '?')[0]}
                                        </div>
                                    )}
                                    <span className="text-[11px] text-gray-400 truncate max-w-[80px]">
                                        {item.authorName || '未知'}
                                    </span>
                                    {item.followerCount !== undefined && item.followerCount > 0 && (
                                        <span className="text-[10px] text-gray-500 bg-gray-800 px-1 py-0.5 rounded" title="粉丝数">
                                            {formatCount(item.followerCount)}粉
                                        </span>
                                    )}
                                </div>

                                {/* Time + Score Meta Row */}
                                <div className="flex items-center gap-2 mb-2 text-[10px] text-gray-500">
                                    {item.viralResult?.daysSincePublish !== undefined && (
                                        <span title="发布距今天数">
                                            {item.viralResult.daysSincePublish <= 1
                                                ? '🆕 今天'
                                                : item.viralResult.daysSincePublish <= 7
                                                    ? `⚡ ${item.viralResult.daysSincePublish}天前`
                                                    : item.viralResult.daysSincePublish <= 30
                                                        ? `📅 ${item.viralResult.daysSincePublish}天前`
                                                        : `🕰️ ${Math.round(item.viralResult.daysSincePublish / 30)}月前`
                                            }
                                        </span>
                                    )}
                                    {item.viralResult && item.viralResult.followerMultiplier !== 1.0 && item.followerCount && item.followerCount > 0 && (
                                        <span className={`${item.viralResult.followerMultiplier > 1 ? 'text-green-500' : 'text-orange-400'}`}
                                            title={`粉丝倍率: ${item.viralResult.followerMultiplier}x`}>
                                            {item.viralResult.followerMultiplier > 1 ? '↑' : '↓'}{item.viralResult.followerMultiplier}x
                                        </span>
                                    )}
                                    {item.viralResult && item.viralResult.timeMultiplier !== 1.0 && (
                                        <span className={`${item.viralResult.timeMultiplier > 1 ? 'text-blue-400' : 'text-gray-600'}`}
                                            title={`时间倍率: ${item.viralResult.timeMultiplier}x`}>
                                            {item.viralResult.timeMultiplier > 1 ? '⏫' : '⏬'}{item.viralResult.timeMultiplier}x
                                        </span>
                                    )}
                                </div>

                                {/* Engagement Stats Row - XHS Style */}
                                <div className="flex items-center justify-between text-[11px] text-gray-500">
                                    <div className="flex items-center gap-3">
                                        {/* Likes */}
                                        <span className="flex items-center gap-0.5" title="点赞">
                                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                                                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                                            </svg>
                                            <span className={item.likedCount && item.likedCount >= 1000 ? 'text-red-400 font-medium' : ''}>
                                                {formatCount(item.likedCount)}
                                            </span>
                                        </span>
                                        {/* Collects */}
                                        <span className="flex items-center gap-0.5" title="收藏">
                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                                            </svg>
                                            {formatCount(item.collectedCount)}
                                        </span>
                                        {/* Comments */}
                                        <span className="flex items-center gap-0.5" title="评论">
                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                                            </svg>
                                            {formatCount(item.commentCount)}
                                        </span>
                                    </div>
                                    {/* Share */}
                                    {item.shareCount !== undefined && item.shareCount > 0 && (
                                        <span className="flex items-center gap-0.5" title="转发">
                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                            </svg>
                                            {formatCount(item.shareCount)}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
