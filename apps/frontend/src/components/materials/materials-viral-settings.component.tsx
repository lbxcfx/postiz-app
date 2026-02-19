
"use client";

import { useState, useCallback } from "react";
import { ViralThresholds, DEFAULT_VIRAL_THRESHOLDS } from "./viral-score";

export interface ViralSettingsProps {
    thresholds: ViralThresholds;
    onChange: (thresholds: ViralThresholds) => void;
    onlyShowViral: boolean;
    onToggleOnlyViral: (value: boolean) => void;
}

export const MaterialsViralSettings = ({
    thresholds,
    onChange,
    onlyShowViral,
    onToggleOnlyViral,
}: ViralSettingsProps) => {
    const [isExpanded, setIsExpanded] = useState(false);

    const handleChange = useCallback(
        (field: keyof ViralThresholds, value: number) => {
            onChange({ ...thresholds, [field]: value });
        },
        [thresholds, onChange]
    );

    const handleReset = useCallback(() => {
        onChange({ ...DEFAULT_VIRAL_THRESHOLDS });
    }, [onChange]);

    return (
        <div className="bg-sixth border border-fifth rounded-lg overflow-hidden">
            {/* Header - Always Visible */}
            <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer select-none hover:bg-fifth/30 transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2">
                    <span className="text-base">🔥</span>
                    <span className="text-sm font-semibold text-white">爆款筛选设置</span>
                    <span className="text-[10px] text-gray-500 bg-black/30 px-1.5 py-0.5 rounded">
                        点赞≥{thresholds.minLikes} · 转发≥{thresholds.minShares} · 评论≥{thresholds.minComments}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    {/* Toggle: Only Viral */}
                    <label
                        className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <span>仅看爆款</span>
                        <div
                            className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${onlyShowViral ? "bg-red-500" : "bg-gray-600"
                                }`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleOnlyViral(!onlyShowViral);
                            }}
                        >
                            <div
                                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${onlyShowViral ? "translate-x-4" : "translate-x-0.5"
                                    }`}
                            />
                        </div>
                    </label>
                    {/* Expand Arrow */}
                    <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </div>

            {/* Expandable Settings Panel */}
            {isExpanded && (
                <div className="px-4 pb-4 pt-1 border-t border-fifth/50">
                    {/* Row 1: Engagement Thresholds */}
                    <div className="grid grid-cols-3 gap-3 mt-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-gray-400">最低点赞数</label>
                            <input
                                type="number"
                                min={0}
                                value={thresholds.minLikes}
                                onChange={(e) => handleChange("minLikes", Math.max(0, Number(e.target.value)))}
                                className="bg-black/30 border border-fifth rounded px-2 py-1.5 text-sm text-white focus:border-red-500 focus:outline-none transition-colors"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-gray-400">最低转发数</label>
                            <input
                                type="number"
                                min={0}
                                value={thresholds.minShares}
                                onChange={(e) => handleChange("minShares", Math.max(0, Number(e.target.value)))}
                                className="bg-black/30 border border-fifth rounded px-2 py-1.5 text-sm text-white focus:border-red-500 focus:outline-none transition-colors"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-gray-400">最低评论数</label>
                            <input
                                type="number"
                                min={0}
                                value={thresholds.minComments}
                                onChange={(e) => handleChange("minComments", Math.max(0, Number(e.target.value)))}
                                className="bg-black/30 border border-fifth rounded px-2 py-1.5 text-sm text-white focus:border-red-500 focus:outline-none transition-colors"
                            />
                        </div>
                    </div>

                    {/* Row 2: Follower & Time Reference */}
                    <div className="grid grid-cols-2 gap-3 mt-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-gray-400">
                                参考粉丝数
                                <span
                                    className="ml-1 text-gray-500 cursor-help"
                                    title="低于此粉丝数的作者获得更高爆款分加成。例如设为50000：2000粉作者有5倍加成，100万粉作者有0.05倍折扣。搜索完成后自动二次获取粉丝数。"
                                >
                                    ⓘ
                                </span>
                            </label>
                            <input
                                type="number"
                                min={100}
                                value={thresholds.referenceFollowers}
                                onChange={(e) => handleChange("referenceFollowers", Math.max(100, Number(e.target.value)))}
                                className="bg-black/30 border border-fifth rounded px-2 py-1.5 text-sm text-white focus:border-red-500 focus:outline-none transition-colors"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-gray-400">
                                参考天数
                                <span
                                    className="ml-1 text-gray-500 cursor-help"
                                    title="以此天数为基准线(1.0)。7天内发布的内容获得高达5倍加成，1年前发布的内容会被大幅减分(0.1倍)。"
                                >
                                    ⓘ
                                </span>
                            </label>
                            <input
                                type="number"
                                min={1}
                                value={thresholds.referenceDays}
                                onChange={(e) => handleChange("referenceDays", Math.max(1, Number(e.target.value)))}
                                className="bg-black/30 border border-fifth rounded px-2 py-1.5 text-sm text-white focus:border-red-500 focus:outline-none transition-colors"
                            />
                        </div>
                    </div>

                    {/* Reset + Algorithm Explanation */}
                    <div className="flex items-center justify-between mt-3">
                        <div className="text-[10px] text-gray-500">
                            粉丝数将在搜索完成后自动通过二次爬取作者主页获取
                        </div>
                        <button
                            onClick={handleReset}
                            className="text-xs text-gray-500 hover:text-white transition-colors px-2 py-1 rounded hover:bg-fifth/50"
                        >
                            恢复默认
                        </button>
                    </div>

                    {/* Algorithm Explanation */}
                    <div className="mt-3 p-2 bg-black/20 rounded text-xs text-gray-500 leading-relaxed">
                        <strong className="text-gray-400">评分算法：</strong>
                        得分 = (点赞/阈值×0.5 + 转发/阈值×0.3 + 评论/阈值×0.2)
                        × 粉丝倍率(参考粉丝÷实际粉丝, 0.1~5.0)
                        × 时间倍率(参考天数÷发布天数, 0.1~5.0)。
                        得分 ≥ 1.0 = 🔥爆款，≥ 3.0 = 🔥🔥超级爆款。
                    </div>
                </div>
            )}
        </div>
    );
};
