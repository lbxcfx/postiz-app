# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Data converter: Convert platform-specific data to unified ContentItem format
"""
from datetime import datetime
from typing import Dict, Any, Optional
from ..schemas.job import ContentItem, AuthorInfo, Metrics, MediaInfo, PlatformEnum


class DataConverter:
    """Convert platform-specific data models to ContentItem"""
    
    @staticmethod
    def convert_douyin(item: Dict[str, Any]) -> ContentItem:
        """Convert Douyin data to ContentItem"""
        aweme_id = str(item.get("aweme_id", ""))
        return ContentItem(
            content_id=f"douyin_{aweme_id}",
            platform=PlatformEnum.DOUYIN,
            source_url=item.get("aweme_url", ""),
            author=AuthorInfo(
                author_id=item.get("user_id"),
                name=item.get("nickname"),
                profile_url=f"https://www.douyin.com/user/{item.get('sec_uid', '')}" if item.get("sec_uid") else None
            ),
            title=item.get("title") or item.get("desc", ""),
            publish_time=datetime.fromtimestamp(int(item.get("create_time", 0))) if item.get("create_time") else datetime.utcnow(),
            metrics=Metrics(
                views=None,  # Douyin doesn't expose views in this data
                likes=int(item.get("liked_count", 0)) if item.get("liked_count") else None,
                comments=int(item.get("comment_count", 0)) if item.get("comment_count") else None,
                shares=int(item.get("share_count", 0)) if item.get("share_count") else None,
                favorites=int(item.get("collected_count", 0)) if item.get("collected_count") else None
            ),
            media=MediaInfo(
                video_uri=item.get("video_download_url"),
                cover_uri=item.get("cover_url")
            ),
            tags=None
        )
    
    @staticmethod
    def convert_xiaohongshu(item: Dict[str, Any]) -> ContentItem:
        """Convert Xiaohongshu data to ContentItem"""
        note_id = str(item.get("note_id", ""))
        return ContentItem(
            content_id=f"xiaohongshu_{note_id}",
            platform=PlatformEnum.XIAOHONGSHU,
            source_url=item.get("note_url", ""),
            author=AuthorInfo(
                author_id=item.get("user_id"),
                name=item.get("nickname"),
                profile_url=None
            ),
            title=item.get("title", ""),
            publish_time=datetime.fromtimestamp(int(item.get("time", 0))) if item.get("time") else datetime.utcnow(),
            metrics=Metrics(
                views=None,
                likes=int(item.get("liked_count", 0)) if item.get("liked_count") else None,
                comments=int(item.get("comment_count", 0)) if item.get("comment_count") else None,
                shares=int(item.get("share_count", 0)) if item.get("share_count") else None,
                favorites=int(item.get("collected_count", 0)) if item.get("collected_count") else None
            ),
            media=MediaInfo(
                video_uri=item.get("video_url"),
                cover_uri=None
            ),
            tags=item.get("tag_list") if isinstance(item.get("tag_list"), list) else None
        )
    
    @staticmethod
    def convert_kuaishou(item: Dict[str, Any]) -> ContentItem:
        """Convert Kuaishou data to ContentItem"""
        video_id = str(item.get("video_id", ""))
        return ContentItem(
            content_id=f"kuaishou_{video_id}",
            platform=PlatformEnum.KUAISHOU,
            source_url=item.get("video_url", ""),
            author=AuthorInfo(
                author_id=item.get("user_id"),
                name=item.get("nickname"),
                profile_url=None
            ),
            title=item.get("title") or item.get("desc", ""),
            publish_time=datetime.fromtimestamp(int(item.get("create_time", 0))) if item.get("create_time") else datetime.utcnow(),
            metrics=Metrics(
                views=int(item.get("viewd_count", 0)) if item.get("viewd_count") else None,
                likes=int(item.get("liked_count", 0)) if item.get("liked_count") else None,
                comments=None,
                shares=None,
                favorites=None
            ),
            media=MediaInfo(
                video_uri=item.get("video_play_url"),
                cover_uri=item.get("video_cover_url")
            ),
            tags=None
        )
    
    @staticmethod
    def convert_bilibili(item: Dict[str, Any]) -> ContentItem:
        """Convert Bilibili data to ContentItem"""
        video_id = str(item.get("video_id", ""))
        return ContentItem(
            content_id=f"bilibili_{video_id}",
            platform=PlatformEnum.BILIBILI,
            source_url=item.get("video_url", ""),
            author=AuthorInfo(
                author_id=str(item.get("user_id", "")),
                name=item.get("nickname"),
                profile_url=f"https://space.bilibili.com/{item.get('user_id', '')}" if item.get("user_id") else None
            ),
            title=item.get("title", ""),
            publish_time=datetime.fromtimestamp(int(item.get("create_time", 0))) if item.get("create_time") else datetime.utcnow(),
            metrics=Metrics(
                views=int(item.get("video_play_count", 0)) if item.get("video_play_count") else None,
                likes=int(item.get("liked_count", 0)) if item.get("liked_count") else None,
                comments=int(item.get("video_comment", 0)) if item.get("video_comment") else None,
                shares=int(item.get("video_share_count", 0)) if item.get("video_share_count") else None,
                favorites=int(item.get("video_favorite_count", 0)) if item.get("video_favorite_count") else None
            ),
            media=MediaInfo(
                video_uri=None,
                cover_uri=item.get("video_cover_url")
            ),
            tags=None
        )
    
    @staticmethod
    def convert_weibo(item: Dict[str, Any]) -> ContentItem:
        """Convert Weibo data to ContentItem"""
        note_id = str(item.get("note_id", ""))
        return ContentItem(
            content_id=f"weibo_{note_id}",
            platform=PlatformEnum.WEIBO,
            source_url=item.get("note_url", ""),
            author=AuthorInfo(
                author_id=item.get("user_id"),
                name=item.get("nickname"),
                profile_url=item.get("profile_url")
            ),
            title=item.get("content", "")[:100],  # Use content as title
            publish_time=datetime.fromtimestamp(int(item.get("create_time", 0))) if item.get("create_time") else datetime.utcnow(),
            metrics=Metrics(
                views=None,
                likes=int(item.get("liked_count", 0)) if item.get("liked_count") else None,
                comments=int(item.get("comments_count", 0)) if item.get("comments_count") else None,
                shares=int(item.get("shared_count", 0)) if item.get("shared_count") else None,
                favorites=None
            ),
            media=None,
            tags=None
        )
    
    @staticmethod
    def convert_zhihu(item: Dict[str, Any]) -> ContentItem:
        """Convert Zhihu data to ContentItem"""
        content_id = str(item.get("content_id", ""))
        return ContentItem(
            content_id=f"zhihu_{content_id}",
            platform=PlatformEnum.ZHIHU,
            source_url=item.get("content_url", ""),
            author=AuthorInfo(
                author_id=item.get("user_id"),
                name=item.get("user_nickname"),
                profile_url=item.get("user_link")
            ),
            title=item.get("title", ""),
            publish_time=datetime.fromisoformat(item.get("created_time", datetime.utcnow().isoformat()).replace("Z", "+00:00")) if isinstance(item.get("created_time"), str) else datetime.utcnow(),
            metrics=Metrics(
                views=None,
                likes=int(item.get("voteup_count", 0)) if item.get("voteup_count") else None,
                comments=int(item.get("comment_count", 0)) if item.get("comment_count") else None,
                shares=None,
                favorites=None
            ),
            media=None,
            tags=None
        )
    
    @staticmethod
    def convert_tieba(item: Dict[str, Any]) -> ContentItem:
        """Convert Baidu Tieba data to ContentItem"""
        note_id = str(item.get("note_id", ""))
        return ContentItem(
            content_id=f"tieba_{note_id}",
            platform=PlatformEnum.TIEBA,
            source_url=item.get("note_url", ""),
            author=AuthorInfo(
                author_id=None,
                name=item.get("user_nickname"),
                profile_url=item.get("user_link")
            ),
            title=item.get("title", ""),
            publish_time=datetime.fromisoformat(item.get("publish_time", datetime.utcnow().isoformat())) if isinstance(item.get("publish_time"), str) else datetime.utcnow(),
            metrics=Metrics(
                views=None,
                likes=None,
                comments=int(item.get("total_replay_num", 0)) if item.get("total_replay_num") else None,
                shares=None,
                favorites=None
            ),
            media=None,
            tags=None
        )
    
    @classmethod
    def convert(cls, platform: PlatformEnum, item: Dict[str, Any]) -> ContentItem:
        """Convert platform-specific item to ContentItem"""
        converter_map = {
            PlatformEnum.DOUYIN: cls.convert_douyin,
            PlatformEnum.XIAOHONGSHU: cls.convert_xiaohongshu,
            PlatformEnum.KUAISHOU: cls.convert_kuaishou,
            PlatformEnum.BILIBILI: cls.convert_bilibili,
            PlatformEnum.WEIBO: cls.convert_weibo,
            PlatformEnum.ZHIHU: cls.convert_zhihu,
            PlatformEnum.TIEBA: cls.convert_tieba,
        }
        
        converter = converter_map.get(platform)
        if not converter:
            raise ValueError(f"Unsupported platform: {platform}")
        
        return converter(item)
