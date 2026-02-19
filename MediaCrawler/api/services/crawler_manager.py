# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/api/services/crawler_manager.py
# GitHub: https://github.com/NanmiCoder
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1
#
# 声明：本代码仅供学习和研究目的使用。使用者应遵守以下原则：
# 1. 不得用于任何商业用途。
# 2. 使用时应遵守目标平台的使用条款和robots.txt规则。
# 3. 不得进行大规模爬取或对平台造成运营干扰。
# 4. 应合理控制请求频率，避免给目标平台带来不必要的负担。
# 5. 不得用于任何非法或不当的用途。
#
# 详细许可条款请参阅项目根目录下的LICENSE文件。
# 使用本代码即表示您同意遵守上述原则和LICENSE中的所有条款。

import asyncio
import subprocess
import signal
import os
import re
from typing import Optional, List
from datetime import datetime
from pathlib import Path

from ..schemas import CrawlerStartRequest, LogEntry, PlatformEnum


class CrawlerManager:
    """Crawler process manager"""

    def __init__(self):
        self._lock = asyncio.Lock()
        self.process: Optional[subprocess.Popen] = None
        self.status = "idle"
        self.started_at: Optional[datetime] = None
        self.current_config: Optional[CrawlerStartRequest] = None
        self._log_id = 0
        self._logs: List[LogEntry] = []
        self._read_task: Optional[asyncio.Task] = None
        # Project root directory
        self._project_root = Path(__file__).parent.parent.parent
        # Log queue - for pushing to WebSocket
        self._log_queue: Optional[asyncio.Queue] = None

    @property
    def logs(self) -> List[LogEntry]:
        return self._logs

    def get_log_queue(self) -> asyncio.Queue:
        """Get or create log queue"""
        if self._log_queue is None:
            self._log_queue = asyncio.Queue()
        return self._log_queue

    def _create_log_entry(
        self,
        message: str,
        level: str = "info",
        client_job_id: Optional[str] = None,
    ) -> LogEntry:
        """Create log entry"""
        self._log_id += 1
        inferred_job_id = (
            client_job_id
            or (
                self.current_config.client_job_id
                if self.current_config and self.current_config.client_job_id
                else None
            )
        )
        entry = LogEntry(
            id=self._log_id,
            timestamp=datetime.now().strftime("%H:%M:%S"),
            level=level,
            message=message,
            client_job_id=inferred_job_id,
        )
        self._logs.append(entry)
        # Keep last 500 logs
        if len(self._logs) > 500:
            self._logs = self._logs[-500:]
        return entry

    async def _push_log(self, entry: LogEntry):
        """Push log to queue"""
        if self._log_queue is not None:
            try:
                self._log_queue.put_nowait(entry)
            except asyncio.QueueFull:
                pass

    def _parse_log_level(self, line: str) -> str:
        """Parse log level"""
        line_upper = line.upper()
        if "ERROR" in line_upper or "FAILED" in line_upper:
            return "error"
        elif "WARNING" in line_upper or "WARN" in line_upper:
            return "warning"
        elif "SUCCESS" in line_upper or "完成" in line or "成功" in line:
            return "success"
        elif "DEBUG" in line_upper:
            return "debug"
        return "info"

    async def start(self, config: CrawlerStartRequest) -> bool:
        """Start crawler process"""
        async with self._lock:
            if self.process and self.process.poll() is None:
                return False

            # Clear old logs
            self._logs = []
            self._log_id = 0

            # Clear pending queue (don't replace object to avoid WebSocket broadcast coroutine holding old queue reference)
            if self._log_queue is None:
                self._log_queue = asyncio.Queue()
            else:
                try:
                    while True:
                        self._log_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass

            # Build command line arguments
            cmd = self._build_command(config)

            # Log start information
            entry = self._create_log_entry(
                f"Starting crawler: {' '.join(cmd)}",
                "info",
                config.client_job_id,
            )
            await self._push_log(entry)

            try:
                # Start subprocess with UTF-8 encoding to handle Chinese characters
                self.process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    encoding='utf-8',
                    errors='replace',  # Replace invalid characters instead of crashing
                    cwd=str(self._project_root),
                    env={**os.environ, "PYTHONUNBUFFERED": "1"}
                )

                self.status = "running"
                self.started_at = datetime.now()
                self.current_config = config

                entry = self._create_log_entry(
                    f"Crawler started on platform: {config.platform.value}, type: {config.crawler_type.value}",
                    "success",
                    config.client_job_id,
                )
                await self._push_log(entry)

                # Start log reading task
                self._read_task = asyncio.create_task(self._read_output())

                return True
            except Exception as e:
                self.status = "error"
                entry = self._create_log_entry(
                    f"Failed to start crawler: {str(e)}",
                    "error",
                    config.client_job_id,
                )
                await self._push_log(entry)
                return False

    async def stop(self) -> bool:
        """Stop crawler process"""
        async with self._lock:
            if not self.process or self.process.poll() is not None:
                return False

            self.status = "stopping"
            entry = self._create_log_entry("Sending SIGTERM to crawler process...", "warning")
            await self._push_log(entry)

            try:
                self.process.send_signal(signal.SIGTERM)

                # Wait for graceful exit (up to 15 seconds)
                for _ in range(30):
                    if self.process.poll() is not None:
                        break
                    await asyncio.sleep(0.5)

                # If still not exited, force kill
                if self.process.poll() is None:
                    entry = self._create_log_entry("Process not responding, sending SIGKILL...", "warning")
                    await self._push_log(entry)
                    self.process.kill()

                entry = self._create_log_entry("Crawler process terminated", "info")
                await self._push_log(entry)

            except Exception as e:
                entry = self._create_log_entry(f"Error stopping crawler: {str(e)}", "error")
                await self._push_log(entry)

            self.status = "idle"
            self.current_config = None

            # Cancel log reading task
            if self._read_task:
                self._read_task.cancel()
                self._read_task = None

            return True

    def get_status(self) -> dict:
        """Get current status"""
        return {
            "status": self.status,
            "platform": self.current_config.platform.value if self.current_config else None,
            "crawler_type": self.current_config.crawler_type.value if self.current_config else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "error_message": None,
            "client_job_id": self.current_config.client_job_id if self.current_config else None,
        }

    def _build_command(self, config: CrawlerStartRequest) -> list:
        """Build main.py command line arguments"""
        import sys
        import shutil
        
        # Check if uv is available
        uv_available = shutil.which("uv") is not None
        
        if uv_available:
            cmd = ["uv", "run", "python", "main.py"]
        else:
            # Fallback to system Python
            cmd = [sys.executable, "main.py"]

        cmd.extend(["--platform", config.platform.value])
        cmd.extend(["--lt", config.login_type.value])
        cmd.extend(["--type", config.crawler_type.value])
        cmd.extend(["--save_data_option", config.save_option.value])

        # Pass different arguments based on crawler type
        if config.crawler_type.value == "search" and config.keywords:
            cmd.extend(["--keywords", config.keywords])
        elif config.crawler_type.value == "detail" and config.specified_ids:
            cmd.extend(["--specified_id", config.specified_ids])
        elif config.crawler_type.value == "creator" and config.creator_ids:
            cmd.extend(["--creator_id", config.creator_ids])

        if config.start_page != 1:
            cmd.extend(["--start", str(config.start_page)])

        if config.client_job_id:
            cmd.extend(["--client_job_id", config.client_job_id])

        # Add max notes count parameter
        # Use crawl_count from schema if available, otherwise fallback to crawler_max_notes_count from extra fields
        max_notes = getattr(config, "crawl_count", 20)
        if hasattr(config, "crawler_max_notes_count"):
            max_notes = config.crawler_max_notes_count
            
        if max_notes != 20:
            cmd.extend(["--crawl_count", str(max_notes)])

        cmd.extend(["--get_comment", "true" if config.enable_comments else "false"])
        cmd.extend(["--get_sub_comment", "true" if config.enable_sub_comments else "false"])

        if config.cookies:
            cmd.extend(["--cookies", config.cookies])

        if config.login_phone:
            cmd.extend(["--phone", config.login_phone])

        cmd.extend(["--headless", "true" if config.headless else "false"])

        # Pass XHS specific configurations if available
        if config.platform == PlatformEnum.XHS:
            xhs_cfg = config.xhs_config or {}

            # Always pass explicit XHS thresholds (including 0), otherwise
            # command parser falls back to strict global defaults in config/*.
            min_liked = xhs_cfg.get("min_liked_count")
            if min_liked is None:
                min_liked = getattr(config, "xhs_min_liked_count", 0)

            min_save = xhs_cfg.get("min_save_count_per_keyword")
            if min_save is None:
                min_save = xhs_cfg.get("min_save_count")
            if min_save is None:
                min_save = getattr(config, "xhs_min_save_count", 0)

            try:
                min_liked = max(0, int(min_liked))
            except (TypeError, ValueError):
                min_liked = 0
            try:
                min_save = max(0, int(min_save))
            except (TypeError, ValueError):
                min_save = 0

            cmd.extend(["--xhs_min_liked_count", str(min_liked)])
            cmd.extend(["--xhs_min_save_count", str(min_save)])

        return cmd

    def _normalize_phone(self, login_phone: str) -> str:
        raw = (login_phone or "").strip()
        digits = "".join(ch for ch in raw if ch.isdigit())
        if not digits:
            return raw
        if len(digits) == 13 and digits.startswith("86"):
            return digits[2:]
        if len(digits) > 11:
            return digits[-11:]
        return digits

    def _sms_code_file_path(self, platform: str, login_phone: str) -> Optional[Path]:
        normalized_phone = self._normalize_phone(login_phone)
        if not normalized_phone:
            return None
        safe_platform = re.sub(r"[^a-zA-Z0-9_-]", "", (platform or "").strip()) or "xhs"
        safe_phone = re.sub(r"[^a-zA-Z0-9_-]", "", normalized_phone)
        if not safe_phone:
            return None
        sms_dir = self._project_root / "runtime" / "sms_codes"
        sms_dir.mkdir(parents=True, exist_ok=True)
        return sms_dir / f"{safe_platform}_{safe_phone}.txt"

    async def submit_sms_code(
        self,
        platform: str,
        login_phone: str,
        sms_code: str,
        client_job_id: Optional[str] = None,
    ) -> bool:
        code = (sms_code or "").strip()
        if not login_phone or not code:
            return False

        file_path = self._sms_code_file_path(platform, login_phone)
        if not file_path:
            return False

        normalized_code = "".join(ch for ch in code if ch.isdigit()) or code
        if not normalized_code:
            return False

        try:
            file_path.write_text(normalized_code, encoding="utf-8")
            normalized_phone = self._normalize_phone(login_phone)
            masked_phone = normalized_phone[-4:].rjust(len(normalized_phone), "*")
            entry = self._create_log_entry(
                f"SMS_CODE_RECEIVED platform={platform} phone={masked_phone}",
                "info",
                client_job_id,
            )
            await self._push_log(entry)
            return True
        except Exception as e:
            entry = self._create_log_entry(
                f"Failed to persist sms code: {str(e)}",
                "error",
                client_job_id,
            )
            await self._push_log(entry)
            return False


    async def _read_output(self):
        """Asynchronously read process output"""
        loop = asyncio.get_event_loop()

        try:
            while self.process and self.process.poll() is None:
                # Read a line in thread pool
                line = await loop.run_in_executor(
                    None, self.process.stdout.readline
                )
                if line:
                    line = line.strip()
                    if line:
                        level = self._parse_log_level(line)
                        entry = self._create_log_entry(line, level)
                        await self._push_log(entry)

            # Read remaining output
            if self.process and self.process.stdout:
                remaining = await loop.run_in_executor(
                    None, self.process.stdout.read
                )
                if remaining:
                    for line in remaining.strip().split('\n'):
                        if line.strip():
                            level = self._parse_log_level(line)
                            entry = self._create_log_entry(line.strip(), level)
                            await self._push_log(entry)

            # Process ended
            if self.status == "running":
                exit_code = self.process.returncode if self.process else -1
                if exit_code == 0:
                    entry = self._create_log_entry("Crawler completed successfully", "success")
                else:
                    entry = self._create_log_entry(f"Crawler exited with code: {exit_code}", "warning")
                await self._push_log(entry)
                self.status = "idle"

        except asyncio.CancelledError:
            pass
        except Exception as e:
            entry = self._create_log_entry(f"Error reading output: {str(e)}", "error")
            await self._push_log(entry)


# Global singleton
crawler_manager = CrawlerManager()
