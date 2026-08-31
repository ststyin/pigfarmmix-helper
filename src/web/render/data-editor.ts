/**
 * 数据管理 — 编辑已有猪 / 新增猪 / 新增配种
 *
 * 数据写入 D1 (POST /api/atlas/update), 保存成功后重新拉取图鉴数据。
 * 表单字段友好化: JSON 字段翻译成具体字段, 高级 JSON 折叠保留。
 * 多选下拉框支持搜索, 活动猪/普通猪区分显示, 养成指南重命名。
 */

import type { Pig, PigAcquisition, PigFeeding, BreedingGuide } from "../js/types/index.js";
import { state } from "../js/state.js";
import { $, escHtml, toast } from "../js/utils.js";
import { getCurrentUser } from "../js/auth.js";
import { refreshDataFromServer } from "../js/data.js";
import { emit } from "../js/events.js";
import { COLOR_TEXT, HUNT_SITES, FEED_LABELS } from "../js/constants.js";

// ---------- 小工具 ----------

// 复用 utils.escHtml — 完整版 (额外转 '), 避免重复实现; 保留本地别名 esc 以不破坏 16+ 调用点
const esc = escHtml;

function fieldHTML(id: string, label: string, value: string, opts: { type?: string; placeholder?: string; hint?: string } = {}): string {
  const { type = "text", placeholder = "", hint = "" } = opts;
  return `<div class="de-field">
    <label for="${id}">${label}</label>
    <input type="${type}" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" step="any">
    ${hint ? `<span class="de-hint">${hint}</span>` : ""}
  </div>`;
}

function textareaHTML(id: string, label: string, value: string, opts: { rows?: number; placeholder?: string; hint?: string } = {}): string {
  const { rows = 3, placeholder = "", hint = "" } = opts;
  return `<div class="de-field">
    <label for="${id}">${label}</label>
    <textarea id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
    ${hint ? `<span class="de-hint">${hint}</span>` : ""}
  </div>`;
}

// ---------- 多选下拉框组件 (搜索 + 勾选) ----------

function multiSelectHTML(containerId: string, label: string, options: { value: number; text: string }[], selected: number[], placeholder: string): string {
  const optionsHTML = options.map(o => {
    const checked = selected.includes(o.value) ? "checked" : "";
    return `<label class="de-multi-option">
      <input type="checkbox" value="${o.value}" ${checked}>
      <span>${esc(o.text)}</span>
    </label>`;
  }).join("");
  const pickSummary = summaryText(options, selected);
  return `<div class="de-field">
    <label>${label}</label>
    <div class="de-multi-select" data-multi-id="${containerId}">
      <button type="button" class="de-multi-toggle" aria-expanded="false">
        <span class="de-multi-summary" title="${esc(pickSummary)}">${esc(pickSummary)}</span>
        <span class="de-multi-caret">▾</span>
      </button>
      <div class="de-multi-panel" hidden>
        <input type="search" class="de-multi-search" placeholder="${esc(placeholder)}">
        <div class="de-multi-options" id="${containerId}">${optionsHTML}</div>
        <span class="de-multi-count">已选: ${selected.length}</span>
      </div>
    </div>
  </div>`;
}

/** 多选摘要: 前 3 项 + 数量 */
function summaryText(options: { value: number; text: string }[], selected: number[]): string {
  const labels = options.filter(o => selected.includes(o.value)).map(o => o.text);
  if (!labels.length) return "未选择";
  return labels.length <= 3 ? labels.join("、") : `${labels.slice(0, 3).join("、")} 等 ${labels.length} 项`;
}

function wireMultiSelect(container: HTMLElement): void {
  const select = container.classList.contains("de-multi-select")
    ? container
    : container.querySelector<HTMLElement>(".de-multi-select");
  const toggle = container.querySelector<HTMLElement>(".de-multi-toggle");
  const panel = container.querySelector<HTMLElement>(".de-multi-panel");
  const search = container.querySelector<HTMLInputElement>(".de-multi-search");
  const options = container.querySelectorAll<HTMLElement>(".de-multi-option");
  const countEl = container.querySelector<HTMLElement>(".de-multi-count");
  const summaryEl = container.querySelector<HTMLElement>(".de-multi-summary");
  if (!select || !toggle || !panel) return;

  const updateCount = () => {
    const checked = select.querySelectorAll<HTMLInputElement>('.de-multi-option input[type="checkbox"]:checked');
    if (countEl) countEl.textContent = `已选: ${checked.length}`;
    if (summaryEl) {
      const labels = [...checked].map(cb =>
        (cb.closest<HTMLElement>(".de-multi-option")?.querySelector("span")?.textContent || "").trim()
      );
      summaryEl.textContent = labels.length
        ? (labels.length <= 3 ? labels.join("、") : `${labels.slice(0, 3).join("、")} 等 ${labels.length} 项`)
        : "未选择";
    }
  };

  toggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const wasOpen = !panel.hidden;
    closeAllDropdowns();
    if (!wasOpen) {
      panel.hidden = false;
      select.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
      // 重置搜索过滤状态
      options.forEach(opt => { opt.style.display = ""; });
      search?.focus();
    }
  });

  search?.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    options.forEach(opt => {
      const text = opt.textContent?.toLowerCase() || "";
      opt.style.display = (!q || text.includes(q)) ? "" : "none";
    });
  });

  select.querySelectorAll<HTMLInputElement>('.de-multi-option input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", updateCount);
  });

  updateCount();
}

/** 关闭所有已展开的下拉面板 (多选 + 可搜索单选共用) */
export function closeAllDropdowns(): void {
  document.querySelectorAll<HTMLElement>(".de-multi-panel:not([hidden]), .de-search-select-panel:not([hidden])").forEach(p => {
    p.hidden = true;
  });
  document.querySelectorAll<HTMLElement>(".de-multi-toggle").forEach(t => t.setAttribute("aria-expanded", "false"));
  document.querySelectorAll<HTMLElement>(".de-multi-select, .de-search-select").forEach(s => {
    s.classList.remove("open");
    // 多选下拉 (de-multi-select) 与可搜索单选 (de-search-select) 共用同一机制
    // — 关闭后需要清掉各自面板里的搜索框, 否则用户下次打开看到的列表会被上次的过滤词隐起来
    s.querySelectorAll<HTMLInputElement>(".de-multi-search, .de-search-select-input").forEach(input => { input.value = ""; });
  });
}

function getMultiSelectValues(containerId: string): number[] {
  const container = document.getElementById(containerId);
  if (!container) return [];
  const values: number[] = [];
  container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked').forEach(cb => {
    values.push(Number(cb.value));
  });
  return values;
}

// ---------- 选项数据源 ----------

/** 普通狩猎站点 0-16 (0/1/2 为数据中使用的旧站点编号) */
function getHuntSiteOptions(maxSite: number): { value: number; text: string }[] {
  const opts: { value: number; text: string }[] = [];
  for (let i = 0; i <= maxSite; i++) {
    if (i === 0) {
      opts.push({ value: 0, text: "站点 0 (通用狩猎)" });
    } else if (HUNT_SITES[i]) {
      opts.push({ value: i, text: HUNT_SITES[i] });
    } else {
      opts.push({ value: i, text: `站点 ${i}` });
    }
  }
  return opts;
}

/** 活动狩猎站点 81-99 */
function getEventHuntSiteOptions(): { value: number; text: string }[] {
  const opts: { value: number; text: string }[] = [];
  for (let i = 81; i <= 99; i++) {
    if (HUNT_SITES[i]) {
      opts.push({ value: i, text: HUNT_SITES[i] });
    } else {
      opts.push({ value: i, text: `活动站点 ${i}` });
    }
  }
  return opts;
}

/** 全部狩猎站点 (编辑模式用: 普通 0-16 + 活动 81-99) */
function getAllHuntSiteOptions(): { value: number; text: string }[] {
  return [...getHuntSiteOptions(16), ...getEventHuntSiteOptions()];
}

/** 食材选项 (FEED_LABELS 过滤掉 key=0) */
function getFeedOptions(): { value: number; text: string }[] {
  return Object.entries(FEED_LABELS)
    .filter(([k]) => Number(k) > 0)
    .map(([k, v]) => ({ value: Number(k), text: v }));
}

/** 所有猪 (用于养成失败来源) */
function getPigOptions(): { value: number; text: string }[] {
  const pigs = [...state.pigsById.values(), ...state.eventPigsById.values()]
    .sort((a, b) => a.pNo - b.pNo);
  return pigs.map(p => ({ value: p.pNo, text: `#${p.pNo} ${p.name}` }));
}

// ---------- JSON 字段 → 表单字段的取值 ----------

function acqShopValue(a: PigAcquisition | undefined, idx: 0 | 1 | 2): string {
  const shop = a?.shop || [0, 0, 0];
  const v = shop[idx];
  return v != null && v > 0 ? String(Math.round(v * 10000) / 100) : ""; // 转百分比
}

// ---------- 猪编辑表单 ----------

function pigFormHTML(p: Pig | null): string {
  const isNew = !p;
  const v = (key: keyof Pig): string => {
    const val = p ? p[key] : undefined;
    if (val == null) return "";
    if (typeof val === "boolean") return val ? "1" : "0";
    return String(val);
  };
  const colorOptions = Object.entries(COLOR_TEXT)
    .map(([code, name]) => `<option value="${code}" ${p && String(p.color) === code ? "selected" : ""}>${name} (${code})</option>`)
    .join("");
  const acq = p?.acquisition;
  const feed = p?.feeding;
  const guide = p?.breedingGuide;
  const hints = p?.hints || [];

  // 多选初始值
  const huntSites = isNew
    ? (acq?.hunt?.sites?.filter(s => s >= 81 && s <= 99) || [])
    : (acq?.hunt?.sites || []);
  const failFrom = acq?.fail || [];
  const pickyFoods = feed?.picky || [];

  return `
  <div class="de-form">
    <div class="de-section-title">${isNew ? "新增猪" : `编辑猪 #${p!.pNo} ${esc(p!.name)}`}</div>
    <div class="de-hint" style="margin-bottom: 10px;">
      数值字段: 留空 = 保留原值 · 填 0 = 清零 · 非法输入会在保存时被拦截
    </div>
    ${isNew ? "" : `<input type="hidden" id="dePNo" value="${p!.pNo}">`}

    <div class="de-section-sub">基本信息</div>
    <div class="de-grid2">
      ${fieldHTML("deName", "名称 *", isNew ? "" : v("name"), { placeholder: "猪的名称" })}
      <div class="de-field">
        <label for="deRare">星级</label>
        <select id="deRare">
          ${(isNew ? [3, 4, 5, 6] : [1, 2, 3, 4, 5, 6]).map(n => `<option value="${n}" ${p && p.rare === n ? "selected" : ""}>${"★".repeat(n)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="de-grid2">
      <div class="de-field">
        <label for="deColor">颜色</label>
        <select id="deColor">${colorOptions}</select>
      </div>
      <div class="de-field">
        <label for="deStatus">状态</label>
        <select id="deStatus">
          <option value="normal" ${p && p.status === "normal" ? "selected" : ""}>正常</option>
          <option value="hidden" ${p && p.status === "hidden" ? "selected" : ""}>隐藏</option>
          <option value="removed" ${p && p.status === "removed" ? "selected" : ""}>已移除</option>
        </select>
      </div>
    </div>
    ${textareaHTML("deDesc", "描述", isNew ? "" : v("description"), { rows: 2, placeholder: "猪的描述" })}

    ${isNew ? `
    <input type="hidden" id="deAtlasType" value="7">
    ` : `
    <!-- atlas 字段不展示: 业务只允许编辑活动猪,图鉴位置不允许在 UI 改 (修改只能走 seed/script) -->
    <input type="hidden" id="deAtlasType" value="${p!.atlas?.type ?? 7}">
    <input type="hidden" id="deAtlasIndex" value="${p!.atlas?.index ?? ""}">
    `}

    <div class="de-section-sub">成长与价格</div>
    <div class="de-grid2">
      ${fieldHTML("deWeightSmall", "小章体重 (kg)", isNew ? "" : p?.weight?.small != null ? String(p.weight.small) : "", { type: "number" })}
      ${fieldHTML("deWeightBig", "大章体重 (kg)", isNew ? "" : p?.weight?.big != null ? String(p.weight.big) : "", { type: "number" })}
    </div>
    <div class="de-grid2">
      ${fieldHTML("deRent", "借猪费用 (pt)", isNew ? "" : v("rent"), { type: "number" })}
      ${fieldHTML("dePrice", "售价 (pt)", isNew ? "" : v("price"), { type: "number" })}
    </div>
    <div class="de-grid2">
      ${fieldHTML("deLifespan", "成猪寿命 (小时)", isNew ? "" : v("lifespan"), { type: "number" })}
      <div class="de-field">
        <label for="deGraze">放牧</label>
        <select id="deGraze">
          <option value="0" ${p && !p.graze ? "selected" : ""}>否</option>
          <option value="1" ${p && p.graze ? "selected" : ""}>是</option>
        </select>
      </div>
    </div>

    ${isNew ? "" : `
    <div class="de-grid2">
      <div class="de-field">
        <label for="deSpecial">活动猪</label>
        <select id="deSpecial">
          <option value="0" ${p && !p.special ? "selected" : ""}>否</option>
          <option value="1" ${p && p.special ? "selected" : ""}>是</option>
        </select>
      </div>
    </div>
    `}

    <div class="de-section-sub">获取途径</div>
    ${isNew ? `
    ${multiSelectHTML("deHuntSites", "狩猎站点", getEventHuntSiteOptions(), huntSites, "搜索站点...")}
    ` : `
    <div class="de-grid3">
      ${fieldHTML("deShopA", "商店 A 级概率 (%)", acqShopValue(acq, 0), { type: "number", placeholder: "如 10" })}
      ${fieldHTML("deShopB", "商店 B 级概率 (%)", acqShopValue(acq, 1), { type: "number", placeholder: "如 5" })}
      ${fieldHTML("deShopC", "商店 C 级概率 (%)", acqShopValue(acq, 2), { type: "number", placeholder: "如 3" })}
    </div>
    ${multiSelectHTML("deHuntSites", "狩猎站点", getAllHuntSiteOptions(), huntSites, "搜索站点...")}
    ${multiSelectHTML("deFailFrom", "养成失败来源", getPigOptions(), failFrom, "搜索猪编号 / 名称...")}
    `}
    <div class="de-field">
      <label class="de-check">
        <input type="checkbox" id="deSpecialFeeding" ${acq?.specialFeeding ? "checked" : ""}> 有超分歧 / 超出世系条件
      </label>
    </div>

    <div class="de-section-sub">喂食</div>
    <div class="de-grid3">
      ${fieldHTML("deFeedInterval", "喂食间隔 (小时)", feed?.interval != null ? String(feed.interval) : "", { type: "number", placeholder: "如 8" })}
      ${fieldHTML("deFeedTimes", "最少喂食次数", feed?.times != null ? String(feed.times) : "", { type: "number", placeholder: "如 3" })}
    </div>
    ${multiSelectHTML("deFeedPicky", "挑食食材", getFeedOptions(), pickyFoods, "搜索食材...")}

    <div class="de-section-sub">养成指南</div>
    ${textareaHTML("deGuideReq", "要求", guide?.requirements || "", { rows: 2, placeholder: "如: 成猪前体重限制 ≥128.0 kg" })}
    ${textareaHTML("deGuideTips", "提示", guide?.tips || "", { rows: 2, placeholder: "如: 每种食物最少吃一次" })}

    <div class="de-section-sub">提示</div>
    ${textareaHTML("deHints", "提示 (每行一条)", hints.join("\n"), { rows: 3, placeholder: "每行一条提示" })}

    <details class="de-advanced">
      <summary>高级 (JSON 原始字段)</summary>
      <div class="de-advanced-body">
        <div class="de-hint" style="margin-bottom: 6px;">
          填写 JSON = 完全替换该字段(忽略上方友好字段) · 留空 = 使用上方友好字段
        </div>
        ${fieldHTML("deAcquisitionJSON", "获取途径 JSON", isNew ? "" : p?.acquisition ? JSON.stringify(p.acquisition) : "", { placeholder: '{"shop": [0.1, 0, 0]}' })}
        ${fieldHTML("deFeedingJSON", "喂食 JSON", isNew ? "" : p?.feeding ? JSON.stringify(p.feeding) : "", { placeholder: '{"interval": 8, "times": 3, "picky": []}' })}
        ${fieldHTML("deBreedingGuideJSON", "养成指南 JSON", isNew ? "" : p?.breedingGuide ? JSON.stringify(p.breedingGuide) : "", { placeholder: '{"requirements": "...", "tips": "..."}' })}
        ${fieldHTML("deHintsJSON", "提示 JSON", isNew ? "" : p?.hints ? JSON.stringify(p.hints) : "", { placeholder: '["提示1", "提示2"]' })}
      </div>
    </details>

    <div class="de-actions">
      <button type="button" class="add-btn" id="deSaveBtn">保存</button>
      <button type="button" class="add-btn secondary" id="deCancelBtn">取消</button>
    </div>
    <p class="account-form-hint" id="deMsg"></p>
  </div>`;
}

// ---------- 配种表单 ----------

function breedingFormHTML(): string {
  const options = pigSearchOptions();
  return `
  <div class="de-form">
    <div class="de-section-title">新增配种</div>
    <div class="de-grid2">
      ${searchSelectHTML("dbParent1", "父/母 1 *", options, "", "搜索 pNo / 名称...")}
      ${searchSelectHTML("dbParent2", "父/母 2", options, "", "搜索 pNo / 名称...", [{ value: "*", text: "* 任意" }])}
    </div>
    <div class="de-section-sub">产出 (选择猪 + 概率)</div>
    <div class="de-outcome-rows" id="dbOutcomeRows">
      <div class="de-outcome-row">
        <div class="de-outcome-select-wrap">
          ${searchSelectHTML("dbOutcome0", "", options, "", "搜索 pNo / 名称...")}
        </div>
        <input type="number" class="de-outcome-prob" placeholder="概率 %" min="0" step="any">
        <button type="button" class="de-outcome-del" title="删除此行">✕</button>
      </div>
    </div>
    <button type="button" class="add-btn secondary de-add-row" id="dbAddRowBtn">+ 添加产出</button>
    <div class="de-actions">
      <button type="button" class="add-btn" id="dbSaveBtn">保存配种</button>
      <button type="button" class="add-btn secondary" id="dbCancelBtn">取消</button>
    </div>
    <p class="account-form-hint" id="dbMsg"></p>
  </div>`;
}

// ---------- 保存 ----------

async function apiSave(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; pig?: { pNo: number }; breeding?: boolean }> {
  const user = getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  try {
    const res = await fetch("/api/atlas/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, ...body }),
    });
    const data = await res.json() as { ok?: boolean; error?: string; pig?: { pNo: number }; breeding?: boolean };
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, pig: data.pig, breeding: data.breeding };
  } catch (err) {
    console.error("[apiSave]", err);
    return { ok: false, error: "网络错误,请稍后重试" };
  }
}

function numOrNull(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 数值输入框实时校验 (input 事件) + 初始校验 (编辑模式预填值)
 *  规则: 空 = OK (保留原值); 非数字 / 负数 = 标记错误 (红色边框)
 *  返回一个函数,调用时重跑所有字段校验, 用于保存前最后检查 */
function wireNumericValidation(ids: readonly string[]): () => boolean {
  const inputs: HTMLInputElement[] = [];
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    inputs.push(el);
    const validate = () => {
      const v = el.value.trim();
      if (v === "") {
        el.classList.remove("de-input-error");
        return;
      }
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) {
        el.classList.remove("de-input-error");
      } else {
        el.classList.add("de-input-error");
      }
    };
    el.addEventListener("input", validate);
    validate(); // 初始化时校验编辑模式预填值
  }
  return () => {
    for (const el of inputs) {
      const v = el.value.trim();
      if (v === "") { el.classList.remove("de-input-error"); continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) el.classList.add("de-input-error");
      else el.classList.remove("de-input-error");
    }
    return !inputs.some(el => el.classList.contains("de-input-error"));
  };
}

function val(sel: string): string {
  return ($(sel) as HTMLInputElement | null)?.value.trim() || "";
}

function parseJsonField(sel: string): unknown {
  const v = val(sel);
  if (!v) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

/** 保存按钮防重复点击包装 — 仿照 app.ts wireRefreshButton 模式
 *  saveFn 是 async 的;调用中加 is-loading,结束后 (try/finally) 移除
 *  防 click handler 在请求 in-flight 时被重复触发 (例如配种会多插一条) */
function wireSaveButton(btnId: string, saveFn: () => Promise<void>): void {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.classList.contains("is-loading")) return;
    btn.classList.add("is-loading");
    try {
      await saveFn();
    } finally {
      btn.classList.remove("is-loading");
    }
  });
}

/** 数组等价比较 (按顺序、严格相等) */
function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 浮点数组等价 (1e-4 容差 — 覆盖 UI 2 位小数 + 后端高精度舍入误差) */
function arraysClose(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-4) return false;
  return true;
}

/** 字符串数组等价 (按顺序、严格相等) */
function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 从友好字段构建 acquisition 对象
 *
 *  后端 SQL 是「整列替换或保留」(`CASE WHEN excluded.X IS NULL THEN ...`),
 *  不会做字段级合并,因此这里必须浅合并 base 后覆盖变更字段,
 *  否则改了子字段 (e.g. hunt.sites) 会把父字段下其他未变更子字段 (e.g. hunt.prob) 一起刷掉。
 *
 *  - 新增 (isNew=true): 从 form 构建,hunt (只有 sites) + specialFeeding 总是输出
 *  - 编辑 (isNew=false): 浅合并 base,只覆盖 form 改了的部分;无变更返回 undefined
 *    → caller 不发送该 key → 后端保留原列值
 */
export function buildAcquisition(base: PigAcquisition | undefined, isNew: boolean): PigAcquisition | undefined {
  if (isNew) {
    const a: PigAcquisition = {};
    const sites = getMultiSelectValues("deHuntSites");
    if (sites.length) a.hunt = { sites };
    const sf = ($("#deSpecialFeeding") as HTMLInputElement | null)?.checked ?? false;
    a.specialFeeding = sf; // 新建场景总是带上,默认 false
    return a;
  }

  // 编辑: 浅合并 base, 只覆盖变更字段
  let changed = false;
  const a: PigAcquisition = { ...(base || {}) };

  // 商店 — 三槽独立处理:
  //   用户填了某槽 → 该槽用 form 值 / 100; 未填 (null) → 保留 base 的值
  //   任一槽与 base 不同 → 写完整 shop = [a, b, c] (其余槽位填 base 的值)
  {
    const formShop: [number | null, number | null, number | null] = [
      numOrNull(val("#deShopA")),
      numOrNull(val("#deShopB")),
      numOrNull(val("#deShopC")),
    ];
    const origShop: [number, number, number] = base?.shop
      ? [base.shop[0] ?? 0, base.shop[1] ?? 0, base.shop[2] ?? 0]
      : [0, 0, 0];
    const mergedShop: [number, number, number] = [
      formShop[0] != null ? formShop[0] / 100 : origShop[0],
      formShop[1] != null ? formShop[1] / 100 : origShop[1],
      formShop[2] != null ? formShop[2] / 100 : origShop[2],
    ];
    if (Math.abs(mergedShop[0] - origShop[0]) > 1e-4 ||
        Math.abs(mergedShop[1] - origShop[1]) > 1e-4 ||
        Math.abs(mergedShop[2] - origShop[2]) > 1e-4) {
      a.shop = mergedShop;
      changed = true;
    }
  }

  // 狩猎站点 — 必须 spread base.hunt 才能保留 prob
  {
    const sites = getMultiSelectValues("deHuntSites");
    const origSites = base?.hunt?.sites || [];
    if (!arraysEqual(sites, origSites)) {
      a.hunt = { ...(base?.hunt || {}), sites };
      changed = true;
    }
  }

  // 养成失败来源
  {
    const fail = getMultiSelectValues("deFailFrom");
    const origFail = base?.fail || [];
    if (!arraysEqual(fail, origFail)) {
      a.fail = fail;
      changed = true;
    }
  }

  // 超分歧/超出世系
  {
    const sf = ($("#deSpecialFeeding") as HTMLInputElement | null)?.checked ?? false;
    const origSF = base?.specialFeeding || false;
    if (origSF !== sf) {
      a.specialFeeding = sf;
      changed = true;
    }
  }

  return changed ? a : undefined;
}

/** 从友好字段构建 feeding 对象 — 同上,浅合并 base */
export function buildFeeding(base: PigFeeding | undefined): PigFeeding | undefined {
  let changed = false;
  const f: PigFeeding = { ...(base || {}) };

  const interval = numOrNull(val("#deFeedInterval"));
  if (interval != null && interval !== base?.interval) {
    f.interval = interval;
    changed = true;
  }

  const times = numOrNull(val("#deFeedTimes"));
  if (times != null && times !== base?.times) {
    f.times = times;
    changed = true;
  }

  const picky = getMultiSelectValues("deFeedPicky");
  if (!arraysEqual(picky, base?.picky || [])) {
    f.picky = picky;
    changed = true;
  }

  return changed ? f : undefined;
}

/** 从友好字段构建 breedingGuide 对象 — 同上,浅合并 base */
export function buildGuide(base: BreedingGuide | undefined): BreedingGuide | undefined {
  let changed = false;
  const g: BreedingGuide = { ...(base || {}) };

  const req = val("#deGuideReq");
  const baseReq = base?.requirements || "";
  if (req && req !== baseReq) {
    g.requirements = req;
    changed = true;
  }

  const tips = val("#deGuideTips");
  const baseTips = base?.tips || "";
  if (tips && tips !== baseTips) {
    g.tips = tips;
    changed = true;
  }

  return changed ? g : undefined;
}

async function savePigFromForm(isNew: boolean): Promise<void> {
  const name = val("#deName");
  if (!name) {
    const m = $("#deMsg"); if (m) { m.textContent = "请填写名称"; m.className = "account-form-hint error"; }
    return;
  }

  const rareEl = $("#deRare") as HTMLSelectElement | null;
  const specialEl = $("#deSpecial") as HTMLSelectElement | null;
  const isSpecial = isNew ? true : (specialEl?.value === "1");

  const pig: Record<string, unknown> = {
    name,
    rare: Number(rareEl?.value || (isNew ? 3 : 1)),
    color: Number(($("#deColor") as HTMLSelectElement)?.value || 0),
    status: ($("#deStatus") as HTMLSelectElement)?.value || "normal",
    description: val("#deDesc") || undefined,
    // 活动猪图鉴号固定为 7; 普通猪从表单读取
    atlasType: isSpecial ? 7 : (numOrNull(val("#deAtlasType")) || undefined),
    atlasIndex: numOrNull(val("#deAtlasIndex")) || undefined,
    weightSmall: numOrNull(val("#deWeightSmall")),
    weightBig: numOrNull(val("#deWeightBig")),
    rent: numOrNull(val("#deRent")),
    price: numOrNull(val("#dePrice")),
    lifespan: numOrNull(val("#deLifespan")),
    graze: ($("#deGraze") as HTMLSelectElement)?.value === "1",
    special: isSpecial,
  };
  if (!isNew) {
    pig.pNo = Number(($("#dePNo") as HTMLInputElement | null)?.value || 0);
  }

  // 从 state 拿基线 pig — 作为 JSON 字段 diff 的对比基准
  // partial merge 语义: 友好字段仅在变更时才输出,原 UI 未暴露的字段(hunt.prob 等)由后端保留
  const basePig = !isNew
    ? state.pigsById.get(Number(pig.pNo))
      || state.eventPigsById.get(Number(pig.pNo))
      || state.hiddenPigsById.get(Number(pig.pNo))
    : undefined;

  // 友好字段优先; 若高级 JSON 填了, 以 JSON 为准 (JSON = 完全替换)
  const acqJSON = parseJsonField("#deAcquisitionJSON");
  const feedJSON = parseJsonField("#deFeedingJSON");
  const guideJSON = parseJsonField("#deBreedingGuideJSON");
  const hintsJSON = parseJsonField("#deHintsJSON");

  const acq = buildAcquisition(basePig?.acquisition, isNew);
  const feed = buildFeeding(basePig?.feeding);
  const guide = buildGuide(basePig?.breedingGuide);

  // 仅在“未填高级 JSON 且 友好字段存在变更”时 才发送该 key
  // 发出的值: 高级 JSON > 合并后的友好对象 > undefined(不发送,后端保留)
  pig.acquisition = acqJSON !== undefined ? acqJSON : ((acq && Object.keys(acq).length) ? acq : undefined);
  pig.feeding = feedJSON !== undefined ? feedJSON : ((feed && Object.keys(feed).length) ? feed : undefined);
  pig.breedingGuide = guideJSON !== undefined ? guideJSON : ((guide && Object.keys(guide).length) ? guide : undefined);

  // 提示: 每行一条; 高级 JSON 优先; 与基线一致则不发 (含主动清空 → 输出 [])
  if (hintsJSON !== undefined) {
    pig.hints = hintsJSON;
  } else {
    const hintLines = val("#deHints").split("\n").map(s => s.trim()).filter(Boolean);
    if (!stringArraysEqual(hintLines, basePig?.hints || [])) pig.hints = hintLines;
  }

  const result = await apiSave({ pig });
  const m = $("#deMsg");
  if (!m) return;
  if (result.ok) {
    m.textContent = "保存成功,正在刷新数据...";
    m.className = "account-form-hint success";
    await reloadData({ silent: true });
    // 弹出刚保存的猪的抽屉 — 让用户立刻看到自己的改动生效
    // (reloadData 后 state 已更新,抽屉会读到最新的数据)
    const detailPNo = isNew ? result.pig?.pNo : Number(pig.pNo);
    if (detailPNo) emit("show-detail", detailPNo);
    toast(isNew ? `已新增 #${detailPNo}` : "已保存", 2200);
  } else {
    m.textContent = result.error || "保存失败";
    m.className = "account-form-hint error";
  }
}

export async function saveBreedingFromForm(): Promise<void> {

  const p1raw = getSearchSelectValue("dbParent1");
  const p2raw = getSearchSelectValue("dbParent2");
  const p1 = Number(p1raw);
  const p2 = p2raw === "*" ? "*" : Number(p2raw);

  if (!p1 || p1 <= 0 || (!p2raw || (!(p2 === "*") && (!p2 || p2 <= 0)))) {
    const m = $("#dbMsg"); if (m) { m.textContent = "请选择有效的父母"; m.className = "account-form-hint error"; }
    return;
  }

  // 收集产出行
  const outcomes: { pNo: number; prob: number }[] = [];
  document.querySelectorAll<HTMLElement>("#dbOutcomeRows .de-outcome-row").forEach(row => {
    const ss = row.querySelector<HTMLElement>(".de-search-select");
    const pNo = Number(ss?.getAttribute("data-ss-value") || 0);
    const probText = (row.querySelector(".de-outcome-prob") as HTMLInputElement | null)?.value || "";
    // 概率留空 = 100 — 与种子数据 (60/100) 同单位 (百分比), 抽屉显示为 ${prob}%
    const prob = probText === "" ? 100 : Number(probText);
    if (pNo > 0) outcomes.push({ pNo, prob: Number.isFinite(prob) ? Math.max(0, prob) : 100 });
  });

  if (outcomes.length === 0) {
    const m = $("#dbMsg"); if (m) { m.textContent = "请至少添加一个产出"; m.className = "account-form-hint error"; }
    return;
  }

  // 新增配种默认公开可见, 无勾选框
  const result = await apiSave({ breeding: { parent1: p1, parent2: p2, outcomes, visible: true } });
  const m = $("#dbMsg");
  if (!m) return;
  if (result.ok) {
    m.textContent = "配种已保存,正在刷新数据...";
    m.className = "account-form-hint success";
    await reloadData({ silent: true });
    toast("已添加新配种", 2400);
    // 留在「新增配种」tab 并重置表单 — 让用户能连续添加多条配种
    const breedingTab = $("#mineDataView")?.querySelector<HTMLElement>('.de-tab[data-de-tab="breeding"]');
    breedingTab?.click();
  } else {
    m.textContent = result.error || "保存失败";
    m.className = "account-form-hint error";
  }
}

/** 保存成功后重新加载图鉴数据 (本地状态 + 索引重建)
 *  强制走 API 拿最新 D1 数据;API 失败时降级到本地缓存并明确提示,
 *  不让用户误以为已成功刷新。
 *  silent=true 时不 toast — 由调用方根据业务语义提示具体结果(如"已新增 #123") */
async function reloadData(opts?: { silent?: boolean }): Promise<void> {
  const result = await refreshDataFromServer();
  emit("ui-refresh", undefined);
  if (opts?.silent) return;
  if (result.ok) {
    toast("数据已更新");
  } else {
    toast(result.error || "数据刷新失败", 3200);
  }
}

// ---------- 可搜索单选 (配种父母 / 产出) ----------

function pigSearchOptions(): { value: string; text: string }[] {
  const pigs = [...state.pigsById.values(), ...state.eventPigsById.values()]
    .sort((a, b) => a.pNo - b.pNo);
  return pigs.map(p => ({ value: String(p.pNo), text: `#${p.pNo} ${p.name}` }));
}

function searchSelectHTML(
  containerId: string,
  label: string,
  options: { value: string; text: string }[],
  value: string,
  placeholder: string,
  extraOptions: { value: string; text: string }[] = []
): string {
  const all = [...extraOptions, ...options];
  const optionHTML = all.map(o => {
    const selected = o.value === value;
    return `<button type="button" class="de-ss-option ${selected ? "selected" : ""}" data-value="${esc(o.value)}">
      <span>${esc(o.text)}</span>
      ${selected ? '<span class="de-ss-check">✓</span>' : ""}
    </button>`;
  }).join("");
  const shown = all.find(o => o.value === value);
  const labelHTML = label ? `<label>${label}</label>` : "";
  return `<div class="de-field">
    ${labelHTML}
    <div class="de-search-select" data-ss-id="${containerId}" data-ss-value="${esc(value)}">
      <button type="button" class="de-ss-toggle">
        <span class="de-ss-selected ${shown ? "" : "placeholder"}">${shown ? esc(shown.text) : "请选择..."}</span>
        <span class="de-multi-caret">▾</span>
      </button>
      <div class="de-search-select-panel" hidden>
        <input type="search" class="de-search-select-input" placeholder="${esc(placeholder)}" autocomplete="off">
        <div class="de-search-select-options">${optionHTML}</div>
      </div>
    </div>
  </div>`;
}

function wireSearchSelect(ss: HTMLElement): void {
  const toggle = ss.querySelector<HTMLElement>(".de-ss-toggle");
  const panel = ss.querySelector<HTMLElement>(".de-search-select-panel");
  const input = ss.querySelector<HTMLInputElement>(".de-search-select-input");
  const options = ss.querySelectorAll<HTMLElement>(".de-ss-option");
  const selectedEl = ss.querySelector<HTMLElement>(".de-ss-selected");
  if (!toggle || !panel) return;

  const rerenderSelected = (): void => {
    const value = ss.getAttribute("data-ss-value") || "";
    const hit = [...options].find(o => o.getAttribute("data-value") === value);
    options.forEach(o => o.classList.toggle("selected", o.getAttribute("data-value") === value));
    if (selectedEl) {
      if (hit) {
        selectedEl.textContent = hit.querySelector("span")?.textContent || "";
        selectedEl.classList.remove("placeholder");
      } else {
        selectedEl.textContent = "请选择...";
        selectedEl.classList.add("placeholder");
      }
    }
  };
  rerenderSelected();

  toggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const wasOpen = !panel.hidden;
    closeAllDropdowns();
    if (!wasOpen) {
      panel.hidden = false;
      ss.classList.add("open");
      input?.focus();
      // 重置搜索过滤状态
      options.forEach(opt => { opt.style.display = ""; });
    }
  });

  input?.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    options.forEach(opt => {
      const text = opt.textContent?.toLowerCase() || "";
      opt.style.display = (!q || text.includes(q)) ? "" : "none";
    });
  });

  options.forEach(opt => {
    opt.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ss.setAttribute("data-ss-value", opt.getAttribute("data-value") || "");
      closeAllDropdowns();
      rerenderSelected();
    });
  });
}

function getSearchSelectValue(containerId: string): string {
  return document.querySelector<HTMLElement>(`[data-ss-id="${containerId}"]`)?.getAttribute("data-ss-value") || "";
}

// ---------- 视图渲染 ----------

/** 「点击面板外关闭」全局 listener 的 AbortController
 *  模块级持久, 因为下拉是 document 级的事件 (不在 view 元素树内);
 *  跟渲染有关 tab 状态不影响它的生命周期 — 下拉是应用全局机制。
 *  AbortController 让未来的 teardown 能干净地取消绑定,
 *  而 boolean flag 只适用于「绑了就不能取消」的寿命。 */
let dropdownAbort: AbortController | null = null;

export function renderDataView(): void {
  const root = $("#mineDataView");
  if (!root) return;

  // 「点击下拉面板外 → 关掉所有展开的下拉」: 跨 view / 跨 tab 共用同一份监听,
  // 只绑一次。
  if (!dropdownAbort) {
    dropdownAbort = new AbortController();
    document.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t && !t.closest(".de-multi-select, .de-search-select")) closeAllDropdowns();
    }, { signal: dropdownAbort.signal });
  }

  if (!getCurrentUser()) {
    root.innerHTML = `<div class="empty"><div class="title">请先登录</div><div class="hint">登录后才能编辑图鉴数据</div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="de-tabs">
      <button type="button" class="de-tab active" data-de-tab="edit">编辑猪</button>
      <button type="button" class="de-tab" data-de-tab="new">新增猪</button>
      <button type="button" class="de-tab" data-de-tab="breeding">新增配种</button>
    </div>
    <div class="de-body" id="deBody"></div>
  `;

  const showTab = (tab: string): void => {
    root.querySelectorAll<HTMLElement>(".de-tab").forEach(t => t.classList.toggle("active", t.dataset.deTab === tab));
    const body = $("#deBody");
    if (!body) return;
    if (tab === "edit") {
      body.innerHTML = renderPigPicker();
      wirePigPicker();
    } else if (tab === "new") {
      body.innerHTML = pigFormHTML(null);
      wirePigForm(true);
    } else {
      body.innerHTML = breedingFormHTML();
      wireBreedingForm();
    }
  };

  root.querySelectorAll<HTMLElement>(".de-tab").forEach(btn => {
    btn.addEventListener("click", () => showTab(btn.dataset.deTab || "edit"));
  });
  showTab("edit");
}

function renderPigPicker(): string {
  // 仅渲染容器与搜索框; 列表行由 wirePigPicker 分块注入,避免 660 个 button 同时出现在 DOM
  return `
    <div class="de-picker">
      <input type="search" id="dePigSearch" class="search" placeholder="搜索 pNo / 名称...">
      <div class="de-pig-list" id="dePigList"><!-- 行由 wirePigPicker JS 注入 --></div>
    </div>
  `;
}

const PICKER_PAGE_SIZE = 60;

/** 构造一行猪 picker 项的 HTML */
function pickerItemHTML(p: Pig): string {
  return `<button type="button" class="de-pig-item" data-pno="${p.pNo}">
    <span class="de-pig-no">#${p.pNo}</span>
    <span class="de-pig-name">${esc(p.name)}</span>
    <span class="de-pig-rare">${"★".repeat(Math.max(1, Math.min(6, p.rare)))}</span>
  </button>`;
}

function wirePigPicker(): void {
  const search = $("#dePigSearch") as HTMLInputElement | null;
  const list = $("#dePigList");
  if (!list) return;

  const allPigs: Pig[] = [...state.pigsById.values(), ...state.eventPigsById.values()]
    .sort((a, b) => a.pNo - b.pNo);

  // 模式: 'paged' (默认, 分块渲染) / 'filtered' (搜索中, 全渲染过滤后列表)
  let mode: "paged" | "filtered" = "paged";
  let shown = 0;  // paged 模式下已渲染的行数

  const renderChunk = (start: number, end: number): void => {
    list.insertAdjacentHTML("beforeend", allPigs.slice(start, end).map(pickerItemHTML).join(""));
  };

  const enterPagedMode = (): void => {
    mode = "paged";
    list.innerHTML = "";
    shown = Math.min(PICKER_PAGE_SIZE, allPigs.length);
    renderChunk(0, shown);
    list.scrollTop = 0;
  };

  // 滚到底部 → 追加下一批
  list.addEventListener("scroll", () => {
    if (mode !== "paged") return;
    if (shown >= allPigs.length) return;
    // 距底部 100px 触发加载
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
      const next = Math.min(shown + PICKER_PAGE_SIZE, allPigs.length);
      renderChunk(shown, next);
      shown = next;
    }
  }, { passive: true });

  // 搜索过滤
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      if (!q) {
        enterPagedMode();
        return;
      }
      mode = "filtered";
      const filtered = allPigs.filter(p =>
        String(p.pNo).includes(q) || p.name.toLowerCase().includes(q)
      );
      list.innerHTML = filtered.map(pickerItemHTML).join("");
      list.scrollTop = 0;
    });
  }

  // 行点击 — 事件委托 (避免给每行都 addEventListener)
  list.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>(".de-pig-item");
    if (!target) return;
    const pNo = Number(target.dataset.pno || 0);
    const p = state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
    if (!p) return;
    const body = $("#deBody");
    if (!body) return;
    body.innerHTML = pigFormHTML(p);
    wirePigForm(false);
  });

  enterPagedMode();
}

function wirePigForm(isNew: boolean): void {
  // 绑定多选组件
  document.querySelectorAll<HTMLElement>(".de-multi-select").forEach(el => wireMultiSelect(el));

  // 数值字段实时校验 (负数 / 非数字 → 红色边框)
  const validateAll = wireNumericValidation([
    "deWeightSmall", "deWeightBig",
    "deRent", "dePrice", "deLifespan",
    "deShopA", "deShopB", "deShopC",
    "deFeedInterval", "deFeedTimes",
  ]);

  // 注: 原"编辑模式: 活动猪切换时显示/隐藏图鉴位置"逻辑已移除
  //      atlas 字段被隐藏为 hidden input,UI 上不展示,也不需要动态切换

  wireSaveButton("deSaveBtn", async () => {
    // 保存前最后一道校验: 有错误则拦截,提示用户
    if (!validateAll()) {
      const m = $("#deMsg");
      if (m) { m.textContent = "数值字段有错误,请检查红色高亮项"; m.className = "account-form-hint error"; }
      return;
    }
    await savePigFromForm(isNew);
  });
  $("#deCancelBtn")?.addEventListener("click", () => {
    const body = $("#deBody");
    if (!body) return;
    body.innerHTML = renderPigPicker();
    wirePigPicker();
  });
}

function wireBreedingForm(): void {
  // 可搜索单选组件
  document.querySelectorAll<HTMLElement>(".de-search-select").forEach(ss => wireSearchSelect(ss));

  wireSaveButton("dbSaveBtn", () => saveBreedingFromForm());
  $("#dbCancelBtn")?.addEventListener("click", () => {
    const body = $("#deBody");
    if (!body) return;
    body.innerHTML = breedingFormHTML();
    wireBreedingForm();
  });

  // 添加产出行
  const addBtn = $("#dbAddRowBtn");
  const rows = $("#dbOutcomeRows");
  if (addBtn && rows) {
    addBtn.addEventListener("click", () => {
      rows.appendChild(addOutcomeRow());
    });
  }

  // 已存在的行绑定删除
  rows?.querySelectorAll<HTMLElement>(".de-outcome-row").forEach(row => wireOutcomeRow(row));
}

/** 模块级产出 id 序号 — 保证多次表单销毁/重建能生成唯一 id */
let outcomeRowSeq = 0;

/** 添加一条产出行 (独立函数, 可测)
 *  返回的就是 wire/挂到 #dbOutcomeRows 后的 DOM 元素 (已 wire 好事件) */
export function addOutcomeRow(): HTMLElement {
  const newId = `dbOutcome${++outcomeRowSeq}`;
  const row = document.createElement("div");
  row.className = "de-outcome-row";
  row.innerHTML = `
    <div class="de-outcome-select-wrap">
      ${searchSelectHTML(newId, "", pigSearchOptions(), "", "搜索 pNo / 名称...")}
    </div>
    <input type="number" class="de-outcome-prob" placeholder="概率 %" min="0" step="any">
    <button type="button" class="de-outcome-del" title="删除此行">✕</button>
  `;
  wireOutcomeRow(row);
  return row;
}

function wireOutcomeRow(row: HTMLElement): void {
  // 行内可搜索选择 (新增行也要绑定)
  const ss = row.querySelector<HTMLElement>(".de-search-select");
  if (ss) wireSearchSelect(ss);
  const del = row.querySelector<HTMLElement>(".de-outcome-del");
  if (!del) return;
  del.addEventListener("click", () => {
    row.remove();
  });
}
