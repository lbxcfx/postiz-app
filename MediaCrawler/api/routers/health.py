# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1

"""
Health check endpoints according to API.md specification
"""
from fastapi import APIRouter
from typing import Dict, Literal

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/liveness")
async def liveness() -> Dict[str, Literal["ok"]]:
    """Liveness probe"""
    return {"status": "ok"}


@router.get("/readiness")
async def readiness() -> Dict:
    """Readiness probe"""
    components = {}
    
    # Check database connection
    try:
        from database.db_session import get_async_engine
        import config
        engine = get_async_engine(config.SAVE_DATA_OPTION)
        if engine:
            # Try to connect
            from sqlalchemy import text
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            components["database"] = "ok"
        else:
            components["database"] = "ok"  # File-based storage
    except Exception:
        components["database"] = "error"
    
    # Check Redis if available
    try:
        from cache.cache_factory import get_cache_impl
        cache = get_cache_impl()
        await cache.get("health_check")
        components["redis"] = "ok"
    except Exception:
        components["redis"] = "not_configured"
    
    # Browser is not a persistent service, so we don't check it here
    components["browser"] = "ok"
    
    status = "ok" if all(v in ["ok", "not_configured"] for v in components.values()) else "error"
    
    return {
        "status": status,
        "components": components
    }
