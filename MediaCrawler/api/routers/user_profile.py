# -*- coding: utf-8 -*-
# User Profile API Router
# Provides endpoint to batch fetch user profile information (fans count, etc.)
# Used by the viral scoring system for secondary enrichment of search results.

import asyncio
import json
import re
import os
from typing import List, Optional, Dict
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

import httpx

router = APIRouter(prefix="/crawler", tags=["user-profile"])


class UserProfileRequest(BaseModel):
    """Request to fetch user profiles"""
    platform: str = "xhs"
    user_ids: List[str]


class UserProfileInfo(BaseModel):
    """Individual user profile info"""
    user_id: str
    nickname: Optional[str] = None
    fans: Optional[int] = None
    follows: Optional[int] = None
    interaction: Optional[int] = None
    avatar: Optional[str] = None
    desc: Optional[str] = None
    error: Optional[str] = None


class UserProfileResponse(BaseModel):
    """Batch response for user profiles"""
    platform: str
    profiles: List[UserProfileInfo]
    fetched: int = 0
    failed: int = 0


def _extract_xhs_user_info(html: str) -> Optional[Dict]:
    """
    Extract user info from XHS user homepage HTML.
    Parses window.__INITIAL_STATE__ variable.
    """
    match = re.search(
        r"<script>window\.__INITIAL_STATE__=(.+)</script>", html, re.M
    )
    if match is None:
        return None
    try:
        info = json.loads(match.group(1).replace(":undefined", ":null"), strict=False)
    except (json.JSONDecodeError, ValueError):
        return None

    if info is None:
        return None

    user_page = info.get("user", {}).get("userPageData")
    if not user_page:
        return None

    # Extract basic info
    basic_info = user_page.get("basicInfo", {})
    interactions = user_page.get("interactions", [])

    fans = 0
    follows = 0
    interaction = 0
    for item in interactions:
        itype = item.get("type", "")
        count = item.get("count", 0)
        # Handle string counts like "1.2万"
        if isinstance(count, str):
            count = _parse_chinese_count(count)
        if itype == "fans":
            fans = count
        elif itype == "follows":
            follows = count
        elif itype == "interaction":
            interaction = count

    return {
        "nickname": basic_info.get("nickname"),
        "fans": fans,
        "follows": follows,
        "interaction": interaction,
        "avatar": basic_info.get("images"),
        "desc": basic_info.get("desc"),
    }


def _parse_chinese_count(text: str) -> int:
    """Parse Chinese formatted counts like '1.2万' -> 12000"""
    if not text:
        return 0
    text = text.strip()
    try:
        if "万" in text:
            return int(float(text.replace("万", "")) * 10000)
        elif "亿" in text:
            return int(float(text.replace("亿", "")) * 100000000)
        return int(text)
    except (ValueError, TypeError):
        return 0


async def _fetch_xhs_profile(client: httpx.AsyncClient, user_id: str) -> UserProfileInfo:
    """Fetch a single XHS user profile by scraping their homepage."""
    url = f"https://www.xiaohongshu.com/user/profile/{user_id}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://www.xiaohongshu.com/",
    }

    # Try to load cookies from browser_data if available
    cookie_str = _load_xhs_cookies()
    if cookie_str:
        headers["Cookie"] = cookie_str

    try:
        response = await client.get(url, headers=headers, timeout=15.0, follow_redirects=True)
        if response.status_code != 200:
            return UserProfileInfo(
                user_id=user_id,
                error=f"HTTP {response.status_code}"
            )

        info = _extract_xhs_user_info(response.text)
        if not info:
            return UserProfileInfo(
                user_id=user_id,
                error="Failed to extract user info from HTML"
            )

        return UserProfileInfo(
            user_id=user_id,
            nickname=info.get("nickname"),
            fans=info.get("fans", 0),
            follows=info.get("follows", 0),
            interaction=info.get("interaction", 0),
            avatar=info.get("avatar"),
            desc=info.get("desc"),
        )
    except Exception as e:
        return UserProfileInfo(
            user_id=user_id,
            error=str(e)
        )


def _load_xhs_cookies() -> Optional[str]:
    """Try to load XHS cookies from browser_data directory."""
    import sqlite3
    from pathlib import Path

    project_root = Path(__file__).parent.parent.parent
    # Try CDP mode first, then regular
    for prefix in ["cdp_", ""]:
        cookies_db = project_root / "browser_data" / f"{prefix}xhs_user_data_dir" / "Default" / "Network" / "Cookies"
        if not cookies_db.exists():
            continue
        try:
            conn = sqlite3.connect(f"file:{cookies_db}?mode=ro", uri=True)
            cursor = conn.cursor()
            cursor.execute("SELECT name, value FROM cookies WHERE host_key LIKE '%xiaohongshu.com%'")
            rows = cursor.fetchall()
            conn.close()
            if rows:
                return "; ".join([f"{name}={value}" for name, value in rows])
        except Exception:
            continue
    return None


@router.post("/user-profiles")
async def batch_get_user_profiles(request: UserProfileRequest):
    """
    Batch fetch user profile information.
    Currently supports XHS (xiaohongshu) platform.

    Returns fan counts, follows, interaction counts for each user.
    Used by the viral scoring system.
    """
    if not request.user_ids:
        return UserProfileResponse(platform=request.platform, profiles=[], fetched=0, failed=0)

    if request.platform != "xhs":
        raise HTTPException(
            status_code=400,
            detail=f"Platform '{request.platform}' user profile fetch not yet supported"
        )

    # Limit batch size to avoid abuse
    user_ids = list(set(request.user_ids))[:20]

    profiles = []
    fetched = 0
    failed = 0

    async with httpx.AsyncClient() as client:
        # Process sequentially with delay to avoid rate limiting
        for i, user_id in enumerate(user_ids):
            if not user_id or not user_id.strip():
                continue

            profile = await _fetch_xhs_profile(client, user_id.strip())
            profiles.append(profile)

            if profile.error:
                failed += 1
            else:
                fetched += 1

            # Rate limiting: 1-2 second delay between requests
            if i < len(user_ids) - 1:
                await asyncio.sleep(1.5)

    return UserProfileResponse(
        platform=request.platform,
        profiles=profiles,
        fetched=fetched,
        failed=failed,
    )
