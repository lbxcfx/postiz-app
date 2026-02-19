# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/xhs/login.py
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
import functools
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

from playwright.async_api import BrowserContext, Page
from tenacity import (RetryError, retry, retry_if_result, stop_after_attempt,
                      wait_fixed)

import config
from base.base_crawler import AbstractLogin
from cache.cache_factory import CacheFactory
from tools import utils


class XiaoHongShuLogin(AbstractLogin):

    def __init__(self,
                 login_type: str,
                 browser_context: BrowserContext,
                 context_page: Page,
                 login_phone: Optional[str] = "",
                 cookie_str: str = ""
                 ):
        config.LOGIN_TYPE = login_type
        self.browser_context = browser_context
        self.context_page = context_page
        self.login_phone = login_phone
        self.cookie_str = cookie_str

    def _normalize_phone(self) -> str:
        raw = (self.login_phone or "").strip()
        digits = "".join(ch for ch in raw if ch.isdigit())
        if not digits:
            return raw
        if len(digits) == 13 and digits.startswith("86"):
            return digits[2:]
        if len(digits) > 11:
            return digits[-11:]
        return digits

    def _sms_code_file_path(self) -> Optional[Path]:
        normalized_phone = self._normalize_phone()
        if not normalized_phone:
            return None
        sms_dir = Path(getattr(config, "SMS_CODE_DIR", "./runtime/sms_codes"))
        sms_dir.mkdir(parents=True, exist_ok=True)
        return sms_dir / f"xhs_{normalized_phone}.txt"

    def _read_sms_code_from_file(self) -> Optional[str]:
        file_path = self._sms_code_file_path()
        if not file_path or not file_path.exists():
            return None
        try:
            code = file_path.read_text(encoding="utf-8").strip()
            if not code:
                return None
            normalized_code = "".join(ch for ch in code if ch.isdigit()) or code
            try:
                file_path.unlink()
            except Exception:
                pass
            return normalized_code
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin] Failed to read sms code file: {e}")
            return None

    async def _dump_page_screenshot(self, tag: str) -> None:
        """Capture current page screenshot for selector/debug failures."""
        try:
            screenshot_bytes = await self.context_page.screenshot(type="png")
            debug_dir = Path("./runtime/login_debug")
            debug_dir.mkdir(parents=True, exist_ok=True)
            filename = f"{tag}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            screenshot_path = debug_dir / filename
            screenshot_path.write_bytes(screenshot_bytes)
            html_path = debug_dir / filename.replace(".png", ".html")
            html_path.write_text(await self.context_page.content(), encoding="utf-8")
            utils.logger.info(
                f"[XiaoHongShuLogin.{tag}] browser screenshot saved: {screenshot_path.resolve()}, html saved: {html_path.resolve()}"
            )
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin.{tag}] Failed to take screenshot: {e}")

    async def _detect_access_restriction(self) -> Optional[str]:
        try:
            content = await self.context_page.content()
        except Exception:
            return None

        markers = [
            "IP存在风险",
            "安全限制",
            "300012",
            "请切换可靠网络环境后重试",
        ]
        for marker in markers:
            if marker in content:
                return marker
        return None

    async def _wait_login_container(self):
        selectors = [
            "div.login-container",
            "div[class*='login-container']",
            "xpath=//div[contains(@class,'login-container')]",
            "xpath=//div[contains(@class,'login') and .//input[contains(@placeholder,'手机号')]]",
        ]
        for _ in range(4):
            for selector in selectors:
                try:
                    ele = await self.context_page.wait_for_selector(
                        selector=selector,
                        timeout=2000
                    )
                    if ele:
                        utils.logger.info(
                            f"[XiaoHongShuLogin._wait_login_container] Found login container by selector: {selector}"
                        )
                        return ele
                except Exception:
                    continue
            await asyncio.sleep(0.5)
        return None

    async def _try_click(self, selectors: list[str], step: str) -> bool:
        for selector in selectors:
            try:
                locator = self.context_page.locator(selector)
                count = await locator.count()
                if count <= 0:
                    continue
                for idx in range(min(count, 8)):
                    try:
                        candidate = locator.nth(idx)
                        if not await candidate.is_visible():
                            continue
                        await candidate.click(timeout=2500, force=True)
                        utils.logger.info(
                            f"[XiaoHongShuLogin.{step}] Clicked selector: {selector} (index={idx})"
                        )
                        return True
                    except Exception:
                        continue
                await locator.first.click(timeout=2500, force=True)
                utils.logger.info(
                    f"[XiaoHongShuLogin.{step}] Clicked selector: {selector} (fallback-first)"
                )
                return True
            except Exception:
                continue
        return False

    async def _try_click_login_by_text(self) -> bool:
        try:
            clicked = await self.context_page.evaluate(
                """() => {
                    const elements = Array.from(
                        document.querySelectorAll("button, a, div, span")
                    );
                    const isVisible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };

                    const target = elements.find((el) => {
                        const text = (el.innerText || "").trim();
                        if (!text || text !== "登录") return false;
                        if (!isVisible(el)) return false;
                        return true;
                    });
                    if (!target) return false;
                    target.click();
                    return true;
                }"""
            )
            if clicked:
                utils.logger.info("[XiaoHongShuLogin._try_click_login_by_text] Clicked visible 登录 element")
                return True
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._try_click_login_by_text] Failed: {e}")
        return False

    async def _has_visible_text(self, target_text: str) -> bool:
        try:
            visible = await self.context_page.evaluate(
                """(targetText) => {
                    const normalize = (value) => (value || "").replace(/\\s+/g, "").trim();
                    const wanted = normalize(targetText);
                    if (!wanted) return false;
                    const elements = Array.from(document.querySelectorAll("button, a, div, span"));
                    const isVisible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    for (const el of elements) {
                        if (!isVisible(el)) continue;
                        const text = normalize(el.innerText || el.textContent || "");
                        if (!text) continue;
                        if (text === wanted || text.includes(wanted)) return true;
                    }
                    return false;
                }""",
                target_text,
            )
            return bool(visible)
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._has_visible_text] Failed for text={target_text}: {e}")
        return False

    async def _click_visible_text(self, target_text: str) -> bool:
        try:
            clicked = await self.context_page.evaluate(
                """(targetText) => {
                    const normalize = (value) => (value || "").replace(/\\s+/g, "").trim();
                    const wanted = normalize(targetText);
                    if (!wanted) return false;
                    const elements = Array.from(document.querySelectorAll("button, a, div, span, label"));
                    const isVisible = (el) => {
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const matches = [];
                    for (const el of elements) {
                        if (!isVisible(el)) continue;
                        const text = normalize(el.innerText || el.textContent || "");
                        if (!text || text !== wanted) continue;
                        const rect = el.getBoundingClientRect();
                        const area = rect.width * rect.height;
                        matches.push({ el, rect, area });
                    }
                    matches.sort((a, b) => a.area - b.area);
                    for (const candidate of matches) {
                        const { el, rect } = candidate;
                        const cx = rect.left + rect.width / 2;
                        const cy = rect.top + rect.height / 2;
                        const top = document.elementFromPoint(cx, cy);
                        if (!top) continue;
                        if (!(el === top || el.contains(top) || top.contains(el))) continue;
                        const clickable = el.closest("button, a, [role='button'], [tabindex]") || el;
                        try {
                            clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                            clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                            clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                            clickable.click();
                        } catch (_) {
                            continue;
                        }
                        return true;
                    }
                    return false;
                }""",
                target_text,
            )
            if clicked:
                utils.logger.info(f"[XiaoHongShuLogin._click_visible_text] Clicked visible text: {target_text}")
                return True
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._click_visible_text] Failed for text={target_text}: {e}")
        return False

    async def _reset_auth_state_for_phone_login(self) -> None:
        try:
            await self.browser_context.clear_cookies()
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._reset_auth_state_for_phone_login] clear_cookies failed: {e}")

        try:
            await self.context_page.evaluate(
                """() => {
                    try { localStorage.clear(); } catch (_) {}
                    try { sessionStorage.clear(); } catch (_) {}
                }"""
            )
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._reset_auth_state_for_phone_login] storage clear failed: {e}")

        try:
            await self.context_page.goto("https://www.xiaohongshu.com/explore")
            await asyncio.sleep(1)
            utils.logger.info("[XiaoHongShuLogin._reset_auth_state_for_phone_login] Reset auth state and reloaded page")
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._reset_auth_state_for_phone_login] reload failed: {e}")

    async def _handle_read_agreement_dialog(self) -> bool:
        """
        Handle XHS secondary agreement dialog:
        '阅读并同意' -> '同意并继续'
        """
        try:
            dialog_visible = await self._has_visible_text("同意并继续")
            if not dialog_visible:
                return False
            for _ in range(3):
                clicked = await self._click_visible_text("同意并继续")
                if not clicked:
                    clicked = await self._try_click(
                        selectors=[
                            "button:has-text('同意并继续')",
                            "xpath=//button[normalize-space(text())='同意并继续']",
                            "xpath=//*[normalize-space(text())='同意并继续']",
                        ],
                        step="agree_continue_dialog",
                    )
                if clicked:
                    await asyncio.sleep(0.35)
                    still_visible = await self._has_visible_text("同意并继续")
                    if not still_visible:
                        utils.logger.info(
                            "[XiaoHongShuLogin._handle_read_agreement_dialog] Dialog dismissed by 同意并继续"
                        )
                        return True
                await asyncio.sleep(0.15)
            utils.logger.warning(
                "[XiaoHongShuLogin._handle_read_agreement_dialog] Agreement dialog still visible after click attempts"
            )
        except Exception as e:
            utils.logger.debug(
                f"[XiaoHongShuLogin._handle_read_agreement_dialog] Failed: {e}"
            )
        return False

    async def _dismiss_known_blockers(self, rounds: int = 2) -> bool:
        dismissed = False
        for _ in range(rounds):
            handled = await self._handle_read_agreement_dialog()
            if not handled:
                break
            dismissed = True
            await asyncio.sleep(0.3)
        return dismissed

    async def _best_effort_click_agreement(self, step: str = "agreement_best_effort") -> bool:
        """
        Best-effort click agreement checkbox area, without using it as a strict blocker.
        This keeps backend from hard-verifying agreement while still improving SMS trigger success.
        """
        clicked = await self._try_click(
            selectors=[
                "xpath=//div[contains(@class,'agreements')]//label",
                "xpath=//div[contains(@class,'agreements')]//*[local-name()='svg']",
                "xpath=//div[contains(@class,'agreements')]//span",
                "div.login-container div.agreements",
            ],
            step=step,
        )
        hotspot_clicked = await self._click_agreement_hotspot(step=f"{step}_hotspot")
        if clicked or hotspot_clicked:
            await asyncio.sleep(0.15)
        return bool(clicked or hotspot_clicked)

    async def _is_agreement_checked(self) -> bool:
        try:
            checked = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const hasVisualChecked = (agreement) => {
                        if (!agreement) return false;
                        return !!agreement.querySelector(
                            "[aria-checked='true'], [role='checkbox'][aria-checked='true'], [role='checkbox'][data-state='checked'], .checked, .is-checked"
                        );
                    };

                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const phoneInput = container.querySelector("input[placeholder*='手机号']");
                        const codeInput = container.querySelector("input[placeholder*='验证码']");
                        if (!phoneInput || !codeInput) continue;

                        const agreement = container.querySelector("div.agreements");
                        if (!agreement || !isVisible(agreement)) continue;

                        const input = agreement.querySelector("input[type='checkbox']");
                        if (input) return !!input.checked;
                        if (hasVisualChecked(agreement)) return true;
                        return false;
                    }
                    return false;
                }"""
            )
            return bool(checked)
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._is_agreement_checked] Failed: {e}")
        return False

    async def _ensure_agreement_checked(self) -> bool:
        checkbox_selectors = [
            "xpath=//div[contains(@class,'agreements')]//input[@type='checkbox']",
            "div.agreements input[type='checkbox']",
        ]
        if await self._is_agreement_checked():
            return True

        for attempt in range(1, 4):
            for selector in checkbox_selectors:
                try:
                    locator = self.context_page.locator(selector).first
                    if await locator.count() <= 0:
                        continue
                    checked = await locator.is_checked()
                    if not checked:
                        await locator.click(timeout=2500, force=True)
                        await asyncio.sleep(0.2)
                    if await locator.is_checked():
                        return True
                except Exception:
                    continue

            if await self._is_agreement_checked():
                return True

            clicked = await self._try_click(
                selectors=[
                    "xpath=//div[contains(@class,'agreements')]//label",
                    "xpath=//div[contains(@class,'agreements')]//*[local-name()='svg']",
                    "xpath=//div[contains(@class,'agreements')]//span",
                    "div.login-container div.agreements",
                ],
                step=f"agree_checkbox_fallback_{attempt}",
            )
            hotspot_clicked = False
            if not clicked and not await self._is_agreement_checked():
                hotspot_clicked = await self._click_agreement_hotspot(
                    step=f"agreement_hotspot_{attempt}"
                )
            if clicked or hotspot_clicked:
                await asyncio.sleep(0.2)

            if await self._is_agreement_checked():
                return True

            if await self._force_check_agreement():
                return True

        return False

    async def _force_check_agreement(self) -> bool:
        try:
            result = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const hasVisualChecked = (agreement) => {
                        if (!agreement) return false;
                        return !!agreement.querySelector(
                            "[aria-checked='true'], [role='checkbox'][aria-checked='true'], [role='checkbox'][data-state='checked'], .checked, .is-checked"
                        );
                    };
                    const clickNode = (node) => {
                        if (!node || !isVisible(node)) return false;
                        const clickable = node.closest("label, button, [role='checkbox'], [role='button'], [tabindex], div") || node;
                        try {
                            clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                            clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                            clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                            if (typeof clickable.click === "function") clickable.click();
                            return true;
                        } catch (_) {
                            return false;
                        }
                    };

                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    let clickedAny = false;
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const agreement = container.querySelector("div.agreements");
                        if (!agreement || !isVisible(agreement)) continue;

                        const input = agreement.querySelector("input[type='checkbox']");
                        if (input && input.checked) return { checked: true, clicked: clickedAny };
                        if (!input && hasVisualChecked(agreement)) return { checked: true, clicked: clickedAny };

                        const candidates = [
                            agreement.querySelector("input[type='checkbox']"),
                            agreement.querySelector("label"),
                            agreement.querySelector("svg"),
                            agreement.querySelector("span"),
                            agreement,
                        ];
                        for (const node of candidates) {
                            if (!node) continue;
                            if (clickNode(node)) {
                                clickedAny = true;
                                break;
                            }
                        }

                        if (input && input.checked) return { checked: true, clicked: clickedAny };
                        if (!input && hasVisualChecked(agreement)) return { checked: true, clicked: clickedAny };

                        const rect = agreement.getBoundingClientRect();
                        const probeX = rect.left + Math.min(14, Math.max(6, rect.width * 0.08));
                        const probeY = rect.top + rect.height / 2;
                        const top = document.elementFromPoint(probeX, probeY);
                        if (top) {
                            if (clickNode(top)) clickedAny = true;
                            if (input && input.checked) return { checked: true, clicked: clickedAny };
                            if (!input && hasVisualChecked(agreement)) return { checked: true, clicked: clickedAny };
                        }
                    }
                    return { checked: false, clicked: clickedAny };
                }"""
            )
            checked = bool(result.get("checked")) if isinstance(result, dict) else bool(result)
            clicked = bool(result.get("clicked")) if isinstance(result, dict) else False
            if checked:
                utils.logger.info("[XiaoHongShuLogin._force_check_agreement] Agreement checked by evaluate")
            elif clicked:
                utils.logger.info("[XiaoHongShuLogin._force_check_agreement] Agreement click dispatched by evaluate")
            return checked
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._force_check_agreement] Failed: {e}")
        return False

    async def _click_agreement_hotspot(self, step: str = "agreement_hotspot") -> bool:
        try:
            clicked = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const clickAt = (x, y) => {
                        const target = document.elementFromPoint(x, y);
                        if (!target) return false;
                        const clickable = target.closest("label, button, [role='checkbox'], [role='button'], [tabindex], div, span") || target;
                        try {
                            clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                            clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                            clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                            if (typeof clickable.click === "function") clickable.click();
                            return true;
                        } catch (_) {
                            return false;
                        }
                    };

                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const phoneInput = container.querySelector("input[placeholder*='手机号']");
                        const codeInput = container.querySelector("input[placeholder*='验证码']");
                        if (!phoneInput || !codeInput) continue;

                        const agreement = container.querySelector("div.agreements");
                        if (!agreement || !isVisible(agreement)) continue;

                        const input = agreement.querySelector("input[type='checkbox']");
                        if (input && input.checked) return false;

                        const rect = agreement.getBoundingClientRect();
                        const x = rect.left + Math.min(10, Math.max(6, rect.width * 0.06));
                        const y = rect.top + rect.height * 0.5;
                        if (clickAt(x, y)) return true;
                    }
                    return false;
                }"""
            )
            if clicked:
                utils.logger.info(
                    f"[XiaoHongShuLogin._click_agreement_hotspot] Clicked agreement hotspot step={step}"
                )
                return True
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._click_agreement_hotspot] Failed: {e}")
        return False

    async def _is_phone_login_dialog_visible(self) -> bool:
        try:
            visible = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const text = (container.innerText || "").replace(/\\s+/g, "");
                        if (text.includes("手机号登录") || text.includes("输入验证码")) {
                            return true;
                        }
                        const phoneInput = container.querySelector("input[placeholder*='手机号']");
                        const codeInput = container.querySelector("input[placeholder*='验证码']");
                        if (phoneInput && codeInput) return true;
                    }
                    return false;
                }"""
            )
            return bool(visible)
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._is_phone_login_dialog_visible] Failed: {e}")
        return False

    async def _click_phone_submit_button(self, step: str = "phone_submit") -> bool:
        selectors = [
            "xpath=//div[contains(@class,'login-container')]//button[normalize-space(.)='登录']",
            "div.login-container button:has-text('登录')",
            "div.input-container > button",
            "button:has-text('登录')",
        ]
        if await self._try_click(selectors=selectors, step=step):
            return True

        try:
            clicked = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const buttons = Array.from(container.querySelectorAll("button"));
                        for (const btn of buttons) {
                            if (!isVisible(btn)) continue;
                            if ((btn.innerText || "").replace(/\\s+/g, "") !== "登录") continue;
                            if (btn.disabled) continue;
                            btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                            btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                            btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
            if clicked:
                utils.logger.info(f"[XiaoHongShuLogin._click_phone_submit_button] Clicked by evaluate step={step}")
                return True
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._click_phone_submit_button] evaluate failed: {e}")

        try:
            await self.context_page.keyboard.press("Enter")
            utils.logger.info(f"[XiaoHongShuLogin._click_phone_submit_button] Pressed Enter step={step}")
            return True
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._click_phone_submit_button] Enter fallback failed: {e}")
        return False

    async def _is_phone_submit_processing(self) -> bool:
        try:
            loading = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const buttons = Array.from(container.querySelectorAll("button"));
                        for (const btn of buttons) {
                            if (!isVisible(btn)) continue;
                            const txt = (btn.innerText || "").replace(/\\s+/g, "");
                            if (txt.includes("验证中") || txt.includes("登录中") || txt.includes("处理中")) {
                                return true;
                            }
                        }
                    }
                    return false;
                }"""
            )
            return bool(loading)
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._is_phone_submit_processing] Failed: {e}")
        return False

    async def _click_send_sms_button(self, step: str = "sms_send") -> bool:
        selectors = [
            "xpath=//div[contains(@class,'login-container')]//label[contains(@class,'auth-code')]//*[contains(normalize-space(.),'获取验证码')]",
            "xpath=//div[contains(@class,'login-container')]//button[contains(normalize-space(.),'获取验证码')]",
            "div.login-container label.auth-code > span",
            "div.login-container span:has-text('获取验证码')",
            "div.login-container button:has-text('获取验证码')",
        ]
        if await self._try_click(selectors=selectors, step=step):
            return True

        try:
            clicked = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const normalize = (txt) => (txt || "").replace(/\\s+/g, "");
                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const phoneInput = container.querySelector("input[placeholder*='手机号']");
                        const codeInput = container.querySelector("input[placeholder*='验证码']");
                        if (!phoneInput || !codeInput) continue;
                        const candidates = Array.from(
                            container.querySelectorAll("label.auth-code > span, label.auth-code > button, button, span")
                        );
                        for (const candidate of candidates) {
                            if (!isVisible(candidate)) continue;
                            const text = normalize(candidate.innerText || candidate.textContent || "");
                            if (!text || !text.includes("获取验证码")) continue;
                            const clickable = candidate.closest("button, label, [role='button'], [tabindex]") || candidate;
                            if ("disabled" in clickable && clickable.disabled) continue;
                            try {
                                clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                                clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                                clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                                clickable.click();
                                return true;
                            } catch (_) {
                                continue;
                            }
                        }
                    }
                    return false;
                }"""
            )
            if clicked:
                utils.logger.info(f"[XiaoHongShuLogin._click_send_sms_button] Clicked by evaluate step={step}")
                return True
        except Exception as e:
            utils.logger.debug(f"[XiaoHongShuLogin._click_send_sms_button] evaluate failed: {e}")

        return False

    def _is_sms_send_confirmed(self, button_text: str) -> bool:
        normalized = re.sub(r"\s+", "", button_text or "")
        if not normalized:
            return False
        if normalized in {"获取验证码", "+86"}:
            return False
        if re.fullmatch(r"\+?\d{1,3}", normalized):
            return False
        if re.search(r"\d{1,3}\s*(s|S|秒)", normalized):
            return True
        if re.fullmatch(r"\d{1,3}", normalized):
            return True
        if "重发" in normalized or "重新发送" in normalized:
            return True
        return False

    async def _get_sms_button_text(self, login_container_ele) -> str:
        try:
            text = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const normalize = (txt) => (txt || "").replace(/\\s+/g, "");
                    const containers = Array.from(document.querySelectorAll("div.login-container"));
                    for (const container of containers) {
                        if (!isVisible(container)) continue;
                        const phoneInput = container.querySelector("input[placeholder*='手机号']");
                        const codeInput = container.querySelector("input[placeholder*='验证码']");
                        if (!phoneInput || !codeInput) continue;
                        const authScopes = Array.from(
                            container.querySelectorAll("label.auth-code, .auth-code")
                        );
                        for (const scope of authScopes) {
                            if (!isVisible(scope)) continue;
                            const nodes = Array.from(scope.querySelectorAll("span, button, div"));
                            for (const node of nodes) {
                                if (!isVisible(node)) continue;
                                const txt = normalize(node.innerText || node.textContent || "");
                                if (!txt) continue;
                                if (txt === "+86" || /^\\+?\\d{1,3}$/.test(txt)) continue;
                                if (
                                    txt.includes("获取验证码") ||
                                    txt.includes("重发") ||
                                    txt.includes("重新发送") ||
                                    /\\d{1,3}\\s*(s|S|秒)/.test(txt) ||
                                    /^\\d{1,3}$/.test(txt)
                                ) {
                                    return txt;
                                }
                            }
                        }
                    }
                    return "";
                }"""
            )
            if text:
                return str(text).strip()
        except Exception:
            pass

        selectors = [
            "label.auth-code > span",
            "label.auth-code > button",
            "label.auth-code",
            "span:has-text('获取验证码')",
            "button:has-text('获取验证码')",
        ]
        for selector in selectors:
            try:
                ele = await login_container_ele.query_selector(selector)
                if not ele:
                    ele = await self.context_page.query_selector(selector)
                if not ele:
                    continue
                txt = (await ele.inner_text() or "").strip()
                compact_txt = re.sub(r"\s+", "", txt)
                if compact_txt and (compact_txt == "+86" or re.fullmatch(r"\+?\d{1,3}", compact_txt)):
                    continue
                if txt:
                    return txt
            except Exception:
                continue
        return ""

    def _extract_sms_block_reason(self, page_text: str) -> Optional[str]:
        text = page_text or ""
        markers = [
            ("请通过验证", "captcha/verification"),
            ("安全验证", "captcha/verification"),
            ("操作频繁", "rate_limited"),
            ("发送频繁", "rate_limited"),
            ("IP存在风险", "ip_restricted"),
            ("安全限制", "ip_restricted"),
            ("300012", "ip_restricted"),
        ]
        for marker, reason in markers:
            if marker in text:
                return reason
        return None

    def _extract_login_submit_block_reason(self, page_text: str) -> Optional[str]:
        text = page_text or ""
        markers = [
            ("验证码错误", "invalid_sms_code"),
            ("验证码有误", "invalid_sms_code"),
            ("验证码失效", "expired_sms_code"),
            ("验证码过期", "expired_sms_code"),
            ("请重新获取验证码", "expired_sms_code"),
            ("请通过验证", "captcha/verification"),
            ("安全验证", "captcha/verification"),
            ("操作频繁", "rate_limited"),
            ("IP存在风险", "ip_restricted"),
            ("安全限制", "ip_restricted"),
            ("300012", "ip_restricted"),
            ("登录频繁", "rate_limited"),
            ("稍后再试", "rate_limited"),
        ]
        for marker, reason in markers:
            if marker in text:
                return reason
        return None

    async def _extract_sms_block_reason_from_visible_text(self) -> Optional[str]:
        try:
            visible_text = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const nodes = Array.from(
                        document.querySelectorAll("div, span, p, button, a, label")
                    );
                    let text = "";
                    for (const node of nodes) {
                        if (!isVisible(node)) continue;
                        const t = (node.innerText || node.textContent || "").trim();
                        if (!t) continue;
                        text += ` ${t}`;
                        if (text.length > 4000) break;
                    }
                    return text;
                }"""
            )
            reason = self._extract_sms_block_reason(visible_text or "")
            if reason:
                return reason
        except Exception:
            pass
        return None

    async def _extract_login_submit_block_reason_from_visible_text(self) -> Optional[str]:
        try:
            visible_text = await self.context_page.evaluate(
                """() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);
                        return (
                            rect.width > 0 &&
                            rect.height > 0 &&
                            style.visibility !== "hidden" &&
                            style.display !== "none"
                        );
                    };
                    const nodes = Array.from(
                        document.querySelectorAll("div, span, p, button, a, label")
                    );
                    let text = "";
                    for (const node of nodes) {
                        if (!isVisible(node)) continue;
                        const t = (node.innerText || node.textContent || "").trim();
                        if (!t) continue;
                        text += ` ${t}`;
                        if (text.length > 4000) break;
                    }
                    return text;
                }"""
            )
            reason = self._extract_login_submit_block_reason(visible_text or "")
            if reason:
                return reason
        except Exception:
            pass
        return None

    @retry(stop=stop_after_attempt(600), wait=wait_fixed(1), retry=retry_if_result(lambda value: value is False))
    async def check_login_state(self, no_logged_in_session: str, no_logged_in_a1: str = "") -> bool:
        """
            Check if the current login status is successful and return True otherwise return False
            retry decorator will retry 600 times if the return value is False, and the retry interval is 1 second
            if max retry times reached, raise RetryError
        """
        # Periodic screenshot for debugging
        loop_count = getattr(self, '_check_loop_count', 0)
        self._check_loop_count = loop_count + 1
        
        if self._check_loop_count % 5 == 0:
            try:
                if self._check_loop_count % 20 == 0:
                    await self._dump_page_screenshot("check_login_state")
            except Exception as e:
                utils.logger.debug(f"Failed to take browser screenshot: {e}")

        page_content = await self.context_page.content()
        if "请通过验证" in page_content:
            utils.logger.info("[XiaoHongShuLogin.check_login_state] CAPTCHA or verification detected on page")
        dismissed = await self._dismiss_known_blockers(rounds=2)
        if not dismissed and await self._has_visible_text("同意并继续"):
            stuck = getattr(self, "_agreement_dialog_stuck_count", 0) + 1
            self._agreement_dialog_stuck_count = stuck
            if stuck >= 15:
                raise RuntimeError("agreement_dialog_stuck")
        else:
            self._agreement_dialog_stuck_count = 0

        if config.LOGIN_TYPE == "phone":
            submit_reason = await self._extract_login_submit_block_reason_from_visible_text()
            if not submit_reason:
                submit_reason = self._extract_login_submit_block_reason(page_content)
            if submit_reason in {"invalid_sms_code", "expired_sms_code", "captcha/verification", "rate_limited", "ip_restricted"}:
                raise RuntimeError(f"phone_login_blocked:{submit_reason}")
            if dismissed:
                if await self._click_phone_submit_button(step="sms_submit_retry_after_agreement"):
                    submit_attempts = int(getattr(self, "_phone_submit_attempts", 0)) + 1
                    self._phone_submit_attempts = submit_attempts
                    self._phone_submit_last_retry_loop = self._check_loop_count
                    utils.logger.info(
                        f"[XiaoHongShuLogin.check_login_state] SMS_SUBMIT_RETRY_AFTER_AGREEMENT attempt={submit_attempts}"
                    )
                    await asyncio.sleep(0.35)
                    await self._dismiss_known_blockers(rounds=2)

            if getattr(self, "_phone_submit_loop_start", None) is None:
                self._phone_submit_loop_start = self._check_loop_count

            dialog_visible = await self._is_phone_login_dialog_visible()
            loading = await self._is_phone_submit_processing()
            if dialog_visible:
                elapsed_loops = self._check_loop_count - int(getattr(self, "_phone_submit_loop_start", self._check_loop_count))
                last_retry_loop = int(getattr(self, "_phone_submit_last_retry_loop", 0))
                submit_attempts = int(getattr(self, "_phone_submit_attempts", 1))

                if not loading and (self._check_loop_count - last_retry_loop) >= 15 and submit_attempts < 4:
                    if await self._click_phone_submit_button(step="sms_submit_retry_watchdog"):
                        submit_attempts += 1
                        self._phone_submit_attempts = submit_attempts
                        self._phone_submit_last_retry_loop = self._check_loop_count
                        utils.logger.info(
                            f"[XiaoHongShuLogin.check_login_state] SMS_SUBMIT_RETRY_WATCHDOG attempt={submit_attempts}"
                        )
                        await asyncio.sleep(0.35)
                        await self._dismiss_known_blockers(rounds=2)

                if elapsed_loops >= 45 and submit_attempts >= 2 and not loading:
                    raise RuntimeError("phone_login_blocked:submit_no_effect")

        current_cookie = await self.browser_context.cookies()
        _, cookie_dict = utils.convert_cookies(current_cookie)
        current_web_session = cookie_dict.get("web_session") or ""
        current_a1 = cookie_dict.get("a1") or ""
        baseline_session = no_logged_in_session or ""
        baseline_a1 = no_logged_in_a1 or ""
        
        if self._check_loop_count % 10 == 0:
            utils.logger.info(
                f"[XiaoHongShuLogin.check_login_state] Watching for auth cookie change... Current web_session: {current_web_session}, a1: {current_a1}"
            )

        if (
            (current_web_session and current_web_session != baseline_session)
            or (current_a1 and current_a1 != baseline_a1)
        ):
            utils.logger.info(
                f"[XiaoHongShuLogin.check_login_state] Login successful! Auth cookies changed: web_session={current_web_session}, a1={current_a1}"
            )
            return True
        return False

    async def begin(self):
        """Start login xiaohongshu"""
        utils.logger.info("[XiaoHongShuLogin.begin] Begin login xiaohongshu ...")
        if config.LOGIN_TYPE == "qrcode":
            await self.login_by_qrcode()
        elif config.LOGIN_TYPE == "phone":
            await self.login_by_mobile()
        elif config.LOGIN_TYPE == "cookie":
            await self.login_by_cookies()
        else:
            raise ValueError("[XiaoHongShuLogin.begin]I nvalid Login Type Currently only supported qrcode or phone or cookies ...")

    async def login_by_mobile(self):
        """Login xiaohongshu by mobile"""
        utils.logger.info("[XiaoHongShuLogin.login_by_mobile] Begin login xiaohongshu by mobile ...")
        normalized_phone = self._normalize_phone()
        if not normalized_phone:
            utils.logger.error("[XiaoHongShuLogin.login_by_mobile] Missing login phone number")
            sys.exit()
        await asyncio.sleep(1)
        restriction = await self._detect_access_restriction()
        if restriction:
            utils.logger.error(
                f"[XiaoHongShuLogin.login_by_mobile] XHS access restricted before login flow, marker={restriction}"
            )
            await self._dump_page_screenshot("login_by_mobile_access_restricted")
            sys.exit()
        login_container_ele = await self._wait_login_container()
        if not login_container_ele:
            clicked_login = await self._try_click(
                selectors=[
                    "xpath=//*[@id='app']/div[1]/div[2]/div[1]/ul/div[1]/button",
                    ".side-bar-component.login-btn button",
                    "button.login-btn",
                    "span.login-btn",
                    "div.login-btn",
                    "button:has-text('登录')",
                    "a:has-text('登录')",
                    "xpath=//button[contains(.,'登录')]",
                ],
                step="open_login_dialog",
            )
            if not clicked_login:
                clicked_login = await self._try_click_login_by_text()
            if not clicked_login:
                await self._reset_auth_state_for_phone_login()
                clicked_login = await self._try_click(
                    selectors=[
                        ".side-bar-component.login-btn button",
                        "button.login-btn",
                        "span.login-btn",
                        "div.login-btn",
                        "button:has-text('登录')",
                        "a:has-text('登录')",
                        "xpath=//button[contains(.,'登录')]",
                    ],
                    step="open_login_dialog_after_reset",
                )
                if not clicked_login:
                    clicked_login = await self._try_click_login_by_text()
            await asyncio.sleep(1)
            login_container_ele = await self._wait_login_container()
        if not login_container_ele:
            utils.logger.error("[XiaoHongShuLogin.login_by_mobile] login dialog was not found")
            restriction = await self._detect_access_restriction()
            if restriction:
                utils.logger.error(
                    f"[XiaoHongShuLogin.login_by_mobile] XHS access restricted, marker={restriction}"
                )
            await self._dump_page_screenshot("login_by_mobile_no_dialog")
            sys.exit()

        # Some versions default to QR tab and require switching to phone login tab.
        await self._try_click(
            selectors=[
                "xpath=//div[contains(@class,'login-container')]//div[contains(@class,'other-method')]/div[1]",
                "xpath=//div[contains(@class,'login-container')]//*[contains(text(),'手机号登录')]",
            ],
            step="switch_to_phone_tab",
        )

        await asyncio.sleep(0.5)
        input_ele = await login_container_ele.query_selector("label.phone > input")
        if not input_ele:
            input_ele = await login_container_ele.query_selector("input[placeholder*='手机号']")
        if not input_ele:
            input_ele = await self.context_page.query_selector("input[placeholder*='手机号']")
        if not input_ele:
            utils.logger.error("[XiaoHongShuLogin.login_by_mobile] phone input not found")
            await self._dump_page_screenshot("login_by_mobile_no_phone_input")
            sys.exit()

        await input_ele.fill(normalized_phone)
        await asyncio.sleep(0.5)

        # Do a best-effort agreement click before sending SMS, but do not hard-verify/block on it.
        await self._best_effort_click_agreement(step="sms_send_pre_agreement")
        await self._dismiss_known_blockers(rounds=2)

        sms_send_confirmed = False
        sms_btn_text_after_click = ""
        block_reason: Optional[str] = None
        for send_attempt in range(1, 4):
            await self._best_effort_click_agreement(step=f"sms_send_agreement_{send_attempt}")
            await self._dismiss_known_blockers(rounds=2)

            if not await self._click_send_sms_button(step=f"sms_send_attempt_{send_attempt}"):
                utils.logger.warning(
                    f"[XiaoHongShuLogin.login_by_mobile] SMS send button click failed attempt={send_attempt}"
                )
                continue

            utils.logger.info(f"[XiaoHongShuLogin.login_by_mobile] SMS_SEND_CLICKED attempt={send_attempt}")
            await asyncio.sleep(1.0)
            await self._dismiss_known_blockers(rounds=3)
            await asyncio.sleep(0.25)

            sms_btn_text_after_click = await self._get_sms_button_text(login_container_ele)
            if sms_btn_text_after_click:
                if self._is_sms_send_confirmed(sms_btn_text_after_click):
                    sms_send_confirmed = True
                    utils.logger.info(
                        f"[XiaoHongShuLogin.login_by_mobile] SMS_SEND_CONFIRMED attempt={send_attempt} button_text={sms_btn_text_after_click}"
                    )
                    break
                utils.logger.info(
                    f"[XiaoHongShuLogin.login_by_mobile] SMS_SEND_STATE attempt={send_attempt} button_text={sms_btn_text_after_click}"
                )

            page_text = await self.context_page.content()
            block_reason = await self._extract_sms_block_reason_from_visible_text()
            if not block_reason:
                block_reason = self._extract_sms_block_reason(page_text)
            if block_reason:
                utils.logger.warning(
                    f"[XiaoHongShuLogin.login_by_mobile] SMS send may be blocked by {block_reason}"
                )
                if block_reason in {"captcha/verification", "rate_limited", "ip_restricted"}:
                    break

        page_text = await self.context_page.content()
        block_reason = block_reason or await self._extract_sms_block_reason_from_visible_text()
        if not block_reason:
            block_reason = self._extract_sms_block_reason(page_text)
        if ("IP存在风险" in page_text) or ("安全限制" in page_text) or ("300012" in page_text):
            utils.logger.error("[XiaoHongShuLogin.login_by_mobile] XHS access restricted after sms click")
        if ("请通过验证" in page_text) or ("安全验证" in page_text):
            utils.logger.warning("[XiaoHongShuLogin.login_by_mobile] SMS send may be blocked by captcha/verification")

        if not sms_send_confirmed:
            final_reason = block_reason or "sms_send_no_effect"
            utils.logger.error(
                f"[XiaoHongShuLogin.login_by_mobile] phone_login_blocked:{final_reason}"
            )
            await self._dump_page_screenshot("login_by_mobile_sms_send_not_confirmed")
            sys.exit(1)

        sms_code_input_ele = await login_container_ele.query_selector("label.auth-code > input")
        if not sms_code_input_ele:
            sms_code_input_ele = await login_container_ele.query_selector("input[placeholder*='验证码']")
        if not sms_code_input_ele:
            sms_code_input_ele = await self.context_page.query_selector("input[placeholder*='验证码']")
        if not sms_code_input_ele:
            utils.logger.error("[XiaoHongShuLogin.login_by_mobile] sms code input not found")
            await self._dump_page_screenshot("login_by_mobile_no_sms_input")
            sys.exit()

        submit_btn_ele = await login_container_ele.query_selector("div.input-container > button")
        if not submit_btn_ele:
            submit_btn_ele = await login_container_ele.query_selector("button:has-text('登录')")
        if not submit_btn_ele:
            submit_btn_ele = await self.context_page.query_selector("button:has-text('登录')")
        if not submit_btn_ele:
            utils.logger.error("[XiaoHongShuLogin.login_by_mobile] login submit button not found")
            await self._dump_page_screenshot("login_by_mobile_no_submit_button")
            sys.exit()
        cache_client = CacheFactory.create_cache(config.CACHE_TYPE_MEMORY)
        max_get_sms_code_time = 60 * 2  # Maximum time to get verification code is 2 minutes
        no_logged_in_session = ""
        no_logged_in_a1 = ""
        while max_get_sms_code_time > 0:
            utils.logger.info(
                f"[XiaoHongShuLogin.login_by_mobile] SMS_CODE_REQUIRED phone={normalized_phone} remaining={max_get_sms_code_time}s"
            )
            await asyncio.sleep(1)
            sms_code_key = f"xhs_{normalized_phone}"
            sms_code_value = cache_client.get(sms_code_key)
            sms_code = sms_code_value.decode().strip() if sms_code_value else ""
            if not sms_code:
                sms_code = self._read_sms_code_from_file() or ""
            if not sms_code:
                max_get_sms_code_time -= 1
                continue

            current_cookie = await self.browser_context.cookies()
            _, cookie_dict = utils.convert_cookies(current_cookie)
            no_logged_in_session = cookie_dict.get("web_session") or ""
            no_logged_in_a1 = cookie_dict.get("a1") or ""

            await sms_code_input_ele.fill(value=sms_code)  # Enter SMS verification code
            await asyncio.sleep(0.5)

            await self._dismiss_known_blockers(rounds=2)
            submit_clicked = await self._click_phone_submit_button(step="sms_submit")
            if not submit_clicked:
                await submit_btn_ele.click()
            self._phone_submit_attempts = 1
            self._phone_submit_last_retry_loop = 0
            self._phone_submit_loop_start = None
            utils.logger.info("[XiaoHongShuLogin.login_by_mobile] SMS_SUBMIT_CLICKED attempt=1")
            await asyncio.sleep(0.5)
            dismissed_after_submit = await self._dismiss_known_blockers(rounds=5)
            if dismissed_after_submit:
                if await self._click_phone_submit_button(step="sms_submit_retry_after_agreement"):
                    self._phone_submit_attempts = 2
                    utils.logger.info("[XiaoHongShuLogin.login_by_mobile] SMS_SUBMIT_RETRY_AFTER_AGREEMENT attempt=2")
                    await asyncio.sleep(0.5)
                    await self._dismiss_known_blockers(rounds=3)

            # TODO: Should also check if the verification code is correct, as it may be incorrect
            break

        if max_get_sms_code_time <= 0:
            utils.logger.info("[XiaoHongShuLogin.login_by_mobile] Did not receive sms code in time, exit login flow")
            sys.exit()

        try:
            await self.check_login_state(no_logged_in_session, no_logged_in_a1)
        except RetryError:
            utils.logger.info("[XiaoHongShuLogin.login_by_mobile] Login xiaohongshu failed by mobile login method ...")
            sys.exit(1)
        except RuntimeError as e:
            utils.logger.error(f"[XiaoHongShuLogin.login_by_mobile] Login interrupted by blocker: {e}")
            sys.exit(1)

        wait_redirect_seconds = 5
        utils.logger.info(f"[XiaoHongShuLogin.login_by_mobile] Login successful then wait for {wait_redirect_seconds} seconds redirect ...")
        await asyncio.sleep(wait_redirect_seconds)

    async def login_by_qrcode(self):
        """login xiaohongshu website and keep webdriver login state"""
        utils.logger.info("[XiaoHongShuLogin.login_by_qrcode] Begin login xiaohongshu by qrcode ...")
        # login_selector = "div.login-container > div.left > div.qrcode > img"
        qrcode_img_selector = "xpath=//img[@class='qrcode-img']"
        # find login qrcode
        base64_qrcode_img = await utils.find_login_qrcode(
            self.context_page,
            selector=qrcode_img_selector
        )
        if not base64_qrcode_img:
            utils.logger.info("[XiaoHongShuLogin.login_by_qrcode] login failed , have not found qrcode please check ....")
            # if this website does not automatically popup login dialog box, we will manual click login button
            await asyncio.sleep(0.5)
            login_button_ele = self.context_page.locator("xpath=//*[@id='app']/div[1]/div[2]/div[1]/ul/div[1]/button")
            await login_button_ele.click()
            base64_qrcode_img = await utils.find_login_qrcode(
                self.context_page,
                selector=qrcode_img_selector
            )
            if not base64_qrcode_img:
                sys.exit()

        utils.logger.info(f"QRCODE_BASE64:{base64_qrcode_img}")

        # get not logged session
        current_cookie = await self.browser_context.cookies()
        _, cookie_dict = utils.convert_cookies(current_cookie)
        no_logged_in_session = cookie_dict.get("web_session")
        no_logged_in_a1 = cookie_dict.get("a1") or ""

        # show login qrcode
        # fix issue #12
        # we need to use partial function to call show_qrcode function and run in executor
        # then current asyncio event loop will not be blocked
        partial_show_qrcode = functools.partial(utils.show_qrcode, base64_qrcode_img)
        asyncio.get_running_loop().run_in_executor(executor=None, func=partial_show_qrcode)

        utils.logger.info(f"[XiaoHongShuLogin.login_by_qrcode] waiting for scan code login, remaining time is 120s")
        try:
            await self.check_login_state(no_logged_in_session, no_logged_in_a1)
        except RetryError:
            utils.logger.info("[XiaoHongShuLogin.login_by_qrcode] Login xiaohongshu failed by qrcode login method ...")
            sys.exit()

        wait_redirect_seconds = 5
        utils.logger.info(f"[XiaoHongShuLogin.login_by_qrcode] Login successful then wait for {wait_redirect_seconds} seconds redirect ...")
        await asyncio.sleep(wait_redirect_seconds)

    async def login_by_cookies(self):
        """login xiaohongshu website by cookies"""
        utils.logger.info("[XiaoHongShuLogin.login_by_cookies] Begin login xiaohongshu by cookie ...")
        for key, value in utils.convert_str_cookie_to_dict(self.cookie_str).items():
            if key != "web_session":  # Only set web_session cookie attribute
                continue
            await self.browser_context.add_cookies([{
                'name': key,
                'value': value,
                'domain': ".xiaohongshu.com",
                'path': "/"
            }])
