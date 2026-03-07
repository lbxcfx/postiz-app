# -*- coding: utf-8 -*-
from datetime import datetime
from pathlib import Path

from playwright.async_api import Playwright, async_playwright, Page
import os
import asyncio
import time

from conf import BASE_DIR, LOCAL_CHROME_PATH, LOCAL_CHROME_HEADLESS
from utils.base_social_media import set_init_script
from utils.log import xiaohongshu_logger

USER_DATA_DIR_PREFIX = "user_data_dir::"


def resolve_headless(default_headless: bool) -> bool:
    if default_headless:
        return True
    if os.name == "nt":
        return False
    return not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def parse_account_source(account_file):
    value = str(account_file or "").strip()
    if value.startswith(USER_DATA_DIR_PREFIX):
        user_data_dir = value[len(USER_DATA_DIR_PREFIX):].strip()
        return "user_data_dir", user_data_dir
    return "storage_state", value


async def create_xhs_context(
    playwright: Playwright,
    account_file,
    headless: bool,
    executable_path: str | None = None,
    viewport: dict | None = None,
):
    source_type, source_value = parse_account_source(account_file)
    viewport = viewport or {"width": 1600, "height": 900}

    launch_kwargs = {
        "headless": headless,
    }
    if executable_path:
        launch_kwargs["executable_path"] = executable_path

    if source_type == "user_data_dir":
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=source_value,
            viewport=viewport,
            args=[
                "--no-first-run",
                "--no-default-browser-check",
            ],
            **launch_kwargs,
        )
        return None, context

    browser = await playwright.chromium.launch(**launch_kwargs)
    context = await browser.new_context(
        viewport=viewport,
        storage_state=source_value,
    )
    return browser, context


async def maybe_save_storage_state(context, account_file):
    source_type, source_value = parse_account_source(account_file)
    if source_type == "storage_state" and source_value:
        await context.storage_state(path=source_value)


async def close_context(browser, context):
    await context.close()
    if browser:
        await browser.close()


async def cookie_auth(account_file):
    async with async_playwright() as playwright:
        browser, context = await create_xhs_context(
            playwright,
            account_file,
            resolve_headless(LOCAL_CHROME_HEADLESS),
        )
        context = await set_init_script(context)
        # create a new page
        page = await context.new_page()
        await page.goto(
            "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image",
            wait_until="domcontentloaded",
        )
        await page.wait_for_timeout(1200)

        if "/login" in page.url:
            await close_context(browser, context)
            return False

        if await page.get_by_text("手机号登录").count() or await page.get_by_text("扫码登录").count():
            await close_context(browser, context)
            return False

        await close_context(browser, context)
        return True


async def goto_publish_page(page: Page, target_url: str, timeout_ms: int = 90000):
    """
    Xiaohongshu pages may keep some resources pending, so waiting for full `load`
    can timeout in headless environments. In shared-login mode, creator may
    redirect to login first, then auto-SSO into publish page after a few seconds.
    """
    start_time = time.monotonic()
    await page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)

    last_url = page.url
    while (time.monotonic() - start_time) * 1000 < timeout_ms:
        if "creator.xiaohongshu.com/publish/publish" in page.url:
            return

        remaining_ms = int(timeout_ms - (time.monotonic() - start_time) * 1000)
        if remaining_ms <= 0:
            break

        # If page stays at a non-login URL without progressing, retry once.
        if page.url == last_url and "/login" not in page.url and remaining_ms > 5000:
            try:
                await page.goto(
                    target_url,
                    wait_until="domcontentloaded",
                    timeout=min(15000, remaining_ms),
                )
            except Exception:
                pass
        else:
            await page.wait_for_timeout(min(1500, remaining_ms))

        last_url = page.url

    current_url = page.url
    page_text = ""
    try:
        page_text = await page.evaluate(
            "() => (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 2000)"
        )
    except Exception:
        page_text = ""

    reason = "unknown"
    if "/login" in current_url:
        reason = "creator login required"
    elif (
        "300012" in current_url
        or "verifyType=400" in current_url
        or "安全限制" in page_text
        or "IP存在风险" in page_text
    ):
        reason = "xiaohongshu risk-control blocked this environment (code=300012)"
    elif "页面不见了" in page_text:
        reason = "creator publish page unavailable for this account"

    raise RuntimeError(
        f"failed to enter xiaohongshu publish page ({reason}): {current_url}"
    )


async def xiaohongshu_setup(account_file, handle=False):
    source_type, source_value = parse_account_source(account_file)
    has_cookie_source = source_type == "user_data_dir" or os.path.exists(source_value)
    if not has_cookie_source or not await cookie_auth(account_file):
        if not handle:
            # Todo alert message
            return False
        xiaohongshu_logger.info('[+] cookie鏂囦欢涓嶅瓨鍦ㄦ垨宸插け鏁堬紝鍗冲皢鑷姩鎵撳紑娴忚鍣紝璇锋壂鐮佺櫥褰曪紝鐧婚檰鍚庝細鑷姩鐢熸垚cookie鏂囦欢')
        await xiaohongshu_cookie_gen(account_file)
    return True


async def xiaohongshu_cookie_gen(account_file):
    async with async_playwright() as playwright:
        options = {
            'headless': LOCAL_CHROME_HEADLESS
        }
        # Make sure to run headed.
        browser = await playwright.chromium.launch(**options)
        # Setup context however you like.
        context = await browser.new_context()  # Pass any options
        context = await set_init_script(context)
        # Pause the page, and start recording manually.
        page = await context.new_page()
        await page.goto("https://creator.xiaohongshu.com/")
        await page.pause()
        # 鐐瑰嚮璋冭瘯鍣ㄧ殑缁х画锛屼繚瀛榗ookie
        await context.storage_state(path=account_file)


class XiaoHongShuVideo(object):
    def __init__(self, title, file_path, tags, publish_date: datetime, account_file, thumbnail_path=None):
        self.title = title  # 瑙嗛鏍囬
        self.file_path = file_path
        self.tags = tags
        self.publish_date = publish_date
        self.account_file = account_file
        self.date_format = '%Y骞?m鏈?d鏃?%H:%M'
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = resolve_headless(LOCAL_CHROME_HEADLESS)
        self.thumbnail_path = thumbnail_path

    async def set_schedule_time_xiaohongshu(self, page, publish_date):
        print("  [-] 姝ｅ湪璁剧疆瀹氭椂鍙戝竷鏃堕棿...")
        print(f"publish_date: {publish_date}")

        # 浣跨敤鏂囨湰鍐呭瀹氫綅鍏冪礌
        # element = await page.wait_for_selector(
        #     'label:has-text("瀹氭椂鍙戝竷")',
        #     timeout=5000  # 5绉掕秴鏃舵椂闂?        # )
        # await element.click()

        # # 閫夋嫨鍖呭惈鐗瑰畾鏂囨湰鍐呭鐨?label 鍏冪礌
        label_element = page.locator("label:has-text('瀹氭椂鍙戝竷')")
        # # 鍦ㄩ€変腑鐨?label 鍏冪礌涓嬬偣鍑?checkbox
        await label_element.click()
        await asyncio.sleep(1)
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")
        print(f"publish_date_hour: {publish_date_hour}")

        await asyncio.sleep(1)
        await page.locator('.el-input__inner[placeholder="閫夋嫨鏃ユ湡鍜屾椂闂?]').click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(str(publish_date_hour))
        await page.keyboard.press("Enter")

        await asyncio.sleep(1)

    async def handle_upload_error(self, page):
        xiaohongshu_logger.info("video upload error, retrying upload")
        await page.locator('div.progress-div [class^="upload-btn-input"]').set_input_files(self.file_path)

    async def upload(self, playwright: Playwright) -> None:
        browser, context = await create_xhs_context(
            playwright,
            self.account_file,
            self.headless,
            self.local_executable_path,
            viewport={"width": 1600, "height": 900},
        )
        context = await set_init_script(context)

        # create a new page
        page = await context.new_page()
        # 璁块棶鎸囧畾鐨?URL
        await goto_publish_page(
            page,
            "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video",
        )
        xiaohongshu_logger.info(f'[+]姝ｅ湪涓婁紶-------{self.title}.mp4')
        # wait for publish page
        xiaohongshu_logger.info(f'[-] 姝ｅ湪鎵撳紑涓婚〉...')
        await page.wait_for_url("**/publish/publish?**", timeout=30000)
        # 鐐瑰嚮 "涓婁紶瑙嗛" 鎸夐挳
        await page.locator("div[class^='upload-content'] input[class='upload-input']").set_input_files(self.file_path)

        # wait for media upload
        xiaohongshu_logger.info("  [-] 姝ｅ湪绛夊緟瑙嗛涓婁紶...")
        wait_count = 0
        max_wait_time = 300  # 鏈€澶х瓑寰?鍒嗛挓
        last_progress_msg = ""
        
        while wait_count < max_wait_time:
            try:
                # 绛夊緟upload-input鍏冪礌鍑虹幇
                upload_input = await page.wait_for_selector('input.upload-input', timeout=3000)
                # 鑾峰彇涓嬩竴涓厔寮熷厓绱?
                preview_new = await upload_input.query_selector(
                    'xpath=following-sibling::div[contains(@class, "preview-new")]'
                )
                if preview_new:
                    # 鍦╬review-new鍏冪礌涓煡鎵惧寘鍚?涓婁紶鎴愬姛"鐨剆tage鍏冪礌
                    stage_elements = await preview_new.query_selector_all('div.stage')
                    upload_success = False
                    for stage in stage_elements:
                        text_content = await page.evaluate('(element) => element.textContent', stage)
                        if '涓婁紶鎴愬姛' in text_content:
                            upload_success = True
                            break
                        # 灏濊瘯鑾峰彇涓婁紶杩涘害
                        if '%' in text_content and text_content != last_progress_msg:
                            last_progress_msg = text_content
                            xiaohongshu_logger.info(f"  [-] 涓婁紶杩涘害: {text_content.strip()}")
                    if upload_success:
                        xiaohongshu_logger.info("[+] 妫€娴嬪埌涓婁紶鎴愬姛鏍囪瘑!")
                        break
                else:
                    # 姣?绉掕緭鍑轰竴娆＄瓑寰呯姸鎬侊紝鑰屼笉鏄瘡娆￠兘杈撳嚭
                    if wait_count % 5 == 0:
                        xiaohongshu_logger.info(f"  [-] 绛夊緟瑙嗛澶勭悊涓?.. ({wait_count}s)")
                    await asyncio.sleep(1)
                    wait_count += 1
            except Exception as e:
                wait_count += 1
                if wait_count % 10 == 0:
                    xiaohongshu_logger.warning(f"  [-] 绛夊緟涓?.. ({wait_count}s)")
                await asyncio.sleep(0.5)  # 绛夊緟0.5绉掑悗閲嶆柊灏濊瘯
        
        if wait_count >= max_wait_time:
            xiaohongshu_logger.error("upload timed out, check network and page status")
            await context.close()
            if browser:
                await browser.close()
            raise TimeoutError("video upload did not complete in time")

        # wait for publish page widgets to become ready before filling fields
        await asyncio.sleep(2)
        xiaohongshu_logger.info(f'  [-] 姝ｅ湪濉厖鏍囬鍜岃瘽棰?..')
        
        # 灏濊瘯澶氱鏂瑰紡濉厖鏍囬
        title_filled = False
        title_selectors = [
            'div.plugin.title-container input.d-text',
            'input[placeholder*="鏍囬"]',
            'input[placeholder*="title"]',
            '.title-input input',
            'div.title-container input',
        ]
        
        for selector in title_selectors:
            try:
                title_element = page.locator(selector)
                if await title_element.count() > 0:
                    await title_element.first.fill(self.title[:30])
                    title_filled = True
                    xiaohongshu_logger.info(f'  [-] 鏍囬濉厖鎴愬姛 (浣跨敤閫夋嫨鍣? {selector})')
                    break
            except Exception as e:
                continue
        
        # 濡傛灉涓婅堪鏂规硶閮藉け璐ワ紝灏濊瘯浣跨敤 .notranslate 鍏冪礌
        if not title_filled:
            try:
                titlecontainer = page.locator(".notranslate")
                if await titlecontainer.count() > 0:
                    await titlecontainer.first.click()
                    await page.keyboard.press("Control+KeyA")
                    await page.keyboard.press("Delete")
                    await page.keyboard.type(self.title[:30])
                    await page.keyboard.press("Enter")
                    title_filled = True
                    xiaohongshu_logger.info(f'  [-] 鏍囬濉厖鎴愬姛 (浣跨敤 .notranslate)')
            except Exception as e:
                xiaohongshu_logger.warning(f'  [-] 鏍囬濉厖澶辫触: {str(e)}')
        
        # 濉厖璇濋鏍囩
        await asyncio.sleep(1)
        tags_filled = False
        
        # try multiple selectors for content editor/tag input
        tag_selectors = [
            ".ql-editor",
            "[contenteditable='true']",
            "div.desc-input",
            "textarea[placeholder*='鎻忚堪']",
            "div[data-placeholder*='鎻忚堪']",
            ".editor-container [contenteditable]",
        ]
        
        for css_selector in tag_selectors:
            try:
                tag_element = page.locator(css_selector)
                if await tag_element.count() > 0:
                    await tag_element.first.click()
                    await asyncio.sleep(0.5)
                    for index, tag in enumerate(self.tags, start=1):
                        await page.keyboard.type("#" + tag)
                        await page.keyboard.press("Space")
                        await asyncio.sleep(0.3)
                    tags_filled = True
                    xiaohongshu_logger.info(f'鎬诲叡娣诲姞{len(self.tags)}涓瘽棰?(浣跨敤閫夋嫨鍣? {css_selector})')
                    break
            except Exception as e:
                continue
        
        if not tags_filled:
            xiaohongshu_logger.warning(f'  [-] 璇濋濉厖澶辫触锛屽皢璺宠繃璇濋')

        # while True:
        #     # 鍒ゆ柇閲嶆柊涓婁紶鎸夐挳鏄惁瀛樺湪锛屽鏋滀笉瀛樺湪锛屼唬琛ㄨ棰戞鍦ㄤ笂浼狅紝鍒欑瓑寰?        #     try:
        #         #  鏂扮増锛氬畾浣嶉噸鏂颁笂浼?        #         number = await page.locator('[class^="long-card"] div:has-text("閲嶆柊涓婁紶")').count()
        #         if number > 0:
        #             xiaohongshu_logger.success("  [-]瑙嗛涓婁紶瀹屾瘯")
        #             break
        #         else:
        #             xiaohongshu_logger.info("  [-] 姝ｅ湪涓婁紶瑙嗛涓?..")
        #             await asyncio.sleep(2)

        #             if await page.locator('div.progress-div > div:has-text("涓婁紶澶辫触")').count():
        #                 xiaohongshu_logger.error("  [-] 鍙戠幇涓婁紶鍑洪敊浜?.. 鍑嗗閲嶈瘯")
        #                 await self.handle_upload_error(page)
        #     except:
        #         xiaohongshu_logger.info("  [-] 姝ｅ湪涓婁紶瑙嗛涓?..")
        #         await asyncio.sleep(2)
        
        # 涓婁紶瑙嗛灏侀潰
        # await self.set_thumbnail(page, self.thumbnail_path)

        # 鏇存崲鍙鍏冪礌
        # await self.set_location(page, "闈掑矝甯?)

        # # 闋/瑗跨摐
        # third_part_element = '[class^="info"] > [class^="first-part"] div div.semi-switch'
        # # 瀹氫綅鏄惁鏈夌涓夋柟骞冲彴
        # if await page.locator(third_part_element).count():
        #     # 妫€娴嬫槸鍚︽槸宸查€変腑鐘舵€?        #     if 'semi-switch-checked' not in await page.eval_on_selector(third_part_element, 'div => div.className'):
        #         await page.locator(third_part_element).locator('input.semi-switch-native-control').click()

        if self.publish_date != 0:
            await self.set_schedule_time_xiaohongshu(page, self.publish_date)

        # 鍒ゆ柇瑙嗛鏄惁鍙戝竷鎴愬姛
        while True:
            try:
                # click publish button (scheduled or immediate)
                if self.publish_date != 0:
                    await page.locator('button:has-text("瀹氭椂鍙戝竷")').click()
                else:
                    await page.locator('button:has-text("鍙戝竷")').click()
                await page.wait_for_url(
                    "https://creator.xiaohongshu.com/publish/success?**",
                    timeout=3000
                )
                xiaohongshu_logger.success("video publish success")
                break
            except:
                xiaohongshu_logger.info("  [-] 瑙嗛姝ｅ湪鍙戝竷涓?..")
                await page.screenshot(full_page=True)
                await asyncio.sleep(0.5)

        await maybe_save_storage_state(context, self.account_file)
        xiaohongshu_logger.success("cookie updated")
        await asyncio.sleep(2)  # 杩欓噷寤惰繜鏄负浜嗘柟渚跨溂鐫涚洿瑙傜殑瑙傜湅
        # 鍏抽棴娴忚鍣ㄤ笂涓嬫枃鍜屾祻瑙堝櫒瀹炰緥
        await context.close()
        if browser:
            await browser.close()
    
    async def set_thumbnail(self, page: Page, thumbnail_path: str):
        if thumbnail_path:
            await page.click('text="閫夋嫨灏侀潰"')
            await page.wait_for_selector("div.semi-modal-content:visible")
            await page.click('text="璁剧疆绔栧皝闈?')
            await page.wait_for_timeout(2000)
            # 瀹氫綅鍒颁笂浼犲尯鍩熷苟鐐瑰嚮
            await page.locator("div[class^='semi-upload upload'] >> input.semi-upload-hidden-input").set_input_files(thumbnail_path)
            await page.wait_for_timeout(2000)
            await page.locator("div[class^='extractFooter'] button:visible:has-text('瀹屾垚')").click()
            # finish_confirm_element = page.locator("div[class^='confirmBtn'] >> div:has-text('瀹屾垚')")
            # if await finish_confirm_element.count():
            #     await finish_confirm_element.click()
            # await page.locator("div[class^='footer'] button:has-text('瀹屾垚')").click()

    async def set_location(self, page: Page, location: str = "Qingdao"):
        # Location setting is optional; skip on unstable UI variants.
        return True

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)


class XiaoHongShuImage(object):
    """灏忕孩涔﹀浘鏂囩瑪璁板彂甯冪被"""
    
    def __init__(self, title, image_paths, tags, publish_date, account_file, description=""):
        """
        鍒濆鍖栧浘鏂囧彂甯?        
        Args:
            title: 绗旇鏍囬锛堟渶澶?0瀛楋級
            image_paths: 鍥剧墖璺緞鍒楄〃锛堟敮鎸佸寮犲浘鐗囷級
            tags: 璇濋鏍囩鍒楄〃
            publish_date: 鍙戝竷鏃堕棿锛?琛ㄧず绔嬪嵆鍙戝竷锛宒atetime琛ㄧず瀹氭椂鍙戝竷锛?            account_file: cookie鏂囦欢璺緞
            description: 绗旇姝ｆ枃鎻忚堪
        """
        self.title = title
        self.image_paths = image_paths if isinstance(image_paths, list) else [image_paths]
        self.tags = tags
        self.publish_date = publish_date
        self.account_file = account_file
        self.description = description
        self.date_format = '%Y骞?m鏈?d鏃?%H:%M'
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = resolve_headless(LOCAL_CHROME_HEADLESS)

    async def set_schedule_time(self, page, publish_date):
        xiaohongshu_logger.info("  [-] setting scheduled publish time...")

        schedule_toggle_selectors = [
            "label:has-text('定时发布')",
            "text=定时发布",
        ]
        toggled = False
        for selector in schedule_toggle_selectors:
            try:
                toggle = page.locator(selector)
                if await toggle.count() > 0:
                    await toggle.first.click(timeout=5000)
                    toggled = True
                    break
            except Exception:
                continue
        if not toggled:
            raise RuntimeError("cannot find schedule toggle on xiaohongshu publish page")

        await asyncio.sleep(1)

        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")
        xiaohongshu_logger.info(f"  [-] schedule time: {publish_date_hour}")

        datetime_inputs = [
            ".el-input__inner",
            "input[placeholder*='日期']",
            "input[placeholder*='时间']",
        ]
        filled = False
        for selector in datetime_inputs:
            try:
                input_element = page.locator(selector)
                if await input_element.count() == 0:
                    continue
                await input_element.first.click(timeout=3000)
                await page.keyboard.press("Control+KeyA")
                await page.keyboard.type(str(publish_date_hour))
                await page.keyboard.press("Enter")
                filled = True
                break
            except Exception:
                continue

        if not filled:
            raise RuntimeError("cannot find schedule datetime input")
        await asyncio.sleep(1)

    async def upload(self, playwright: Playwright) -> None:
        """鎵ц鍥炬枃涓婁紶"""
        browser, context = await create_xhs_context(
            playwright,
            self.account_file,
            self.headless,
            self.local_executable_path,
            viewport={"width": 1600, "height": 900},
        )
        context = await set_init_script(context)
        
        # 鍒涘缓椤甸潰
        page = await context.new_page()
        
        # 璁块棶鍥炬枃鍙戝竷椤甸潰锛堟敞鎰忥細target=image 鑰屼笉鏄?target=video锛?
        await goto_publish_page(
            page,
            "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image",
        )
        xiaohongshu_logger.info(f'[+] 姝ｅ湪涓婁紶鍥炬枃绗旇-------{self.title}')
        xiaohongshu_logger.info(f'[-] 姝ｅ湪鎵撳紑鍥炬枃鍙戝竷椤甸潰...')

        await page.wait_for_url("**/publish/publish?**", timeout=30000)
        await asyncio.sleep(2)

        # Creator may open on video tab even for target=image. Switch to image tab first.
        tab_switched = False
        tab_selectors = [
            "button:has-text('上传图片')",
            "text=上传图文",
            "a:has-text('上传图文')",
            "button:has-text('上传图文')",
            "div:has-text('上传图文')",
        ]
        for selector in tab_selectors:
            try:
                tab = page.locator(selector)
                if await tab.count() > 0:
                    await tab.first.click()
                    tab_switched = True
                    await asyncio.sleep(1.5)
                    break
            except Exception:
                continue
        if tab_switched:
            xiaohongshu_logger.info("  [-] switched to image publish tab")

        # 涓婁紶鍥剧墖
        xiaohongshu_logger.info(f'  [-] 姝ｅ湪涓婁紶 {len(self.image_paths)} 寮犲浘鐗?..')
        
        # locate image upload input
        upload_selectors = [
            "div[class^='upload-content'] input[class='upload-input']",
            "input[type='file'][accept*='image']",
            "input.upload-input",
        ]
        
        upload_input = None
        for selector in upload_selectors:
            try:
                element = page.locator(selector)
                if await element.count() > 0:
                    upload_input = element.first
                    break
            except:
                continue
        
        if upload_input:
            # upload selected images
            file_paths = [str(p) for p in self.image_paths]
            await upload_input.set_input_files(file_paths)
            xiaohongshu_logger.info(f'  [-] 鍥剧墖宸查€夋嫨锛岀瓑寰呬笂浼犲畬鎴?..')
        else:
            xiaohongshu_logger.error("  [-] 鏈壘鍒板浘鐗囦笂浼犺緭鍏ユ")
            screenshot_path = str(Path(BASE_DIR / "image_upload_input_not_found.png"))
            try:
                await page.screenshot(path=screenshot_path, full_page=True)
            except Exception:
                pass

            is_login_page = False
            try:
                is_login_page = (
                    await page.get_by_text("扫码登录").count() > 0
                    or await page.get_by_text("手机号登录").count() > 0
                )
            except Exception:
                is_login_page = False

            reason = (
                "cookie invalid or login required"
                if is_login_page
                else f"upload input not found, url={page.url}, screenshot={screenshot_path}"
            )
            await context.close()
            if browser:
                await browser.close()
            raise RuntimeError(reason)
        
        # 绛夊緟鍥剧墖涓婁紶瀹屾垚
        await asyncio.sleep(3)
        wait_count = 0
        max_wait = 120  # 鏈€澶х瓑寰?鍒嗛挓
        
        while wait_count < max_wait:
            try:
                # 妫€鏌ユ槸鍚︽湁涓婁紶杩涘害鎴栨垚鍔熸爣璇?                # 鍥剧墖涓婁紶閫氬父浼氭樉绀虹缉鐣ュ浘
                thumbnails = page.locator("div.image-item, div.upload-item, div[class*='preview']")
                if await thumbnails.count() >= len(self.image_paths):
                    xiaohongshu_logger.info("image upload completed")
                    break
                
                if wait_count % 5 == 0:
                    xiaohongshu_logger.info(f'  [-] 绛夊緟鍥剧墖涓婁紶... ({wait_count}s)')
                
                await asyncio.sleep(1)
                wait_count += 1
            except:
                wait_count += 1
                await asyncio.sleep(1)

        if wait_count >= max_wait:
            await context.close()
            if browser:
                await browser.close()
            raise TimeoutError("image upload did not complete in time")
        
        # 濉厖鏍囬
        await asyncio.sleep(2)
        xiaohongshu_logger.info(f'  [-] 姝ｅ湪濉厖鏍囬鍜屽唴瀹?..')
        
        title_filled = False
        title_selectors = [
            'div.plugin.title-container input.d-text',
            'input[placeholder*="鏍囬"]',
            'input[placeholder*="title"]',
            '.title-input input',
            'div.title-container input',
        ]
        
        for selector in title_selectors:
            try:
                title_element = page.locator(selector)
                if await title_element.count() > 0:
                    await title_element.first.fill(self.title[:20])
                    title_filled = True
                    xiaohongshu_logger.info(f'  [-] 鏍囬濉厖鎴愬姛')
                    break
            except:
                continue
        
        if not title_filled:
            try:
                titlecontainer = page.locator(".notranslate")
                if await titlecontainer.count() > 0:
                    await titlecontainer.first.click()
                    await page.keyboard.press("Control+KeyA")
                    await page.keyboard.press("Delete")
                    await page.keyboard.type(self.title[:20])
                    await page.keyboard.press("Enter")
                    title_filled = True
                    xiaohongshu_logger.info(f'  [-] 鏍囬濉厖鎴愬姛 (浣跨敤 .notranslate)')
            except Exception as e:
                xiaohongshu_logger.warning(f'  [-] 鏍囬濉厖澶辫触: {str(e)}')
        
        # fill content and tags
        await asyncio.sleep(1)
        
        content_selectors = [
            ".ql-editor",
            "[contenteditable='true']",
            "div.desc-input",
            "textarea[placeholder*='鎻忚堪']",
            "div[data-placeholder*='鎻忚堪']",
        ]
        
        content_filled = False
        for css_selector in content_selectors:
            try:
                content_element = page.locator(css_selector)
                if await content_element.count() > 0:
                    await content_element.first.click()
                    await asyncio.sleep(0.5)
                    
                    # 濉厖鎻忚堪
                    if self.description:
                        await page.keyboard.type(self.description)
                        await page.keyboard.press("Enter")
                        await asyncio.sleep(0.3)
                    
                    # 濉厖璇濋鏍囩
                    for tag in self.tags:
                        await page.keyboard.type("#" + tag)
                        await page.keyboard.press("Space")
                        await asyncio.sleep(0.3)
                    
                    content_filled = True
                    xiaohongshu_logger.info(
                        f"content filled successfully, tags added: {len(self.tags)}"
                    )
                    break
            except:
                continue
        
        if not content_filled:
            xiaohongshu_logger.warning(f'  [-] 姝ｆ枃濉厖澶辫触锛屽皢璺宠繃')
        
        # 璁剧疆瀹氭椂鍙戝竷锛堝鏋滈渶瑕侊級
        if self.publish_date != 0:
            await self.set_schedule_time(page, self.publish_date)
        
        # 鐐瑰嚮鍙戝竷鎸夐挳
        xiaohongshu_logger.info(f'  [-] 姝ｅ湪鍙戝竷...')

        publish_selectors = (
            ["button:has-text('定时发布')", "button:has-text('发布')", "button.bg-red"]
            if self.publish_date != 0
            else ["button:has-text('发布')", "button.bg-red"]
        )
        publish_deadline = time.monotonic() + 180
        publish_error: Exception | None = None

        while time.monotonic() < publish_deadline:
            try:
                publish_button = None
                for selector in publish_selectors:
                    candidate = page.locator(selector)
                    if await candidate.count() == 0:
                        continue
                    if await candidate.first.is_visible():
                        publish_button = candidate.first
                        break

                if not publish_button:
                    await asyncio.sleep(1)
                    continue

                await publish_button.click(timeout=6000)

                # wait for success page
                try:
                    await page.wait_for_url(
                        "https://creator.xiaohongshu.com/publish/success?**",
                        timeout=10000
                    )
                    xiaohongshu_logger.success("image post publish success")
                    break
                except Exception:
                    pass

                page_text = ""
                try:
                    page_text = await page.evaluate(
                        "() => (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 2000)"
                    )
                except Exception:
                    page_text = ""

                if "验证码" in page_text or "安全验证" in page_text:
                    raise RuntimeError("xiaohongshu publish blocked by verification challenge")

                xiaohongshu_logger.info("  [-] waiting for publish confirmation...")
                await asyncio.sleep(1.5)
            except Exception as error:
                publish_error = error
                xiaohongshu_logger.info("  [-] waiting for publish...")
                try:
                    await page.screenshot(full_page=True)
                except Exception:
                    pass
                await asyncio.sleep(1)
        else:
            raise RuntimeError(f"publish did not finish in time: {publish_error}")
        
        # 淇濆瓨鏇存柊鍚庣殑 cookie
        await maybe_save_storage_state(context, self.account_file)
        xiaohongshu_logger.success("cookie updated")
        
        await asyncio.sleep(2)
        await context.close()
        if browser:
            await browser.close()

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)





