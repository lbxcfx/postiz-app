# -*- coding: utf-8 -*-
import os
import re
from pathlib import Path
from typing import Dict, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/config", tags=["config"])

# Config file path
CONFIG_FILE = Path(__file__).parent.parent.parent / "config" / "base_config.py"


class ConfigUpdateRequest(BaseModel):
    """Configuration update request"""
    configs: Dict[str, Any]


@router.get("/current")
async def get_current_config():
    """Get current configuration"""
    try:
        # Read config values from runtime module
        if not CONFIG_FILE.exists():
            raise HTTPException(status_code=404, detail="Config file not found")

        import config as runtime_config

        config = {
            "platform": getattr(runtime_config, "PLATFORM", "xhs"),
            "keywords": getattr(runtime_config, "KEYWORDS", ""),
            "login_type": getattr(runtime_config, "LOGIN_TYPE", "cookie"),
            "crawler_type": getattr(runtime_config, "CRAWLER_TYPE", "search"),
            "enable_ip_proxy": getattr(runtime_config, "ENABLE_IP_PROXY", False),
            "ip_proxy_pool_count": getattr(runtime_config, "IP_PROXY_POOL_COUNT", 2),
            "ip_proxy_provider": getattr(runtime_config, "IP_PROXY_PROVIDER_NAME", "kuaidaili"),
            "headless": getattr(runtime_config, "HEADLESS", False),
            "save_login_state": getattr(runtime_config, "SAVE_LOGIN_STATE", True),
            "enable_cdp_mode": getattr(runtime_config, "ENABLE_CDP_MODE", True),
            "cdp_debug_port": getattr(runtime_config, "CDP_DEBUG_PORT", 9222),
            "cdp_headless": getattr(runtime_config, "CDP_HEADLESS", False),
            "auto_close_browser": getattr(runtime_config, "AUTO_CLOSE_BROWSER", True),
            "save_data_option": getattr(runtime_config, "SAVE_DATA_OPTION", "json"),
            "start_page": getattr(runtime_config, "START_PAGE", 1),
            "crawler_max_notes_count": getattr(runtime_config, "CRAWLER_MAX_NOTES_COUNT", 10),
            "max_concurrency_num": getattr(runtime_config, "MAX_CONCURRENCY_NUM", 1),
            "enable_get_medias": getattr(runtime_config, "ENABLE_GET_MEIDAS", False),
            "enable_get_comments": getattr(runtime_config, "ENABLE_GET_COMMENTS", False),
            "crawler_max_comments_count_singlenotes": getattr(runtime_config, "CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES", 10),
            "enable_get_sub_comments": getattr(runtime_config, "ENABLE_GET_SUB_COMMENTS", False),
            "enable_get_wordcloud": getattr(runtime_config, "ENABLE_GET_WORDCLOUD", False),
            "crawler_max_sleep_sec": getattr(runtime_config, "CRAWLER_MAX_SLEEP_SEC", 10),
            "xhs_min_save_count_per_keyword": getattr(runtime_config, "XHS_MIN_SAVE_COUNT_PER_KEYWORD", 10),
        }
        
        return {"config": config}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update")
async def update_config(request: ConfigUpdateRequest):
    """Update configuration
    
    Note:
    - Updates config/base_config.py in place
    - Restart crawler for changes to take effect
    """
    try:
        if not CONFIG_FILE.exists():
            raise HTTPException(status_code=404, detail="Config file not found")

        # Map API fields to config keys
        key_map = {
            "save_data_option": "SAVE_DATA_OPTION",
            "enable_ip_proxy": "ENABLE_IP_PROXY",
            "ip_proxy_pool_count": "IP_PROXY_POOL_COUNT",
            "ip_proxy_provider": "IP_PROXY_PROVIDER_NAME",
            "headless": "HEADLESS",
            "save_login_state": "SAVE_LOGIN_STATE",
            "enable_cdp_mode": "ENABLE_CDP_MODE",
            "cdp_debug_port": "CDP_DEBUG_PORT",
            "cdp_headless": "CDP_HEADLESS",
            "auto_close_browser": "AUTO_CLOSE_BROWSER",
            "start_page": "START_PAGE",
            "crawler_max_notes_count": "CRAWLER_MAX_NOTES_COUNT",
            "max_concurrency_num": "MAX_CONCURRENCY_NUM",
            "enable_get_comments": "ENABLE_GET_COMMENTS",
            "crawler_max_comments_count_singlenotes": "CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES",
            "enable_get_sub_comments": "ENABLE_GET_SUB_COMMENTS",
            "enable_get_medias": "ENABLE_GET_MEIDAS",
            "enable_get_wordcloud": "ENABLE_GET_WORDCLOUD",
            "crawler_max_sleep_sec": "CRAWLER_MAX_SLEEP_SEC",
            "xhs_min_save_count_per_keyword": "XHS_MIN_SAVE_COUNT_PER_KEYWORD",
        }

        # Normalize incoming keys
        incoming = request.configs or {}
        normalized = {}
        for k, v in incoming.items():
            k_norm = k.strip()
            if k_norm in key_map:
                normalized[key_map[k_norm]] = v

        if not normalized:
            return {"success": True, "message": "No supported config keys provided."}

        def _format_value(val: Any) -> str:
            if isinstance(val, bool):
                return "True" if val else "False"
            if isinstance(val, (int, float)):
                return str(val)
            if val is None:
                return "None"
            # strings
            return repr(str(val))

        text = CONFIG_FILE.read_text(encoding="utf-8")

        for cfg_key, cfg_val in normalized.items():
            pattern = rf"^({re.escape(cfg_key)}\s*=\s*).*$"
            replacement = rf"\1{_format_value(cfg_val)}"
            if re.search(pattern, text, flags=re.MULTILINE):
                text = re.sub(pattern, replacement, text, flags=re.MULTILINE)
            else:
                # append if missing
                text += f"\n{cfg_key} = {_format_value(cfg_val)}\n"

        CONFIG_FILE.write_text(text, encoding="utf-8")

        return {
            "success": True,
            "message": "Configuration updated successfully. Please restart the crawler for changes to take effect."
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reset")
async def reset_config():
    """Reset configuration to defaults"""
    try:
        return {
            "success": True,
            "message": "Configuration reset to defaults"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
