# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Job API Schemas according to API.md specification
"""
from datetime import datetime
from enum import Enum
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field


class PlatformEnum(str, Enum):
    """Supported platforms"""
    DOUYIN = "douyin"
    XIAOHONGSHU = "xiaohongshu"
    KUAISHOU = "kuaishou"
    BILIBILI = "bilibili"
    WEIBO = "weibo"
    ZHIHU = "zhihu"
    TIEBA = "tieba"


class CrawlModeEnum(str, Enum):
    """Crawl modes"""
    KEYWORD = "keyword"
    CREATOR = "creator"
    DETAIL = "detail"


class JobStatusEnum(str, Enum):
    """Job status"""
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"


class TimeRange(BaseModel):
    """Time range filter"""
    from_time: datetime = Field(..., alias="from")
    to_time: datetime = Field(..., alias="to")

    class Config:
        populate_by_name = True


class CrawlPayload(BaseModel):
    """Crawl job payload"""
    platform: PlatformEnum
    mode: CrawlModeEnum
    
    # mode=keyword 时必填
    keyword: Optional[str] = None
    
    # mode=creator 时必填
    creator_id: Optional[str] = None
    creator_url: Optional[str] = None
    
    # mode=detail 时必填
    content_ids: Optional[List[str]] = None
    content_urls: Optional[List[str]] = None
    
    # 通用可选参数
    limit: int = Field(default=50, ge=1, le=200)
    time_range: Optional[TimeRange] = None
    enable_comments: bool = True
    enable_media: bool = False

    def model_validate_payload(self):
        """Validate payload based on mode"""
        if self.mode == CrawlModeEnum.KEYWORD:
            if not self.keyword:
                raise ValueError("keyword is required when mode=keyword")
        elif self.mode == CrawlModeEnum.CREATOR:
            if not self.creator_id:
                raise ValueError("creator_id is required when mode=creator")
        elif self.mode == CrawlModeEnum.DETAIL:
            if not self.content_ids:
                raise ValueError("content_ids is required when mode=detail")
        return True


class CreateJobRequest(BaseModel):
    """Create job request"""
    job_type: Literal["crawl"] = "crawl"
    idempotency_key: Optional[str] = None
    payload: CrawlPayload


class CreateJobResponse(BaseModel):
    """Create job response"""
    job_id: str
    status: JobStatusEnum
    created_at: datetime


class JobProgress(BaseModel):
    """Job progress"""
    total: int = 0
    completed: int = 0
    failed: int = 0


class GetJobStatusResponse(BaseModel):
    """Get job status response"""
    job_id: str
    job_type: str
    status: JobStatusEnum
    progress: Optional[JobProgress] = None
    error: Optional[str] = None
    created_at: datetime
    started_at: Optional[datetime] = None
    updated_at: datetime


class AuthorInfo(BaseModel):
    """Author information"""
    author_id: Optional[str] = None
    name: Optional[str] = None
    profile_url: Optional[str] = None


class Metrics(BaseModel):
    """Content metrics"""
    views: Optional[int] = None
    likes: Optional[int] = None
    comments: Optional[int] = None
    shares: Optional[int] = None
    favorites: Optional[int] = None


class MediaInfo(BaseModel):
    """Media asset references"""
    video_uri: Optional[str] = None
    cover_uri: Optional[str] = None


class ContentItem(BaseModel):
    """Content item schema"""
    schema_version: Literal["v1.0"] = "v1.0"
    content_id: str = Field(..., description="Format: {platform}_{platform_id}")
    platform: PlatformEnum
    source_url: str
    author: Optional[AuthorInfo] = None
    title: str
    publish_time: datetime
    metrics: Optional[Metrics] = None
    raw_payload_ref: Optional[str] = None
    media: Optional[MediaInfo] = None
    tags: Optional[List[str]] = None


class JobOutput(BaseModel):
    """Job output"""
    platform: str
    mode: str
    keyword: Optional[str] = None
    total_count: int
    content_items: List[ContentItem]


class ArtifactMeta(BaseModel):
    """Artifact metadata"""
    file_size: Optional[int] = None
    mime_type: Optional[str] = None


class Artifact(BaseModel):
    """Artifact reference"""
    type: str
    uri: str
    meta: Optional[ArtifactMeta] = None


class GetJobResultResponse(BaseModel):
    """Get job result response"""
    job_id: str
    output: Optional[JobOutput] = None
    artifacts: Optional[List[Artifact]] = None


class ErrorDetail(BaseModel):
    """Error detail"""
    code: str
    message: str
    retryable: bool
    details: Optional[Dict[str, Any]] = None


class ErrorResponse(BaseModel):
    """Error response"""
    error: ErrorDetail
    request_id: Optional[str] = None
