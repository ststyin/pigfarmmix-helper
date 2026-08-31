/**
 * 数据管理 — 编辑已有猪 / 新增猪 / 新增配种
 *
 * 数据写入 D1 (POST /api/atlas/update), 保存成功后重新拉取图鉴数据。
 * 表单字段友好化: JSON 字段翻译成具体字段, 高级 JSON 折叠保留。
 * 多选下拉框支持搜索, 活动猪/普通猪区分显示, 养成指南重命名。
 */

import type { Pig, PigAcquisition, PigFeeding, BreedingGuide } from "../js/types/index.js";
import { state } from "../js/state.js";
import { $ } from "../js/utils.js";
import { getCurrentUser } from "../js/auth.js";
import { toast } from "../js/utils.js";
import { refreshDataFromServer } from "../js/data.js";
import { emit } from "../js/events.js";
import { COLOR_TEXT, HUNT_SITES, FEED_LABELS } from "../js/constants.js";

// ---------- 小工具 ----------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
function closeAllDropdowns(): void {
  document.querySelectorAll<HTMLElement>(".de-multi-panel:not([hidden]), .de-search-select-panel:not([hidden])").forEach(p => {
    p.hidden = true;
  });
  document.querySelectorAll<HTMLElement>(".de-multi-toggle").forEach(t => t.setAttribute("aria-expanded", "false"));
  document.querySelectorAll<HTMLElement>(".de-multi-select, .de-search-select").forEach(s => {
    s.classList.remove("open");
    const input = s.querySelector<HTMLInputElement>(".de-search-select-input");
    if (input) input.value = "";
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

/** 从友好字段构建 acquisition 对象 (与基线对比,仅输出变更字段)
 *  - 新增 (base=undefined): 只要填了值就输出
 *  - 编辑: 与 base?.X 逐字段对比,差异才输出
 *  - 返回空对象表示本次未做任何改动 → 上层不发送该 key → 后端 partial merge 保留原值
 */
function buildAcquisition(base: PigAcquisition | undefined, isNew: boolean): PigAcquisition {
  const a: PigAcquisition = {};

  // 商店 — 仅编辑模式显示。三个槽位独立处理:
  //   用户填了某槽 → 该槽用 form 值; 未填 (null) → 保留 base 在该槽的值
  //   三个槽都跟 base 一致 → 不输出 shop
  //   任一槽 form 有填且与 base 不同 → 输出完整 [a, b, c] (未填的槽用 base 的值填上)
  if (!isNew) {
    const shopInputs: [number | null, number | null, number | null] = [
      numOrNull(val("#deShopA")),
      numOrNull(val("#deShopB")),
      numOrNull(val("#deShopC")),
    ];
    const origShop: [number, number, number] = base?.shop
      ? [base.shop[0] ?? 0, base.shop[1] ?? 0, base.shop[2] ?? 0]
      : [0, 0, 0];
    let shopChanged = false;
    const merged: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const formVal = shopInputs[i];
      const origVal = origShop[i];
      const finalVal = formVal != null ? formVal / 100 : origVal;
      merged[i] = finalVal;
      if (formVal != null && Math.abs(finalVal - origVal) > 1e-4) shopChanged = true;
    }
    if (shopChanged) a.shop = merged;
  }

  // 狩猎站点 (多选): 变更才输出 (不含 prob — 后端会保留原 prob)
  const sites = getMultiSelectValues("deHuntSites");
  const origSites = base?.hunt?.sites || [];
  if (!arraysEqual(sites, origSites)) a.hunt = { sites };

  // 养成失败来源 — 仅编辑模式
  if (!isNew) {
    const fail = getMultiSelectValues("deFailFrom");
    const origFail = base?.fail || [];
    if (!arraysEqual(fail, origFail)) a.fail = fail;
  }

  const specialFeeding = ($("#deSpecialFeeding") as HTMLInputElement | null)?.checked ?? false;
  const origSF = base?.specialFeeding || false;
  if (isNew || origSF !== specialFeeding) a.specialFeeding = specialFeeding;

  return a;
}

/** 从友好字段构建 feeding 对象 (与基线对比,仅输出变更字段) */
function buildFeeding(base: PigFeeding | undefined): PigFeeding {
  const f: PigFeeding = {};
  const interval = numOrNull(val("#deFeedInterval"));
  const times = numOrNull(val("#deFeedTimes"));
  const picky = getMultiSelectValues("deFeedPicky");

  if (interval != null && interval !== base?.interval) f.interval = interval;
  if (times != null && times !== base?.times) f.times = times;
  if (!arraysEqual(picky, base?.picky || [])) f.picky = picky;
  return f;
}

/** 从友好字段构建 breedingGuide 对象 (与基线对比,仅输出变更字段) */
function buildGuide(base: BreedingGuide | undefined): BreedingGuide {
  const g: BreedingGuide = {};
  const req = val("#deGuideReq");
  const tips = val("#deGuideTips");
  if (req && req !== (base?.requirements || "")) g.requirements = req;
  if (tips && tips !== (base?.tips || "")) g.tips = tips;
  return g;
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
  // 发出的值: 高级 JSON > diff 后的友好对象 > undefined(不发送,后端保留)
  pig.acquisition = acqJSON !== undefined ? acqJSON : (Object.keys(acq).length ? acq : undefined);
  pig.feeding = feedJSON !== undefined ? feedJSON : (Object.keys(feed).length ? feed : undefined);
  pig.breedingGuide = guideJSON !== undefined ? guideJSON : (Object.keys(guide).length ? guide : undefined);

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
    if (isNew && result.pig?.pNo) {
      toast(`已新增 #${result.pig.pNo},可在「编辑猪」中查看`, 2800);
    } else {
      toast("已保存", 2200);
    }
    // 切回 picker — 让用户继续编辑别的或看到刚加的猪
    const editTab = $("#mineDataView")?.querySelector<HTMLElement>('.de-tab[data-de-tab="edit"]');
    editTab?.click();
  } else {
    m.textContent = result.error || "保存失败";
    m.className = "account-form-hint error";
  }
}

async function saveBreedingFromForm(): Promise<void> {
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
    // 概率留空 = 1.0 (100%) — 活动猪配种默认值,避免用户被罚填不必要的数据
    const prob = probText === "" ? 1.0 : Number(probText);
    if (pNo > 0) outcomes.push({ pNo, prob: Number.isFinite(prob) ? Math.max(0, prob) : 1.0 });
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

let documentClickBound = false;

export function renderDataView(): void {
  const root = $("#mineDataView");
  if (!root) return;

  // 全局点击关闭下拉 (仅绑定一次)
  if (!documentClickBound) {
    documentClickBound = true;
    document.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t && !t.closest(".de-multi-select, .de-search-select")) closeAllDropdowns();
    });
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
  const pigs = [...state.pigsById.values(), ...state.eventPigsById.values()]
    .sort((a, b) => a.pNo - b.pNo);
  return `
    <div class="de-picker">
      <input type="search" id="dePigSearch" class="search" placeholder="搜索 pNo / 名称...">
      <div class="de-pig-list" id="dePigList">
        ${pigs.map(p => `
          <button type="button" class="de-pig-item" data-pno="${p.pNo}">
            <span class="de-pig-no">#${p.pNo}</span>
            <span class="de-pig-name">${esc(p.name)}</span>
            <span class="de-pig-rare">${"★".repeat(Math.max(1, Math.min(6, p.rare)))}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function wirePigPicker(): void {
  const search = $("#dePigSearch") as HTMLInputElement | null;
  const list = $("#dePigList");
  if (!list) return;
  if (search) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll<HTMLElement>(".de-pig-item").forEach(item => {
        const no = item.dataset.pno || "";
        const name = item.querySelector(".de-pig-name")?.textContent || "";
        item.style.display = (!q || no.includes(q) || name.toLowerCase().includes(q)) ? "" : "none";
      });
    });
  }
  list.querySelectorAll<HTMLElement>(".de-pig-item").forEach(item => {
    item.addEventListener("click", () => {
      const pNo = Number(item.dataset.pno || 0);
      const p = state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
      if (!p) return;
      const body = $("#deBody");
      if (!body) return;
      body.innerHTML = pigFormHTML(p);
      wirePigForm(false);
    });
  });
}

function wirePigForm(isNew: boolean): void {
  // 绑定多选组件
  document.querySelectorAll<HTMLElement>(".de-multi-select").forEach(el => wireMultiSelect(el));

  // 注: 原"编辑模式: 活动猪切换时显示/隐藏图鉴位置"逻辑已移除
  //      atlas 字段被隐藏为 hidden input,UI 上不展示,也不需要动态切换

  wireSaveButton("deSaveBtn", () => savePigFromForm(isNew));
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
      const row = document.createElement("div");
      row.className = "de-outcome-row";
      row.innerHTML = `
        <div class="de-outcome-select-wrap">
          ${searchSelectHTML("", "", pigSearchOptions(), "", "搜索 pNo / 名称...")}
        </div>
        <input type="number" class="de-outcome-prob" placeholder="概率 %" min="0" step="any">
        <button type="button" class="de-outcome-del" title="删除此行">✕</button>
      `;
      rows.appendChild(row);
      wireOutcomeRow(row);
    });
  }

  // 已存在的行绑定删除
  rows?.querySelectorAll<HTMLElement>(".de-outcome-row").forEach(row => wireOutcomeRow(row));
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
