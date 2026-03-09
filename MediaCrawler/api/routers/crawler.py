# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/api/routers/crawler.py
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

from fastapi import APIRouter, HTTPException

from ..schemas import (
    CrawlerStartRequest,
    CrawlerStatusResponse,
    LoginStatusResponse,
    SmsCodeRequest,
)
from ..services import crawler_manager
from ..services.login_checker import login_checker

router = APIRouter(prefix="/crawler", tags=["crawler"])


@router.post("/start")
async def start_crawler(request: CrawlerStartRequest):
    """Start crawler task"""
    success = await crawler_manager.start(request)
    if not success:
        # Handle concurrent/duplicate requests: if process is already running, return 400 instead of 500
        if crawler_manager.process and crawler_manager.process.poll() is None:
            raise HTTPException(status_code=400, detail="Crawler is already running")
        raise HTTPException(status_code=500, detail="Failed to start crawler")

    return {"status": "ok", "message": "Crawler started successfully"}


@router.post("/stop")
async def stop_crawler():
    """Stop crawler task"""
    success = await crawler_manager.stop()
    if not success:
        # Handle concurrent/duplicate requests: if process already exited/doesn't exist, return 400 instead of 500
        if not crawler_manager.process or crawler_manager.process.poll() is not None:
            raise HTTPException(status_code=400, detail="No crawler is running")
        raise HTTPException(status_code=500, detail="Failed to stop crawler")

    return {"status": "ok", "message": "Crawler stopped successfully"}


@router.get("/status", response_model=CrawlerStatusResponse)
async def get_crawler_status():
    """Get crawler status"""
    return crawler_manager.get_status()


@router.get("/logs")
async def get_logs(limit: int = 100):
    """Get recent logs"""
    logs = crawler_manager.logs[-limit:] if limit > 0 else crawler_manager.logs
    return {"logs": [log.model_dump() for log in logs]}


@router.get("/login-status/{platform}", response_model=LoginStatusResponse)
async def get_login_status(platform: str):
    """Check if platform has valid, non-expired login cookies."""
    result = login_checker.check_login_state(platform)
    return LoginStatusResponse(
        has_valid_login=result.get("has_valid_login", False),
        platform=result.get("platform", platform),
        recommendation=result.get("recommendation", "headed"),
        message=result.get("message", "Unable to determine login status"),
        cookies_found=result.get("cookies_found", []),
        last_modified=result.get("last_modified"),
        user_data_dir=result.get("user_data_dir"),
        cookies_db=result.get("cookies_db"),
        cdp_mode=result.get("cdp_mode"),
    )


@router.post("/sms-code")
async def submit_sms_code(request: SmsCodeRequest):
    """Submit SMS verification code for phone login."""
    success = await crawler_manager.submit_sms_code(
        platform=request.platform.value,
        login_phone=request.login_phone,
        sms_code=request.sms_code,
        client_job_id=request.client_job_id,
    )
    if not success:
        raise HTTPException(status_code=400, detail="Invalid SMS code payload")
    return {"status": "ok", "message": "SMS code submitted"}
