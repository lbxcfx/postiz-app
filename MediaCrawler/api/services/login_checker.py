# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Login state checker service.
Checks if valid login cookies exist for each platform.
"""

import os
import sqlite3
from pathlib import Path
from typing import Optional
from datetime import datetime


class LoginChecker:
    """Check login state for different platforms"""

    # Platform-specific cookie identifiers that indicate valid login
    PLATFORM_LOGIN_COOKIES = {
        "xhs": ["web_session", "a1"],
        "dy": ["sessionid", "ttwid"],
        "bili": ["SESSDATA", "bili_jct"],
        "ks": ["did", "kuaishou.server.web_st"],
        "wb": ["SUB", "SUBP"],
        "tieba": ["BDUSS", "STOKEN"],
        "zhihu": ["z_c0"],
    }

    def __init__(self):
        self._project_root = Path(__file__).parent.parent.parent
        self._browser_data_dir = self._project_root / "browser_data"
        # If cookies are too old, treat login as invalid to avoid stale-session false positives.
        self._max_cookie_age_hours = int(os.getenv("LOGIN_STATE_MAX_AGE_HOURS", "24"))

    def get_user_data_dir(self, platform: str, use_cdp: bool = True) -> Path:
        """Get browser user data directory for platform"""
        prefix = "cdp_" if use_cdp else ""
        dir_name = f"{prefix}{platform}_user_data_dir"
        return self._browser_data_dir / dir_name

    def _get_cookie_db_candidates(self, user_data_dir: Path) -> list[Path]:
        """
        Chromium cookie DB path differs by channel/version:
        - Default/Network/Cookies
        - Default/Cookies
        """
        return [
            user_data_dir / "Default" / "Network" / "Cookies",
            user_data_dir / "Default" / "Cookies",
        ]

    def check_login_state(self, platform: str) -> dict:
        """
        Check if valid login cookies exist for the platform.
        
        Returns:
            dict with:
                - has_valid_login: bool - whether valid login state exists
                - platform: str - platform name
                - cookies_found: list - list of valid cookie names found
                - last_modified: str - when cookies were last modified
                - recommendation: str - 'headless' or 'headed'
                - message: str - human-readable status
        """
        platform = platform.lower()
        
        if platform not in self.PLATFORM_LOGIN_COOKIES:
            return {
                "has_valid_login": False,
                "platform": platform,
                "cookies_found": [],
                "last_modified": None,
                "recommendation": "headed",
                "message": f"Unsupported platform: {platform}",
            }

        required_cookies = self.PLATFORM_LOGIN_COOKIES[platform]
        
        stale_match = None

        # Try CDP mode first, then regular mode
        for use_cdp in [True, False]:
            user_data_dir = self.get_user_data_dir(platform, use_cdp)
            for cookies_db in self._get_cookie_db_candidates(user_data_dir):
                if not cookies_db.exists():
                    continue

                found_cookies = self._check_cookies_db(cookies_db, platform, required_cookies)

                # A platform is considered logged in only when all required auth cookies are present.
                # Previously, any one cookie was enough and produced false positives.
                has_all_required = all(cookie in found_cookies for cookie in required_cookies)
                if has_all_required:
                    last_modified = datetime.fromtimestamp(
                        cookies_db.stat().st_mtime
                    ).isoformat()
                    cookie_age_hours = max(
                        0.0,
                        (datetime.now().timestamp() - cookies_db.stat().st_mtime) / 3600.0,
                    )
                    if cookie_age_hours > self._max_cookie_age_hours:
                        # Keep scanning other cookie stores; a stale CDP profile
                        # should not mask a fresh non-CDP login.
                        stale_payload = {
                            "has_valid_login": False,
                            "platform": platform,
                            "cookies_found": found_cookies,
                            "last_modified": last_modified,
                            "recommendation": "headed",
                            "message": (
                                f"Login cookies are stale ({cookie_age_hours:.1f}h old). "
                                "QR code login required."
                            ),
                        }
                        if (
                            stale_match is None
                            or cookie_age_hours < stale_match["cookie_age_hours"]
                        ):
                            stale_match = {
                                "cookie_age_hours": cookie_age_hours,
                                "payload": stale_payload,
                            }
                        continue

                    return {
                        "has_valid_login": True,
                        "platform": platform,
                        "cookies_found": found_cookies,
                        "last_modified": last_modified,
                        "recommendation": "headless",
                        "message": f"Valid login state found. Cookies: {', '.join(found_cookies)}",
                        "user_data_dir": str(user_data_dir),
                        "cookies_db": str(cookies_db),
                        "cdp_mode": use_cdp,
                    }

        if stale_match is not None:
            return stale_match["payload"]

        return {
            "has_valid_login": False,
            "platform": platform,
            "cookies_found": [],
            "last_modified": None,
            "recommendation": "headed",
            "message": "No valid login state found. QR code login required.",
        }

    def _check_cookies_db(
        self, cookies_db: Path, platform: str, required_cookies: list
    ) -> list:
        """Check Chrome Cookies SQLite database for required cookies"""
        try:
            # Connect in read-only mode to avoid locking issues
            conn = sqlite3.connect(f"file:{cookies_db}?mode=ro", uri=True)
            cursor = conn.cursor()
            
            # Get all cookie names from the database
            cursor.execute("SELECT name, host_key, expires_utc FROM cookies")
            rows = cursor.fetchall()
            conn.close()
            
            # Map platform to expected domain patterns
            domain_patterns = self._get_domain_patterns(platform)
            
            found = []
            for name, host, expires in rows:
                # Check if cookie matches required cookies and domain
                if name in required_cookies:
                    if any(pattern in host for pattern in domain_patterns):
                        # Check if cookie is not expired
                        # Chrome stores expires_utc as microseconds since 1601
                        if expires == 0 or self._is_cookie_valid(expires):
                            found.append(name)
            
            return found
            
        except Exception as e:
            return []

    def _get_domain_patterns(self, platform: str) -> list:
        """Get domain patterns for platform"""
        patterns = {
            "xhs": ["xiaohongshu.com"],
            "dy": ["douyin.com", "tiktok.com"],
            "bili": ["bilibili.com"],
            "ks": ["kuaishou.com"],
            "wb": ["weibo.com", "sina.com.cn"],
            "tieba": ["baidu.com"],
            "zhihu": ["zhihu.com"],
        }
        return patterns.get(platform, [])

    def _is_cookie_valid(self, expires_utc: int) -> bool:
        """Check if cookie expiration time is still valid"""
        if expires_utc == 0:
            # Session cookie, assume valid
            return True
        
        # Chrome epoch: 1601-01-01 00:00:00 UTC
        # Convert to Unix timestamp (seconds since 1970)
        # Chrome stores microseconds, so divide by 1,000,000
        # Difference between 1601 and 1970 is 11644473600 seconds
        try:
            chrome_epoch_offset = 11644473600
            unix_timestamp = (expires_utc / 1_000_000) - chrome_epoch_offset
            return unix_timestamp > datetime.now().timestamp()
        except:
            return True  # Assume valid if we can't parse


# Global singleton
login_checker = LoginChecker()
