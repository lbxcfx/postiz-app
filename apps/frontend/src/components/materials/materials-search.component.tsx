
"use client";

import { useState } from "react";
import { Button } from "@gitroom/react/form/button";
import { Input } from "@gitroom/react/form/input";
import { Select } from "@gitroom/react/form/select";

export interface MaterialsSearchProps {
    onSearch: (params: {
        platform: string;
        keywords: string;
        limit: number;
        incremental: boolean;
    }) => void;
    isLoading?: boolean;
}

export const MaterialsSearch = (props: MaterialsSearchProps) => {
    const [platform, setPlatform] = useState<string>("xhs");
    const [keywords, setKeywords] = useState<string>("");
    const [limit, setLimit] = useState<number>(1);
    const [incremental, setIncremental] = useState<boolean>(false);

    const handleSearch = () => {
        if (!keywords.trim()) return;
        props.onSearch({ platform, keywords, limit, incremental });
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-[150px_100px_minmax(220px,1fr)_180px_110px] gap-4 items-end bg-sixth p-4 rounded-lg border border-fifth">
            <div className="w-[150px]">
                <Select
                    label="平台"
                    name="platform"
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value)}
                    disableForm={true}
                    hideErrors={true}
                >
                    <option value="xhs">小红书</option>
                    <option value="dy">抖音</option>
                    <option value="bili">B站</option>
                    <option value="wb">微博</option>
                </Select>
            </div>
            <div className="w-[100px]">
                <Select
                    label="搜索页数"
                    name="limit"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    disableForm={true}
                    hideErrors={true}
                >
                    <option value="1">1页</option>
                    <option value="2">2页</option>
                    <option value="3">3页</option>
                    <option value="5">5页</option>
                    <option value="10">10页</option>
                </Select>
            </div>
            <div className="flex-1 min-w-[220px]">
                <Input
                    name="keywords"
                    label="关键词"
                    placeholder="输入关键词搜索爆款内容..."
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            handleSearch();
                        }
                    }}
                    disableForm={true}
                    removeError={true}
                />
            </div>
            <label className="flex h-[42px] items-center gap-2 rounded-md border border-fifth px-3 text-xs text-gray-300">
                <input
                    type="checkbox"
                    checked={incremental}
                    onChange={(e) => setIncremental(e.target.checked)}
                    className="h-4 w-4"
                />
                <span>增量爬取并合并历史</span>
            </label>
            <div className="flex items-end">
                <Button
                    className="!h-[42px] w-full"
                    onClick={handleSearch}
                    loading={props.isLoading}
                >
                    {props.isLoading ? "搜索中..." : "搜索"}
                </Button>
            </div>
        </div>
    );
};
