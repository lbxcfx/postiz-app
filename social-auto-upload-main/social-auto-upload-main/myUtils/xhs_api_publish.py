import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright
from xhs import XhsClient

from conf import BASE_DIR, LOCAL_CHROME_HEADLESS
from uploader.xhs_uploader.main import sign_local

USER_DATA_DIR_PREFIX = "user_data_dir::"


class XhsApiPublishError(RuntimeError):
    pass


def resolve_headless(default_headless: bool) -> bool:
    if default_headless:
        return True
    if os.name == "nt":
        return False
    return not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def should_fallback_to_xhs_api(exc: Exception) -> bool:
    message = str(exc or "").lower()
    if not message:
        return False
    tokens = [
        "failed to enter xiaohongshu publish page",
        "creator login required",
        "cookie invalid or login required",
        "redirected to login",
        "creator.xiaohongshu.com",
        "upload input not found",
        "xhs risk-control blocked",
    ]
    return any(token in message for token in tokens)


def _parse_account_source(account_file: str) -> tuple[str, str]:
    value = str(account_file or "").strip()
    if value.startswith(USER_DATA_DIR_PREFIX):
        return "user_data_dir", value[len(USER_DATA_DIR_PREFIX) :].strip()
    return "storage_state", value


def _cookie_string_from_items(cookies: list[dict], domain_required: bool = True) -> str:
    pairs: list[str] = []
    seen_names: set[str] = set()
    for item in cookies or []:
        name = str(item.get("name") or "").strip()
        value = item.get("value")
        domain = str(item.get("domain") or "").strip().lower()
        if not name or value is None:
            continue
        if domain_required and "xiaohongshu.com" not in domain:
            continue
        if name in seen_names:
            continue
        seen_names.add(name)
        pairs.append(f"{name}={value}")
    return "; ".join(pairs)


async def _extract_cookie_from_storage_state_runtime(storage_state_path: Path) -> str:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=resolve_headless(LOCAL_CHROME_HEADLESS)
        )
        context = await browser.new_context(storage_state=str(storage_state_path))
        try:
            page = await context.new_page()
            await page.goto("https://www.xiaohongshu.com/explore", wait_until="domcontentloaded")
            await page.wait_for_timeout(1000)
            cookies = await context.cookies("https://www.xiaohongshu.com")
            return _cookie_string_from_items(cookies, domain_required=False)
        finally:
            await context.close()
            await browser.close()


def _extract_cookie_from_storage_state(storage_state_path: Path) -> str:
    try:
        content = storage_state_path.read_text(encoding="utf-8")
        payload = json.loads(content)
    except Exception:
        payload = {}

    cookies = payload.get("cookies") if isinstance(payload, dict) else []
    if isinstance(cookies, list):
        cookie = _cookie_string_from_items(cookies)
        if cookie:
            return cookie

    return asyncio.run(_extract_cookie_from_storage_state_runtime(storage_state_path))


async def _extract_cookie_from_user_data_dir(user_data_dir: str) -> str:
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            headless=resolve_headless(LOCAL_CHROME_HEADLESS),
            args=[
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        try:
            page = await context.new_page()
            await page.goto("https://www.xiaohongshu.com/explore", wait_until="domcontentloaded")
            await page.wait_for_timeout(1200)
            cookies = await context.cookies("https://www.xiaohongshu.com")
            return _cookie_string_from_items(cookies, domain_required=False)
        finally:
            await context.close()


def _resolve_storage_state_path(source_value: str) -> Path:
    path = Path(source_value)
    if path.is_absolute():
        return path
    return Path(BASE_DIR / "cookiesFile" / source_value)


def load_xhs_cookie_string(account_file: str) -> str:
    source_type, source_value = _parse_account_source(account_file)
    if source_type == "user_data_dir":
        if not source_value:
            raise XhsApiPublishError("missing user_data_dir account source")
        profile_path = Path(source_value)
        if not profile_path.exists():
            raise XhsApiPublishError(f"user_data_dir not found: {source_value}")
        cookie = asyncio.run(_extract_cookie_from_user_data_dir(source_value))
    else:
        state_path = _resolve_storage_state_path(source_value)
        if not state_path.exists():
            raise XhsApiPublishError(f"storage_state not found: {state_path}")
        cookie = _extract_cookie_from_storage_state(state_path)

    if not cookie:
        raise XhsApiPublishError("no xiaohongshu cookie found in account source")
    return cookie


def _normalize_tags(tags) -> list[str]:
    normalized: list[str] = []
    if not isinstance(tags, list):
        return normalized
    for item in tags:
        text = str(item or "").strip().lstrip("#")
        if text:
            normalized.append(text)
    return normalized


def _build_desc(description: str, tags) -> str:
    body = str(description or "").strip()
    tags_text = " ".join([f"#{tag}" for tag in _normalize_tags(tags)])
    if body and tags_text:
        return f"{body}\n{tags_text}"
    if body:
        return body
    return tags_text


def _normalize_post_time(scheduled_time) -> str | None:
    if not scheduled_time:
        return None

    dt: datetime | None = None
    if isinstance(scheduled_time, datetime):
        dt = scheduled_time
    elif isinstance(scheduled_time, (int, float)):
        ts = float(scheduled_time)
        if ts > 10**12:
            ts = ts / 1000.0
        dt = datetime.fromtimestamp(ts)
    else:
        text = str(scheduled_time).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
                try:
                    dt = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue

    if not dt:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _normalize_image_paths(image_paths: list[str]) -> list[str]:
    normalized: list[str] = []
    for item in image_paths or []:
        source_path = Path(str(item or "").strip())
        if source_path.is_absolute():
            if source_path.exists():
                normalized.append(str(source_path))
            continue

        image_path = Path(BASE_DIR / "imageFile" / source_path)
        video_path = Path(BASE_DIR / "videoFile" / source_path)
        if image_path.exists():
            normalized.append(str(image_path))
        elif video_path.exists():
            normalized.append(str(video_path))
    return normalized


def publish_image_note_with_api(
    account_file: str,
    title: str,
    description: str,
    tags,
    image_paths: list[str],
    scheduled_time=None,
) -> dict:
    files = _normalize_image_paths(image_paths)
    if not files:
        raise XhsApiPublishError("no valid image files for xhs api publish")

    cookie = load_xhs_cookie_string(account_file)
    client = XhsClient(cookie, sign=sign_local, timeout=60)

    title_text = (str(title or "").strip() or str(description or "").strip() or "图文发布")[:20]
    desc_text = _build_desc(description, tags)
    post_time = _normalize_post_time(scheduled_time)

    try:
        # Validate login with the same cookie source before publish.
        client.get_self_info()
    except Exception as exc:
        raise XhsApiPublishError(f"xhs api auth check failed: {exc}") from exc

    try:
        return client.create_image_note(
            title=title_text,
            desc=desc_text,
            files=files,
            post_time=post_time,
            topics=[],
            is_private=False,
        )
    except Exception as exc:
        raise XhsApiPublishError(f"xhs api image publish failed: {exc}") from exc
