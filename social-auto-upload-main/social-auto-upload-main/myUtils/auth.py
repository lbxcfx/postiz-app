import os
from pathlib import Path

from playwright.async_api import async_playwright

from conf import BASE_DIR, LOCAL_CHROME_HEADLESS
from utils.base_social_media import set_init_script
from utils.log import douyin_logger, kuaishou_logger, tencent_logger

USER_DATA_DIR_PREFIX = 'user_data_dir::'


def resolve_headless(default_headless: bool) -> bool:
    if default_headless:
        return True
    if os.name == 'nt':
        return False
    return not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))


async def _open_context_with_state(playwright, account_file):
    browser = await playwright.chromium.launch(
        headless=resolve_headless(LOCAL_CHROME_HEADLESS)
    )
    context = await browser.new_context(storage_state=str(account_file))
    context = await set_init_script(context)
    return browser, context


async def _open_context_with_user_data(playwright, user_data_dir: str):
    context = await playwright.chromium.launch_persistent_context(
        user_data_dir=user_data_dir,
        headless=resolve_headless(LOCAL_CHROME_HEADLESS),
        args=[
            '--no-first-run',
            '--no-default-browser-check',
        ],
    )
    context = await set_init_script(context)
    return None, context


async def _close(browser, context):
    await context.close()
    if browser:
        await browser.close()


async def cookie_auth_douyin(account_file):
    async with async_playwright() as playwright:
        browser, context = await _open_context_with_state(playwright, account_file)
        page = await context.new_page()
        await page.goto(
            'https://creator.douyin.com/creator-micro/content/upload',
            wait_until='domcontentloaded',
        )
        await page.wait_for_timeout(1000)
        is_login = '/login' in page.url or await page.get_by_text('扫码登录').count() > 0
        await _close(browser, context)
        if is_login:
            douyin_logger.error('[+] douyin cookie invalid')
            return False
        douyin_logger.success('[+] douyin cookie valid')
        return True


async def cookie_auth_tencent(account_file):
    async with async_playwright() as playwright:
        browser, context = await _open_context_with_state(playwright, account_file)
        page = await context.new_page()
        await page.goto(
            'https://channels.weixin.qq.com/platform/post/create',
            wait_until='domcontentloaded',
        )
        await page.wait_for_timeout(1000)
        is_login = '/login' in page.url
        await _close(browser, context)
        if is_login:
            tencent_logger.error('[+] tencent cookie invalid')
            return False
        tencent_logger.success('[+] tencent cookie valid')
        return True


async def cookie_auth_ks(account_file):
    async with async_playwright() as playwright:
        browser, context = await _open_context_with_state(playwright, account_file)
        page = await context.new_page()
        await page.goto(
            'https://cp.kuaishou.com/article/publish/video',
            wait_until='domcontentloaded',
        )
        await page.wait_for_timeout(1000)
        is_login = '/login' in page.url
        await _close(browser, context)
        if is_login:
            kuaishou_logger.error('[+] kuaishou cookie invalid')
            return False
        kuaishou_logger.success('[+] kuaishou cookie valid')
        return True


async def cookie_auth_xhs(account_file):
    async with async_playwright() as playwright:
        account_value = str(account_file or '').strip()
        is_user_data_dir = account_value.startswith(USER_DATA_DIR_PREFIX)

        if is_user_data_dir:
            user_data_dir = account_value[len(USER_DATA_DIR_PREFIX):].strip()
            browser, context = await _open_context_with_user_data(playwright, user_data_dir)
        else:
            browser, context = await _open_context_with_state(playwright, account_file)

        page = await context.new_page()
        await page.goto(
            'https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image',
            wait_until='domcontentloaded',
        )
        await page.wait_for_timeout(1200)

        current_url = page.url
        page_text = ''
        try:
            page_text = await page.evaluate(
                "() => (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 1200)"
            )
        except Exception:
            page_text = ''
        is_login = '/login' in current_url
        if not is_login:
            is_login = (
                await page.get_by_text('手机号登录').count() > 0
                or await page.get_by_text('扫码登录').count() > 0
            )
        is_risk_block = (
            '300012' in current_url
            or 'verifyType=400' in current_url
            or '安全限制' in page_text
            or 'IP存在风险' in page_text
        )

        await _close(browser, context)

        if is_risk_block:
            print(f'[+] cookie invalid, xhs risk-control blocked current environment: {current_url}')
            return False

        if is_login:
            print(f'[+] cookie invalid, redirected to login: {current_url}')
            return False

        print('[+] cookie valid')
        return True


async def check_cookie(type, file_path):
    if int(type) == 1:
        cookie_value = str(file_path or '').strip()
        if cookie_value.startswith(USER_DATA_DIR_PREFIX):
            return await cookie_auth_xhs(cookie_value)
        return await cookie_auth_xhs(Path(BASE_DIR / 'cookiesFile' / cookie_value))
    if int(type) == 2:
        return await cookie_auth_tencent(Path(BASE_DIR / 'cookiesFile' / str(file_path)))
    if int(type) == 3:
        return await cookie_auth_douyin(Path(BASE_DIR / 'cookiesFile' / str(file_path)))
    if int(type) == 4:
        return await cookie_auth_ks(Path(BASE_DIR / 'cookiesFile' / str(file_path)))
    return False
