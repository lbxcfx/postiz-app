# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/store/xhs/_store_impl.py
# GitHub: https://github.com/NanmiCoder
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1
#
# 声明：本代码仅供学习 and 研究目的使用。使用者应遵守以下原则：
# 1. 不得用于任何商业用途。
# 2. 使用时应遵守目标平台的使用条款和robots.txt规则。
# 3. 不得进行大规模爬取或对平台造成运营干扰。
# 4. 应合理控制请求频率，避免给目标平台带来不必要的负担。
# 5. 不得用于任何非法或不当的用途。
#
# 详细许可条款请参阅项目根目录下的LICENSE文件。
# 使用本代码即表示您同意遵守上述原则和LICENSE中的所有条款。

# @Author  : persist1@126.com
# @Time    : 2025/9/5 19:34
# @Desc    : Xiaohongshu storage implementation class
import json
import os
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any

from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

import config
from base.base_crawler import AbstractStore
from database.db_session import get_session
from database.models import XhsNote, XhsNoteComment, XhsCreator

from tools.async_file_writer import AsyncFileWriter
from tools.time_util import get_current_timestamp
from var import crawler_type_var
from database.mongodb_store_base import MongoDBStoreBase
from tools import utils
from store.excel_store_base import ExcelStoreBase


def _to_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _is_incremental_mode_enabled() -> bool:
    env_value = os.getenv("XHS_INCREMENTAL_MODE")
    if env_value is not None:
        return _to_bool(env_value, default=False)
    config_value = getattr(config, "XHS_INCREMENTAL_MODE", False)
    return _to_bool(config_value, default=False)


class XhsCsvStoreImplement(AbstractStore):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.writer = AsyncFileWriter(platform="xhs", crawler_type=crawler_type_var.get())
        self._incremental_mode = _is_incremental_mode_enabled()
        self._seen_ids_file = Path(config.XHS_SEEN_IDS_PATH)
        if self._incremental_mode:
            if self._seen_ids_file.parent:
                self._seen_ids_file.parent.mkdir(parents=True, exist_ok=True)
            self._seen_ids = self._load_seen_ids()
        else:
            self._seen_ids = set()
        
        # 輸出初始化信息
        min_liked = getattr(config, "XHS_MIN_LIKED_COUNT", 0)
        utils.logger.info(
            f"[XhsCsvStoreImplement] 增量爬取存儲已初始化: "
            f"增量模式={'on' if self._incremental_mode else 'off'}, "
            f"已爬取記錄數={len(self._seen_ids)}, "
            f"點贊數閾值={min_liked}"
        )

    def _load_seen_ids(self) -> set:
        """加載已爬取的 note_id 集合"""
        if not self._seen_ids_file.exists():
            return set()
        try:
            content = self._seen_ids_file.read_text(encoding="utf-8")
            return set(line.strip() for line in content.splitlines() if line.strip())
        except Exception as e:
            utils.logger.error(f"[XhsCsvStoreImplement._load_seen_ids] 加載已爬取記錄錯誤: {e}")
            return set()

    async def store_content(self, content_item: Dict):
        """
        存儲內容到 CSV 文件（增量爬取模式）
        - 自動過濾點贊數低於閾值的作品
        - 自動去重已爬取的作品
        :param content_item:
        :return:
        """
        note_id = content_item.get("note_id")
        if not note_id:
            utils.logger.warning("[XhsCsvStoreImplement.store_content] note_id 為空，跳過")
            return

        # 點贊門檻過濾（僅在搜索模式下生效）
        current_crawler_type = crawler_type_var.get()
        if current_crawler_type == "search":
            try:
                liked_count_str = content_item.get("liked_count", "0")
                # 處理空字符串、None 等情況
                if liked_count_str == "" or liked_count_str is None:
                    liked_count = 0
                else:
                    liked_count = int(liked_count_str)
            except (ValueError, TypeError):
                liked_count = 0

            min_liked = getattr(config, "XHS_MIN_LIKED_COUNT", 0)
            if min_liked > 0 and liked_count < min_liked:
                utils.logger.info(
                    f"[XhsCsvStoreImplement.store_content] 跳過 note_id={note_id}, "
                    f"點贊數={liked_count} < 最低要求={min_liked} (搜索模式)"
                )
                return
        else:
            # 非搜索模式，获取点赞数用于日志显示
            liked_count = 0

        # 增量去重：已存在的 note_id 直接跳過
        if self._incremental_mode and note_id in self._seen_ids:
            utils.logger.info(
                f"[XhsCsvStoreImplement.store_content] 跳過重複 note_id={note_id} "
                f"(已存在於已爬取記錄中，共 {len(self._seen_ids)} 條記錄)"
            )
            return

        # 保存數據
        try:
            await self.writer.write_to_csv(item_type="contents", item=content_item)
            if self._incremental_mode:
                # 記錄已爬取的 note_id
                with self._seen_ids_file.open("a", encoding="utf-8") as f:
                    f.write(str(note_id) + "\n")
                self._seen_ids.add(str(note_id))
            utils.logger.info(
                f"[XhsCsvStoreImplement.store_content] ✓ 已保存 note_id={note_id}, "
                f"點贊數={liked_count}, 標題={content_item.get('title', '')[:30]}..."
            )
        except Exception as e:
            utils.logger.error(f"[XhsCsvStoreImplement.store_content] 寫入 note_id={note_id} 錯誤: {e}")

    async def store_comment(self, comment_item: Dict):
        """
        store comment data to csv file
        :param comment_item:
        :return:
        """
        await self.writer.write_to_csv(item_type="comments", item=comment_item)


    async def store_creator(self, creator_item: Dict):
        """
        store creator data to csv file
        :param creator_item:
        :return:
        """
        await self.writer.write_to_csv(item_type="creators", item=creator_item)

    def flush(self):
        pass


class XhsJsonStoreImplement(AbstractStore):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.writer = AsyncFileWriter(platform="xhs", crawler_type=crawler_type_var.get())
        self._incremental_mode = _is_incremental_mode_enabled()
        self._seen_ids_file = Path(config.XHS_SEEN_IDS_PATH)
        if self._incremental_mode:
            if self._seen_ids_file.parent:
                self._seen_ids_file.parent.mkdir(parents=True, exist_ok=True)
            self._seen_ids = self._load_seen_ids()
        else:
            self._seen_ids = set()
        
        # 輸出初始化信息
        min_liked = getattr(config, "XHS_MIN_LIKED_COUNT", 0)
        utils.logger.info(
            f"[XhsJsonStoreImplement] 增量爬取存儲已初始化: "
            f"增量模式={'on' if self._incremental_mode else 'off'}, "
            f"已爬取記錄數={len(self._seen_ids)}, "
            f"點贊數閾值={min_liked}"
        )

    def _load_seen_ids(self) -> set:
        """加載已爬取的 note_id 集合"""
        if not self._seen_ids_file.exists():
            return set()
        try:
            content = self._seen_ids_file.read_text(encoding="utf-8")
            return set(line.strip() for line in content.splitlines() if line.strip())
        except Exception as e:
            utils.logger.error(f"[XhsJsonStoreImplement._load_seen_ids] 加載已爬取記錄錯誤: {e}")
            return set()

    async def store_content(self, content_item: Dict):
        """
        存儲內容到 JSON 文件（增量爬取模式）
        - 自動過濾點贊數低於閾值的作品
        - 自動去重已爬取的作品
        :param content_item:
        :return:
        """
        note_id = content_item.get("note_id")
        if not note_id:
            utils.logger.warning("[XhsJsonStoreImplement.store_content] note_id 為空，跳過")
            return

        # 點贊門檻過濾（僅在搜索模式下生效）
        current_crawler_type = crawler_type_var.get()
        if current_crawler_type == "search":
            try:
                liked_count_str = content_item.get("liked_count", "0")
                # 處理空字符串、None 等情況
                if liked_count_str == "" or liked_count_str is None:
                    liked_count = 0
                else:
                    liked_count = int(liked_count_str)
            except (ValueError, TypeError):
                liked_count = 0

            min_liked = getattr(config, "XHS_MIN_LIKED_COUNT", 0)
            if min_liked > 0 and liked_count < min_liked:
                utils.logger.info(
                    f"[XhsJsonStoreImplement.store_content] 跳過 note_id={note_id}, "
                    f"點贊數={liked_count} < 最低要求={min_liked} (搜索模式)"
                )
                return
        else:
            # 非搜索模式，获取点赞数用于日志显示
            try:
                liked_count_str = content_item.get("liked_count", "0")
                liked_count = int(liked_count_str) if liked_count_str not in ("", None) else 0
            except (ValueError, TypeError):
                liked_count = 0

        # 增量去重：已存在的 note_id 直接跳過
        if self._incremental_mode and note_id in self._seen_ids:
            utils.logger.info(
                f"[XhsJsonStoreImplement.store_content] 跳過重複 note_id={note_id} "
                f"(已存在於已爬取記錄中，共 {len(self._seen_ids)} 條記錄)"
            )
            return

        # 保存數據
        try:
            await self.writer.write_single_item_to_json(item_type="contents", item=content_item)
            if self._incremental_mode:
                # 記錄已爬取的 note_id
                with self._seen_ids_file.open("a", encoding="utf-8") as f:
                    f.write(str(note_id) + "\n")
                self._seen_ids.add(str(note_id))
            utils.logger.info(
                f"[XhsJsonStoreImplement.store_content] ✓ 已保存 note_id={note_id}, "
                f"點贊數={liked_count}, 標題={content_item.get('title', '')[:30]}..."
            )
        except Exception as e:
            utils.logger.error(f"[XhsJsonStoreImplement.store_content] 寫入 note_id={note_id} 錯誤: {e}")

    async def store_comment(self, comment_item: Dict):
        """
        store comment data to json file
        :param comment_item:
        :return:
        """
        await self.writer.write_single_item_to_json(item_type="comments", item=comment_item)

    async def store_creator(self, creator_item: Dict):
        """
        store creator data to json file
        :param creator_item:
        :return:
        """
        await self.writer.write_single_item_to_json(item_type="creators", item=creator_item)

    def flush(self):
        """
        flush data to json file
        :return:
        """
        pass


class XhsTxtStoreImplement(AbstractStore):
    """
    基於 txt 的簡單存儲實現（增量爬取模式）：
    - 每行一條 JSON，寫入 config.XHS_TXT_STORE_PATH
    - 使用 config.XHS_SEEN_IDS_PATH 記錄已處理的 note_id，做簡單增量去重
    - 只保存點贊數 >= config.XHS_MIN_LIKED_COUNT 的筆記
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.writer = AsyncFileWriter(platform="xhs", crawler_type=crawler_type_var.get())
        self._incremental_mode = _is_incremental_mode_enabled()
        # 固定 txt 存储文件路径（用于日志展示与兼容历史引用）
        self._notes_file = Path(getattr(config, "XHS_TXT_STORE_PATH", "./data/xhs/notes.txt"))
        if self._notes_file.parent:
            self._notes_file.parent.mkdir(parents=True, exist_ok=True)
        self._seen_ids_file = Path(config.XHS_SEEN_IDS_PATH)
        if self._incremental_mode:
            # 確保目錄存在
            if self._seen_ids_file.parent:
                self._seen_ids_file.parent.mkdir(parents=True, exist_ok=True)
            self._seen_ids = self._load_seen_ids()
        else:
            self._seen_ids = set()
        
        # 輸出初始化信息
        min_liked = getattr(config, "XHS_MIN_LIKED_COUNT", 0)
        utils.logger.info(
            f"[XhsTxtStoreImplement] 增量爬取存儲已初始化: "
            f"增量模式={'on' if self._incremental_mode else 'off'}, "
            f"已爬取記錄數={len(self._seen_ids)}, "
            f"點贊數閾值={min_liked}, "
            f"數據寫入器=AsyncFileWriter(platform=xhs), "
            f"去重記錄文件={self._seen_ids_file}"
        )

    def _load_seen_ids(self) -> set:
        if not self._seen_ids_file.exists():
            return set()
        try:
            content = self._seen_ids_file.read_text(encoding="utf-8")
            return set(line.strip() for line in content.splitlines() if line.strip())
        except Exception as e:
            utils.logger.error(f"[XhsTxtStoreImplement._load_seen_ids] load seen ids error: {e}")
            return set()

    async def store_content(self, content_item: Dict):
        """
        存儲內容（增量爬取模式）
        - 自動過濾點贊數低於閾值的作品
        - 自動去重已爬取的作品
        """
        note_id = content_item.get("note_id")
        if not note_id:
            utils.logger.warning("[XhsTxtStoreImplement.store_content] note_id 為空，跳過")
            return

        # 點贊門檻過濾（僅在搜索模式下生效）
        current_crawler_type = crawler_type_var.get()
        if current_crawler_type == "search":
            try:
                liked_count_str = content_item.get("liked_count", "0")
                # 處理空字符串、None 等情況
                if liked_count_str == "" or liked_count_str is None:
                    liked_count = 0
                else:
                    liked_count = int(liked_count_str)
            except (ValueError, TypeError):
                liked_count = 0

            min_liked = getattr(config, "XHS_MIN_LIKED_COUNT", 0)
            if min_liked > 0 and liked_count < min_liked:
                utils.logger.info(
                    f"[XhsTxtStoreImplement.store_content] 跳過 note_id={note_id}, "
                    f"點贊數={liked_count} < 最低要求={min_liked} (搜索模式)"
                )
                return
        else:
            # 非搜索模式，获取点赞数用于日志显示
            try:
                liked_count_str = content_item.get("liked_count", "0")
                liked_count = int(liked_count_str) if liked_count_str not in ("", None) else 0
            except (ValueError, TypeError):
                liked_count = 0

        # 增量去重：已存在的 note_id 直接跳過
        if self._incremental_mode and note_id in self._seen_ids:
            utils.logger.debug(
                f"[XhsTxtStoreImplement.store_content] 跳過重複 note_id={note_id} "
                f"(已存在於已爬取記錄中，共 {len(self._seen_ids)} 條記錄)"
            )
            return

        # 保存數據
        try:
            await self.writer.write_to_txt(item_type="contents", item=content_item)
            if self._incremental_mode:
                # 記錄已爬取的 note_id
                with self._seen_ids_file.open("a", encoding="utf-8") as f:
                    f.write(str(note_id) + "\n")
                self._seen_ids.add(str(note_id))
            utils.logger.info(
                f"[XhsTxtStoreImplement.store_content] ✓ 已保存 note_id={note_id}, "
                f"點贊數={liked_count}, 標題={content_item.get('title', '')[:30]}..."
            )
        except Exception as e:
            utils.logger.error(f"[XhsTxtStoreImplement.store_content] 寫入 note_id={note_id} 錯誤: {e}")

    async def store_comment(self, comment_item: Dict):
        """
        如需保存評論，也可以以同樣方式寫入 txt，
        目前暫不對評論做 txt 存儲，直接忽略。
        """
        return

    async def store_creator(self, creator_item: Dict):
        """
        txt 存儲創作者資料：每行一條 JSON。
        """
        if not creator_item:
            return
        user_id = creator_item.get("user_id")
        if not user_id:
            return
        creator_path = Path(getattr(config, "XHS_CREATOR_TXT_STORE_PATH", "./data/xhs/creators.txt"))
        if creator_path.parent:
            creator_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(creator_item, ensure_ascii=False)
        try:
            with creator_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
            utils.logger.info(f"[XhsTxtStoreImplement.store_creator] ✓ 已保存 creator user_id={user_id}")
        except Exception as e:
            utils.logger.error(f"[XhsTxtStoreImplement.store_creator] 寫入 creator user_id={user_id} 錯誤: {e}")

    def flush(self):
        """
        txt 存儲為即時寫入，無額外 flush 動作。
        """
        pass



class XhsDbStoreImplement(AbstractStore):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

    async def store_content(self, content_item: Dict):
        note_id = content_item.get("note_id")
        if not note_id:
            return
        async with get_session() as session:
            if await self.content_is_exist(session, note_id):
                await self.update_content(session, content_item)
            else:
                await self.add_content(session, content_item)

    async def add_content(self, session: AsyncSession, content_item: Dict):
        add_ts = int(get_current_timestamp())
        last_modify_ts = int(get_current_timestamp())
        note = XhsNote(
            user_id=content_item.get("user_id"),
            nickname=content_item.get("nickname"),
            avatar=content_item.get("avatar"),
            ip_location=content_item.get("ip_location"),
            add_ts=add_ts,
            last_modify_ts=last_modify_ts,
            note_id=content_item.get("note_id"),
            type=content_item.get("type"),
            title=content_item.get("title"),
            desc=content_item.get("desc"),
            video_url=content_item.get("video_url"),
            time=content_item.get("time"),
            last_update_time=content_item.get("last_update_time"),
            liked_count=str(content_item.get("liked_count")),
            collected_count=str(content_item.get("collected_count")),
            comment_count=str(content_item.get("comment_count")),
            share_count=str(content_item.get("share_count")),
            image_list=json.dumps(content_item.get("image_list")),
            tag_list=json.dumps(content_item.get("tag_list")),
            note_url=content_item.get("note_url"),
            source_keyword=content_item.get("source_keyword", ""),
            xsec_token=content_item.get("xsec_token", "")
        )
        session.add(note)

    async def update_content(self, session: AsyncSession, content_item: Dict):
        note_id = content_item.get("note_id")
        last_modify_ts = int(get_current_timestamp())
        update_data = {
            "last_modify_ts": last_modify_ts,
            "liked_count": str(content_item.get("liked_count")),
            "collected_count": str(content_item.get("collected_count")),
            "comment_count": str(content_item.get("comment_count")),
            "share_count": str(content_item.get("share_count")),
            "last_update_time": content_item.get("last_update_time"),
        }
        stmt = update(XhsNote).where(XhsNote.note_id == note_id).values(**update_data)
        await session.execute(stmt)

    async def content_is_exist(self, session: AsyncSession, note_id: str) -> bool:
        stmt = select(XhsNote).where(XhsNote.note_id == note_id)
        result = await session.execute(stmt)
        return result.first() is not None

    async def store_comment(self, comment_item: Dict):
        if not comment_item:
            return
        async with get_session() as session:
            comment_id = comment_item.get("comment_id")
            if not comment_id:
                return
            if await self.comment_is_exist(session, comment_id):
                await self.update_comment(session, comment_item)
            else:
                await self.add_comment(session, comment_item)

    async def add_comment(self, session: AsyncSession, comment_item: Dict):
        add_ts = int(get_current_timestamp())
        last_modify_ts = int(get_current_timestamp())
        comment = XhsNoteComment(
            user_id=comment_item.get("user_id"),
            nickname=comment_item.get("nickname"),
            avatar=comment_item.get("avatar"),
            ip_location=comment_item.get("ip_location"),
            add_ts=add_ts,
            last_modify_ts=last_modify_ts,
            comment_id=comment_item.get("comment_id"),
            create_time=comment_item.get("create_time"),
            note_id=comment_item.get("note_id"),
            content=comment_item.get("content"),
            sub_comment_count=comment_item.get("sub_comment_count"),
            pictures=json.dumps(comment_item.get("pictures")),
            parent_comment_id=comment_item.get("parent_comment_id"),
            like_count=str(comment_item.get("like_count"))
        )
        session.add(comment)

    async def update_comment(self, session: AsyncSession, comment_item: Dict):
        comment_id = comment_item.get("comment_id")
        last_modify_ts = int(get_current_timestamp())
        update_data = {
            "last_modify_ts": last_modify_ts,
            "like_count": str(comment_item.get("like_count")),
            "sub_comment_count": comment_item.get("sub_comment_count"),
        }
        stmt = update(XhsNoteComment).where(XhsNoteComment.comment_id == comment_id).values(**update_data)
        await session.execute(stmt)

    async def comment_is_exist(self, session: AsyncSession, comment_id: str) -> bool:
        stmt = select(XhsNoteComment).where(XhsNoteComment.comment_id == comment_id)
        result = await session.execute(stmt)
        return result.first() is not None

    async def store_creator(self, creator_item: Dict):
        user_id = creator_item.get("user_id")
        if not user_id:
            return
        async with get_session() as session:
            if await self.creator_is_exist(session, user_id):
                await self.update_creator(session, creator_item)
            else:
                await self.add_creator(session, creator_item)

    async def add_creator(self, session: AsyncSession, creator_item: Dict):
        add_ts = int(get_current_timestamp())
        last_modify_ts = int(get_current_timestamp())
        creator = XhsCreator(
            user_id=creator_item.get("user_id"),
            nickname=creator_item.get("nickname"),
            avatar=creator_item.get("avatar"),
            ip_location=creator_item.get("ip_location"),
            add_ts=add_ts,
            last_modify_ts=last_modify_ts,
            desc=creator_item.get("desc"),
            gender=creator_item.get("gender"),
            follows=str(creator_item.get("follows")),
            fans=str(creator_item.get("fans")),
            interaction=str(creator_item.get("interaction")),
            tag_list=json.dumps(creator_item.get("tag_list"))
        )
        session.add(creator)

    async def update_creator(self, session: AsyncSession, creator_item: Dict):
        user_id = creator_item.get("user_id")
        last_modify_ts = int(get_current_timestamp())
        update_data = {
            "last_modify_ts": last_modify_ts,
            "nickname": creator_item.get("nickname"),
            "avatar": creator_item.get("avatar"),
            "desc": creator_item.get("desc"),
            "follows": str(creator_item.get("follows")),
            "fans": str(creator_item.get("fans")),
            "interaction": str(creator_item.get("interaction")),
            "tag_list": json.dumps(creator_item.get("tag_list"))
        }
        stmt = update(XhsCreator).where(XhsCreator.user_id == user_id).values(**update_data)
        await session.execute(stmt)

    async def creator_is_exist(self, session: AsyncSession, user_id: str) -> bool:
        stmt = select(XhsCreator).where(XhsCreator.user_id == user_id)
        result = await session.execute(stmt)
        return result.first() is not None

    async def get_all_content(self) -> List[Dict]:
        async with get_session() as session:
            stmt = select(XhsNote)
            result = await session.execute(stmt)
            return [item.__dict__ for item in result.scalars().all()]

    async def get_all_comments(self) -> List[Dict]:
        async with get_session() as session:
            stmt = select(XhsNoteComment)
            result = await session.execute(stmt)
            return [item.__dict__ for item in result.scalars().all()]


class XhsSqliteStoreImplement(XhsDbStoreImplement):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class XhsMongoStoreImplement(AbstractStore):
    """Xiaohongshu MongoDB storage implementation"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.mongo_store = MongoDBStoreBase(collection_prefix="xhs")

    async def store_content(self, content_item: Dict):
        """
        Store note content to MongoDB
        Args:
            content_item: Note content data
        """
        note_id = content_item.get("note_id")
        if not note_id:
            return

        await self.mongo_store.save_or_update(
            collection_suffix="contents",
            query={"note_id": note_id},
            data=content_item
        )
        utils.logger.info(f"[XhsMongoStoreImplement.store_content] Saved note {note_id} to MongoDB")

    async def store_comment(self, comment_item: Dict):
        """
        Store comment to MongoDB
        Args:
            comment_item: Comment data
        """
        comment_id = comment_item.get("comment_id")
        if not comment_id:
            return

        await self.mongo_store.save_or_update(
            collection_suffix="comments",
            query={"comment_id": comment_id},
            data=comment_item
        )
        utils.logger.info(f"[XhsMongoStoreImplement.store_comment] Saved comment {comment_id} to MongoDB")

    async def store_creator(self, creator_item: Dict):
        """
        Store creator information to MongoDB
        Args:
            creator_item: Creator data
        """
        user_id = creator_item.get("user_id")
        if not user_id:
            return

        await self.mongo_store.save_or_update(
            collection_suffix="creators",
            query={"user_id": user_id},
            data=creator_item
        )
        utils.logger.info(f"[XhsMongoStoreImplement.store_creator] Saved creator {user_id} to MongoDB")


class XhsExcelStoreImplement:
    """Xiaohongshu Excel storage implementation - Global singleton"""

    def __new__(cls, *args, **kwargs):
        from store.excel_store_base import ExcelStoreBase
        return ExcelStoreBase.get_instance(
            platform="xhs",
            crawler_type=crawler_type_var.get()
        )
