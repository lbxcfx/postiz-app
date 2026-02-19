# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Crawl executor: Execute crawler tasks and collect results
"""
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Dict, Any, List, Callable, Optional
import importlib.util

from ..schemas.job import CrawlPayload, PlatformEnum, CrawlModeEnum
from .data_converter import DataConverter


class CrawlResultCollector:
    """Collect crawl results during execution"""
    
    def __init__(self, platform: PlatformEnum, progress_callback: Optional[Callable] = None, item_callback: Optional[Callable] = None):
        self.platform = platform
        self.items: List[Dict[str, Any]] = []
        self.progress_callback = progress_callback
        self.item_callback = item_callback
        self.total = 0
        self.completed = 0
        self.failed = 0
    
    def add_item(self, item: Dict[str, Any]):
        """Add a content item"""
        self.items.append(item)
        self.completed += 1
        if self.item_callback:
            # Convert to ContentItem format
            try:
                content_item = DataConverter.convert(self.platform, item)
                self.item_callback(content_item.model_dump())
            except Exception as e:
                print(f"[CrawlResultCollector] Error converting item: {e}")
        
        if self.progress_callback:
            self.progress_callback({
                "total": self.total,
                "completed": self.completed,
                "failed": self.failed
            })
    
    def update_progress(self, total: int, completed: int, failed: int = 0):
        """Update progress"""
        self.total = total
        self.completed = completed
        self.failed = failed
        if self.progress_callback:
            self.progress_callback({
                "total": total,
                "completed": completed,
                "failed": failed
            })


class CrawlExecutor:
    """Execute crawl jobs"""
    
    def __init__(self):
        self.project_root = Path(__file__).parent.parent.parent.parent
    
    async def execute(
        self,
        job_id: str,
        payload: CrawlPayload,
        progress_callback: Optional[Callable] = None,
        item_callback: Optional[Callable] = None
    ) -> Dict[str, Any]:
        """Execute crawl job"""
        try:
            # Map API platform names to internal platform names
            platform_map = {
                PlatformEnum.DOUYIN: "dy",
                PlatformEnum.XIAOHONGSHU: "xhs",
                PlatformEnum.KUAISHOU: "ks",
                PlatformEnum.BILIBILI: "bili",
                PlatformEnum.WEIBO: "wb",
                PlatformEnum.ZHIHU: "zhihu",
                PlatformEnum.TIEBA: "tieba",
            }
            
            internal_platform = platform_map[payload.platform]
            
            # Create result collector
            collector = CrawlResultCollector(
                platform=payload.platform,
                progress_callback=progress_callback,
                item_callback=item_callback
            )
            
            # Temporarily patch config and store to collect results
            import config
            original_platform = config.PLATFORM
            original_crawler_type = config.CRAWLER_TYPE
            original_keywords = config.KEYWORDS
            original_specified_ids = config.DY_SPECIFIED_ID_LIST if internal_platform == "dy" else getattr(config, f"{internal_platform.upper()}_SPECIFIED_NOTE_URL_LIST", [])
            original_creator_ids = getattr(config, f"{internal_platform.upper()}_CREATOR_ID_LIST", [])
            original_save_option = config.SAVE_DATA_OPTION
            original_enable_comments = config.ENABLE_GET_COMMENTS
            
            # Update config
            config.PLATFORM = internal_platform
            config.SAVE_DATA_OPTION = "json"  # Use JSON to collect results
            config.ENABLE_GET_COMMENTS = payload.enable_comments
            
            # Set mode-specific config
            if payload.mode == CrawlModeEnum.KEYWORD:
                config.CRAWLER_TYPE = "search"
                config.KEYWORDS = payload.keyword
            elif payload.mode == CrawlModeEnum.CREATOR:
                config.CRAWLER_TYPE = "creator"
                creator_id_value = payload.creator_url or payload.creator_id
                if internal_platform == "xhs":
                    import config.xhs_config as xhs_config
                    xhs_config.XHS_CREATOR_ID_LIST = [creator_id_value]
                elif internal_platform == "dy":
                    import config.dy_config as dy_config
                    dy_config.DY_CREATOR_ID_LIST = [creator_id_value]
                elif internal_platform == "ks":
                    import config.ks_config as ks_config
                    ks_config.KS_CREATOR_ID_LIST = [creator_id_value]
                elif internal_platform == "wb":
                    import config.weibo_config as wb_config
                    wb_config.WEIBO_CREATOR_ID_LIST = [creator_id_value]
                elif internal_platform == "tieba":
                    import config.tieba_config as tieba_config
                    tieba_config.TIEBA_CREATOR_URL_LIST = [creator_id_value]
                elif internal_platform == "zhihu":
                    import config.zhihu_config as zhihu_config
                    zhihu_config.ZHIHU_CREATOR_ID_LIST = [creator_id_value]
            elif payload.mode == CrawlModeEnum.DETAIL:
                config.CRAWLER_TYPE = "detail"
                content_ids_value = payload.content_urls or payload.content_ids
                if internal_platform == "xhs":
                    import config.xhs_config as xhs_config
                    xhs_config.XHS_SPECIFIED_NOTE_URL_LIST = content_ids_value
                elif internal_platform == "dy":
                    import config.dy_config as dy_config
                    dy_config.DY_SPECIFIED_ID_LIST = content_ids_value
                elif internal_platform == "ks":
                    import config.ks_config as ks_config
                    ks_config.KS_SPECIFIED_ID_LIST = content_ids_value
                elif internal_platform == "bili":
                    import config.bilibili_config as bili_config
                    bili_config.BILI_SPECIFIED_ID_LIST = content_ids_value
                elif internal_platform == "wb":
                    import config.weibo_config as wb_config
                    wb_config.WEIBO_SPECIFIED_ID_LIST = content_ids_value
                elif internal_platform == "tieba":
                    import config.tieba_config as tieba_config
                    tieba_config.TIEBA_SPECIFIED_ID_LIST = content_ids_value
                elif internal_platform == "zhihu":
                    import config.zhihu_config as zhihu_config
                    zhihu_config.ZHIHU_SPECIFIED_ID_LIST = content_ids_value
            
            # Limit items
            config.START_PAGE = 1
            # Note: limit is handled by crawler's pagination
            
            try:
                # Import and create crawler
                from main import CrawlerFactory
                crawler = CrawlerFactory.create_crawler(platform=internal_platform)
                
                # Create custom store to collect results
                from base.base_crawler import AbstractStore
                
                class CollectingStore(AbstractStore):
                    def __init__(self, collector):
                        self.collector = collector
                    
                    async def store_content(self, content_item: Dict):
                        self.collector.add_item(content_item)
                
                # Replace crawler's store
                collecting_store = CollectingStore(collector)
                crawler.store = collecting_store
                
                # Execute crawler
                await crawler.start()
                
                # Wait for cleanup
                if hasattr(crawler, 'browser_context') and crawler.browser_context:
                    await crawler.browser_context.close()
                
                # Collect results from JSON files if needed
                await self._collect_from_json_files(collector, internal_platform, payload)
                
                return {
                    "success": True,
                    "artifacts": []
                }
            
            finally:
                # Restore original config
                config.PLATFORM = original_platform
                config.CRAWLER_TYPE = original_crawler_type
                config.KEYWORDS = original_keywords
                config.SAVE_DATA_OPTION = original_save_option
                config.ENABLE_GET_COMMENTS = original_enable_comments
        
        except Exception as e:
            import traceback
            error_msg = str(e)
            traceback.print_exc()
            return {
                "success": False,
                "error": error_msg,
                "artifacts": []
            }
    
    async def _collect_from_json_files(self, collector: CrawlResultCollector, platform: str, payload: CrawlPayload):
        """Collect results from JSON files if store didn't capture everything"""
        try:
            data_dir = self.project_root / "data"
            if not data_dir.exists():
                return
            
            # Find latest JSON file for this platform
            json_files = list(data_dir.glob(f"**/*{platform}*.json"))
            if not json_files:
                return
            
            # Get the most recent file
            latest_file = max(json_files, key=lambda p: p.stat().st_mtime)
            
            with open(latest_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            if isinstance(data, list):
                # Limit to requested count
                items = data[:payload.limit]
                collector.total = len(data)
                
                for item in items:
                    collector.add_item(item)
        
        except Exception as e:
            print(f"[CrawlExecutor] Error collecting from JSON files: {e}")
