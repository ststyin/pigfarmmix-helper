/**
 * 工具函数和 DOM 辅助函数
 */

import type { Pig, PickyLevel } from "./types/index.js";
import { IMG_BASE, FEED_LABELS } from "./constants.js";
import { state } from "./state.js";

// ---- DOM 辅助 ----
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: Document | HTMLElement = document): T | null =>
  root.querySelector<T>(sel);

export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: Document | HTMLElement = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

export function text(s: string | number): Text {
  return document.createTextNode(String(s));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children?: (HTMLElement | Text | string | null)[] | HTMLElement | Text | string | null
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = String(v);
    else if (k === "onclick") e.addEventListener("click", v as EventListener);
    else if (k === "html") e.innerHTML = String(v);
    else if (v !== undefined && v !== false) e.setAttribute(k, String(v));
  }
  const list = children == null ? [] : Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null) continue;
    if (typeof c === "string") e.appendChild(text(c));
    else e.appendChild(c);
  }
  return e;
}

/** Toast 提示 */
let _toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string, ms: number = 1800): void {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

/** 鉴权失败 (401) 统一处理 — 提示并跳到「我的」tab 引导重登
 *  用于老用户(没设过 session cookie)调用需要鉴权的 API 时
 *  清除 localStorage user: 避免页面以为已登录,但操作全部 401 */
export function handleAuthFailure(): void {
  // 1. 清除 localStorage 里的 user (cookie 没了, 旧 user 也不该信任)
  try { localStorage.removeItem("pigfarm_user"); } catch { /* ignore */ }
  // 2. 切到「我的」tab, 让用户看到登录面板
  (document.getElementById("tabBtnMine") as HTMLElement | null)?.click();
  // 3. 提示
  toast("登录已过期,请重新登录", 3000);
}

/** HTML 转义 */
export function escHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 图片 URL */
export function imgUrl(pNo: number | null | undefined): string {
  return pNo ? `${IMG_BASE}${pNo}.png` : "";
}

/** 星级显示 */
export function stars(rare: number | undefined, special?: boolean): string {
  const n = rare || 0;
  if (n >= 6) return "★".repeat(6);
  const filled = Math.max(0, Math.min(5, n));
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

/** 格式化重量 */
export function fmtKg(v: unknown): string {
  if (typeof v !== "number" || !isFinite(v)) return "?";
  return (Math.round(v * 10) / 10).toFixed(1);
}

/** 徽章体重阈值 */
export function badgeWeights(pig: Pig): { small: number; big: number; smallRaw: number; bigRaw: number; offset: number } | null {
  if (!pig || !pig.weight || typeof pig.weight.big !== "number" || typeof pig.weight.small !== "number") {
    return null;
  }
  return {
    small: pig.weight.small,
    big: pig.weight.big,
    smallRaw: pig.weight.small,
    bigRaw: pig.weight.big,
    offset: 0,
  };
}

/** 徽章 meta HTML */
export function badgeMetaHTML(pig: Pig): string {
  const w = badgeWeights(pig);
  if (!w) return "";
  const hasSmall = state.smallBadges.has(pig.pNo);
  const hasBig = state.bigBadges.has(pig.pNo);
  const chip = (kind: string, ownedAttr: boolean, value: number, op: string, iconSrc: string, label: string) =>
    `<div class="badge-chip badge-${kind}${ownedAttr ? " is-on" : ""}"` +
    ` data-badge-kind="${kind}" data-badge-pno="${pig.pNo}">` +
    `<img class="badge-icon" src="${iconSrc}" alt="${label}">` +
    `<span class="badge-text">${op} ${fmtKg(value)} kg</span>` +
    `<button type="button" class="badge-state" data-badge-kind="${kind}" data-badge-pno="${pig.pNo}"` +
    ` aria-pressed="${ownedAttr}" title="点击切换是否已获得${label}">${ownedAttr ? "✅ 已拥有" : "⬜ 未拥有"}</button>` +
    `</div>`;
  return `<div class="meta badge-line">` +
    chip("small", hasSmall, w.small, "≤", "/img/small.png", "小章") +
    chip("big", hasBig, w.big, "≥", "/img/big.png", "大章") +
    `</div>`;
}

/** 喂食间隔文本 */
export function feedIntervalText(eatable_time: number | undefined | null): string {
  if (eatable_time == null) return "?";
  if (eatable_time === 0) return "58 分钟";
  if (eatable_time < 1) return `${Math.round(eatable_time * 60)} 分钟`;
  return `${eatable_time} 小时`;
}

/** 挑食程度判定 */
export function pigPicky(p: Pig): { level: PickyLevel; label: string; foods: string[] } {
  const ids = ((p.feeding && p.feeding.picky) || []).filter((i: number) => FEED_LABELS[i]);
  const foods = ids.map(i => FEED_LABELS[i]);
  if (ids.length === 0) return { level: "none", label: "不挑食", foods };
  if (ids.length === 1) return { level: "picky", label: "挑食", foods };
  return { level: "some", label: "有点挑食", foods };
}

/** 判断是否为活动猪 */
export function isEventPigId(pNo: number): boolean {
  return !state.pigsById.has(pNo) && state.eventPigsById.has(pNo);
}

/** 判断猪是否已拥有 */
export function pigIsOwned(p: Pig): boolean {
  if (p.book === 7) return state.ownedEventPigs.has(p.pNo);
  return state.ownedSet.has(p.pNo);
}

/** 集齐 186 后的解锁庆祝弹窗 */
export function showUnlockCelebration(): void {
  if (document.getElementById("celebrationModal")) return;
  const names = Array.from(state.hiddenPigsById.values())
    .map(p => p.name)
    .filter(Boolean);
  const modal = document.createElement("div");
  modal.id = "celebrationModal";
  modal.className = "celebration-bg";
  modal.innerHTML = `
    <div class="celebration-card" role="dialog" aria-modal="true" aria-labelledby="celebrationTitle">
      <div class="celebration-confetti">🎉 ✨ 🎊 ✨ 🎉</div>
      <div class="celebration-crown">👑</div>
      <h2 id="celebrationTitle">恭喜你 · 大成就解锁!</h2>
      <p class="celebration-line">你已集齐 <b>主图鉴 186 只</b>,猪猪名册圆满 ✨</p>
      <p class="celebration-sub">作为奖赏,隐藏图鉴「皇室成员」向你开放:</p>
      <ul class="celebration-list">
        ${names.map(n => `<li>👑 ${escHtml(n)}</li>`).join("")}
      </ul>
      <p class="celebration-foot">现在到 <b>186图鉴 → 野猪图鉴第 3 页</b> 可以看到他们 🐷</p>
      <button type="button" class="add-btn celebration-ok" id="celebrationOk">收下这份荣耀 ✨</button>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add("show"));
  const close = () => {
    modal.classList.remove("show");
    setTimeout(() => modal.remove(), 220);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  modal.addEventListener("click", e => {
    if (e.target === modal || (e.target as HTMLElement).id === "celebrationOk") close();
  });
}
