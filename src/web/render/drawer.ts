/**
 * 抽屉详情 (Detail Panel)
 */

import type { Pig } from "../js/types/index.js";
import { state } from "../js/state.js";
import { $, escHtml, imgUrl, stars, badgeMetaHTML, feedIntervalText, pigPicky, toast, handleAuthFailure } from "../js/utils.js";
import { deriveAcquisitions, setPigOwned, setPigBadge } from "../js/data.js";
import { customConfirm } from "../js/modal.js";
import { BLEED_TYPE_TEXT, METHOD_LABELS } from "../js/constants.js";
import { emit } from "../js/events.js";
import { getCurrentUser } from "../js/auth.js";

let currentDetailPNo: number | null = null;

async function confirmCancelOwned(p: Pig): Promise<boolean> {
  const name = p && p.name ? `「${p.name}」` : "这只猪";
  return await customConfirm(
    `确定要把${name}改为未拥有吗?`,
    `取消后,小章和大章记录也会一起清除。`
  );
}

async function setPigOwnedAfterConfirm(pNo: number, owned: boolean): Promise<boolean> {
  const p = state.pigsById.get(pNo) || state.eventPigsById.get(pNo);
  if (!owned && p && !(await confirmCancelOwned(p))) return false;
  setPigOwned(pNo, owned);
  return true;
}

/** 软删除调用 (活动猪 / 配种) — 复用 /api/atlas/update 的 action 路由 */
async function apiDelete(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const user = getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  try {
    const res = await fetch("/api/atlas/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, ...body }),
    });
    const data = await res.json() as { ok?: boolean; error?: string };
    if (res.status === 401) {
      handleAuthFailure();
      return { ok: false, error: "请先登录" };
    }
    if (!res.ok || data.ok === false) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    console.error("[apiDelete]", err);
    return { ok: false, error: "网络错误,请稍后重试" };
  }
}

function getPigByPNo(pNo: number): Pig | undefined {
  return state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
}

function linkAttr(pNo: number): string {
  return pNo && getPigByPNo(pNo) ? ` data-pno="${pNo}"` : "";
}

export function showDetail(pNo: number): void {
  const p = state.pigsById.get(pNo) || state.eventPigsById.get(pNo);
  if (!p) return;
  currentDetailPNo = pNo;
  const isEventPig = state.eventPigsById.has(pNo);
  const box = $("#drawerContent");
  if (!box) return;

  let posText = "";
  if (p.book && p.book <= 6) {
    posText = `图鉴${p.book} 页${p.page} #${p.slot}`;
  } else if (isEventPig) {
    posText = "活动图鉴";
  }

  const isOwn = isEventPig
    ? state.ownedEventPigs.has(p.pNo)
    : state.ownedSet.has(p.pNo);
  const collectBtn = isOwn
    ? `<button type="button" class="add-btn danger" id="drawerCollectBtn">✅ 已拥有</button>`
    : `<button type="button" class="add-btn" id="drawerCollectBtn">⬜ 未拥有</button>`;
  const raisingBtn = `<button type="button" class="add-btn secondary" id="drawerRaisingBtn">➕ 加入养成</button>`;
  const waitingBtn = `<button type="button" class="add-btn secondary" id="drawerWaitingBtn">📦 加入等待进货</button>`;

  const groups = deriveAcquisitions(p);
  const acqOrder = ["shop", "hunt", "hunt_event", "fail", "feed_special"];
  const acqHTML: string[] = [];
  for (const g of acqOrder) {
    if (!groups[g] || groups[g].length === 0) continue;
    const lines = groups[g].map(s => `<div>${escHtml(s)}</div>`).join("");
    acqHTML.push(
      `<div class="kv"><div class="k">${METHOD_LABELS[g as keyof typeof METHOD_LABELS] || g}</div>` +
      `<div class="v">${lines}</div></div>`
    );
  }
  if (acqHTML.length === 0) {
    acqHTML.push(`<div class="kv"><div class="v">无一般获得途径 (可能仅靠配种)</div></div>`);
  }

  // 配种记录
  const bleeds: Array<{
    pNo1: { pNo: number; name?: string; rent?: number };
    pNo2: { pNo: number; name?: string; rent?: number } | null;
    any: boolean;
    isview: number;
    result: Array<{ prob: number; pigKind: { pNo: number; name?: string; rare?: number; special?: boolean; rent?: number } }>;
  }> = [];
  for (const record of state.breedingTable || []) {
    const hasCurrentPig = (record.outcomes || []).some((o: { pNo: number }) => o.pNo === p.pNo);
    if (!hasCurrentPig) continue;
    const [p1, p2] = record.parents;
    const isAny = p2 === "*";
    const isview = record.visible ? 1 : -1;

    const getPigInfo = (pNo: number): { pNo: number; name?: string; rent?: number } => {
      const pig = state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
      return pig ? { pNo: pig.pNo, name: pig.name, rent: pig.rent } : { pNo };
    };

    const getKindInfo = (pNo: number): { pNo: number; name?: string; rare?: number; special?: boolean; rent?: number } => {
      const pig = state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
      return pig ? { pNo: pig.pNo, name: pig.name, rare: pig.rare, special: pig.special, rent: pig.rent } : { pNo };
    };

    bleeds.push({
      pNo1: getPigInfo(p1 as number),
      pNo2: isAny ? null : getPigInfo(p2 as number),
      any: isAny,
      isview,
      result: (record.outcomes || []).map(o => ({
        prob: o.prob,
        pigKind: getKindInfo(o.pNo),
      })),
    });
  }

  const order = [1, 0, -1, 3, 4, -3, -4, 2];
  const byView = new Map<string, typeof bleeds>();
  for (const b of bleeds) {
    const k = String(b.isview);
    if (!byView.has(k)) byView.set(k, []);
    byView.get(k)!.push(b);
  }

  const renderParentSlot = (info: { pNo?: number; name?: string; rent?: number } | undefined | null): string => {
    if (!info || !info.pNo) {
      return `<div class="slot any"><div class="slot-img-placeholder" aria-hidden="true">?</div><div class="pname">任意猪</div></div>`;
    }
    const img = imgUrl(info.pNo);
    return `<div class="slot"${linkAttr(info.pNo)}>` +
      (img ? `<img src="${img}" loading="lazy" alt="${escHtml(info.name || "")}">` : `<div class="slot-img-placeholder" aria-hidden="true">?</div>`) +
      `<div class="pname">${escHtml(info.name || "?")}</div>` +
      (info.rent ? `<div class="prent">借 ${info.rent}pt</div>` : "") +
      `</div>`;
  };

  const renderOutcomeSlot = (k: { pNo?: number; name?: string }, prob: number | undefined, _opts?: { isSelf?: boolean }): string => {
    const pNo = k.pNo;
    const img = pNo ? imgUrl(pNo) : "";
    let ownedToggle = "";
    if (pNo && state.eventPigsById.has(pNo)) {
      const isOwned = state.ownedEventPigs.has(pNo);
      ownedToggle = `<span class="owned-toggle${isOwned ? " is-on" : ""}" data-owned-pno="${pNo}" role="checkbox" aria-checked="${isOwned}" title="标记是否已获得此活动猪">${isOwned ? "✅ 已拥有" : "⬜ 未拥有"}</span>`;
    }
    return `<div class="slot out${_opts?.isSelf ? " is-self" : ""}"${pNo ? linkAttr(pNo) : ""}>` +
      (img ? `<img src="${img}" loading="lazy" alt="${escHtml(k.name || "")}">` : `<div class="slot-img-placeholder" aria-hidden="true">?</div>`) +
      `<div class="pname">${escHtml(k.name || "?")}</div>` +
      (prob != null ? `<div class="prob">${prob}%</div>` : "") +
      ownedToggle + `</div>`;
  };

  const recipeHTML: string[] = [];
  for (const iv of order) {
    const items = byView.get(String(iv));
    if (!items) continue;
    for (const r of items) {
      const p1Info = r.pNo1 || { pNo: 0 };
      const p2Info = r.pNo2 || { pNo: 0 };
      const p1Slot = renderParentSlot(p1Info);
      const p2Slot = renderParentSlot(r.any ? null : p2Info);
      const equations = (r.result || []).map(o => {
        const outSlot = renderOutcomeSlot(o.pigKind, o.prob);
        const p1Val = r.pNo1?.pNo ?? 0;
        const p2Val = r.any ? "*" : (r.pNo2?.pNo ?? "");
        const delBtn = getCurrentUser() ? `<button type="button" class="recipe-del-btn" data-parent1="${p1Val}" data-parent2="${p2Val}" data-outcome="${o.pigKind?.pNo ?? ""}" title="删除此配种">🗑</button>` : "";
        return `<div class="equation">${p1Slot}<div class="op">+</div>${p2Slot}<div class="op">=</div>${outSlot}${delBtn}</div>`;
      }).join("");
      recipeHTML.push(`<div class="recipe"><div class="tag">${BLEED_TYPE_TEXT[String(iv)] || `isview=${iv}`}</div>${equations}</div>`);
    }
  }
  const recipeBlock = recipeHTML.length > 0 ? recipeHTML.join("") : `<div class="kv">没有已公开的配种组合</div>`;

  const pigImg = imgUrl(p.pNo);

  // Reverse breeding
  const asParent = (state.breedByParent && state.breedByParent.get(p.pNo)) || [];
  const asParentByView = new Map<string, typeof asParent>();
  for (const b of asParent) {
    const k = String(b.isview);
    if (!asParentByView.has(k)) asParentByView.set(k, []);
    asParentByView.get(k)!.push(b);
  }
  const parentRecipeHTML: string[] = [];
  for (const iv of order) {
    const items = asParentByView.get(String(iv));
    if (!items) continue;
    items.sort((a, b) => {
      const an = a.partner ? (a.partner.name || "") : "zzz任意";
      const bn = b.partner ? (b.partner.name || "") : "zzz任意";
      return an.localeCompare(bn, "zh");
    });
    const selfSlot = renderParentSlot({ pNo: p.pNo, name: p.name, rent: p.rent });
    for (const r of items) {
      const partnerSlot = renderParentSlot((r.any || !r.partner) ? null : r.partner);
      const equations = (r.result || []).map(o => {
        const k = o.pigKind || {};
        const outSlot = renderOutcomeSlot(k, o.prob, { isSelf: k.pNo === p.pNo });
        const partnerPNo = r.partner?.pNo ?? (r.any ? "*" : "");
        const delBtn = getCurrentUser() ? `<button type="button" class="recipe-del-btn" data-parent1="${p.pNo}" data-parent2="${partnerPNo}" data-outcome="${k.pNo ?? ""}" title="删除此配种">🗑</button>` : "";
        return `<div class="equation">${selfSlot}<div class="op">+</div>${partnerSlot}<div class="op">=</div>${outSlot}${delBtn}</div>`;
      }).join("");
      parentRecipeHTML.push(`<div class="recipe"><div class="tag">${BLEED_TYPE_TEXT[String(iv)] || `isview=${iv}`}</div>${equations}</div>`);
    }
  }
  const parentBlock = parentRecipeHTML.length > 0 ? parentRecipeHTML.join("") : `<div class="kv">没有已知的配种产出 (可能仅作为被配出的结果)</div>`;

  const picky = pigPicky(p);
  const pickyChipText = picky.level === "none" ? "不挑食" : picky.label;
  const pickyChipTitle = picky.level === "none" ? "不挑食" : `${picky.label}: ${picky.foods.join(" / ")}`;
  const pickyChipClass = picky.level === "none" ? "chip" : (picky.level === "picky" ? "chip danger" : "chip warn");
  const grazeChip = p.isExer
    ? `<span class="chip ok"><span class="chip-icon">🌿</span><span class="chip-v">放牧</span></span>`
    : `<span class="chip"><span class="chip-icon">🏠</span><span class="chip-v">不放牧</span></span>`;
  const feedChip = `<span class="chip"><span class="chip-k">🍚 最少喂</span><span class="chip-v">${(p.feeding && p.feeding.times) || 0} 次</span></span>`;
  const intervalChip = ((p.feeding && p.feeding.times) || 0) > 0
    ? `<span class="chip"><span class="chip-k">⏱️ 喂食间隔</span><span class="chip-v">${escHtml(feedIntervalText(p.feeding && p.feeding.interval))}</span></span>`
    : "";
  const lifespanChip = p.lifespan ? `<span class="chip"><span class="chip-k">📅 成猪</span><span class="chip-v">${p.lifespan} 小时</span></span>` : "";
  const rentChip = p.rent ? `<span class="chip"><span class="chip-k">借猪</span><span class="chip-v">${p.rent}pt</span></span>` : "";
  const priceChip = `<span class="chip"><span class="chip-k">售价</span><span class="chip-v">${p.price}pt</span></span>`;
  const pickyChipEl = `<span class="${pickyChipClass}" title="${escHtml(pickyChipTitle)}"><span class="chip-icon">🍽️</span><span class="chip-v">${escHtml(pickyChipText)}</span></span>`;
  const pickyDetail = picky.level !== "none"
    ? `<div class="hero-foods"><span class="hero-foods-k">挑食食材</span><span class="hero-foods-v">${escHtml(picky.foods.join(" / "))}</span></div>`
    : "";

  box.innerHTML = `
    <div class="drawer-title-row">
      <h2>#${p.pNo} ${escHtml(p.name)}</h2>
      ${isEventPig && getCurrentUser() ? `<button type="button" class="drawer-name-del" id="drawerDeleteBtn" title="删除" aria-label="删除">🗑</button>` : ""}
    </div>
    <div class="drawer-actions">${collectBtn}${raisingBtn}${waitingBtn}</div>
    <div class="hero">
      ${pigImg ? `<img src="${pigImg}" alt="${escHtml(p.name)}">` : ""}
      <div class="info">
        <div class="hero-title">
          <span class="hero-color">${escHtml(p.color_text || "")}</span>
          <span class="${p.special ? "stars special" : "stars"}">${stars(p.rare, p.special)}</span>
        </div>
        ${posText ? `<div class="hero-pos">${escHtml(posText)}</div>` : ""}
        <div class="hero-chips">${rentChip}${priceChip}${grazeChip}${feedChip}${intervalChip}${lifespanChip}${pickyChipEl}</div>
        ${pickyDetail}${badgeMetaHTML(p)}
      </div>
    </div>
    ${p.description ? `<div class="kv note" style="margin-top:10px"><div class="k">描述</div><div class="v">${escHtml(p.description)}</div></div>` : ""}
    ${p.breedingGuide?.requirements ? `<div class="kv note warn" style="margin-top:10px"><div class="k">强制要求</div><div class="v">${escHtml(p.breedingGuide.requirements)}</div></div>` : ""}
    ${p.breedingGuide?.tips ? `<div class="kv note tip" style="margin-top:6px"><div class="k">养成建议</div><div class="v">${escHtml(p.breedingGuide.tips)}</div></div>` : ""}
    ${p.hints && p.hints.length > 0 ? `<div class="kv note hints" style="margin-top:10px"><div class="k">提示</div><div class="v"><ul class="hints-list">${p.hints.map(h => `<li>${escHtml(h)}</li>`).join("")}</ul></div></div>` : ""}
    <div class="section"><h3>获得方式</h3>${acqHTML.join("")}</div>
    ${p.rare !== 6 ? `<div class="section"><h3>它能配出的崽</h3>${parentBlock}</div>` : ""}
    ${p.rare !== 6 || bleeds.length > 0 ? `<div class="section"><h3>配种配出它的方式</h3>${recipeBlock}</div>` : ""}
  `;

  // Wire buttons
  const cbtn = document.getElementById("drawerCollectBtn");
  if (cbtn) {
    cbtn.addEventListener("click", async () => {
      const wasOwn = isOwn;
      if (!(await setPigOwnedAfterConfirm(p.pNo, !wasOwn))) return;
      toast(wasOwn ? `已取消: ${p.name}` : `已标记拥有: ${p.name}`);
      emit("owned-changed", p.pNo);
      showDetail(p.pNo);
    });
  }
  const rbtn = document.getElementById("drawerRaisingBtn");
  if (rbtn) rbtn.addEventListener("click", () => emit("add-raising", { pNo: p.pNo }));
  const wbtn = document.getElementById("drawerWaitingBtn");
  if (wbtn) wbtn.addEventListener("click", () => emit("add-raising", { pNo: p.pNo, status: "waiting" }));

  // 活动猪软删除 — status='removed', 后端校验 special=1
  const dbtn = document.getElementById("drawerDeleteBtn");
  if (dbtn) {
    dbtn.addEventListener("click", async () => {
      if (!(await customConfirm(`确定要删除「${escHtml(p.name)}」吗？`))) return;
      const result = await apiDelete({ action: "deletePig", pig: { pNo: p.pNo } });
      if (result.ok) {
        toast(`已删除: ${p.name}`);
        closeDrawer();
        emit("ui-refresh", undefined);
      } else {
        toast(result.error || "删除失败", 3200);
      }
    });
  }

  // 配种每行 “🗑” 删除 — 仅按钮所在的那条 outcome 被删除,其他同组产出保留
  document.querySelectorAll<HTMLElement>(".recipe-del-btn").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const parent1 = Number(btn.dataset.parent1);
      const parent2Raw = btn.dataset.parent2;
      const parent2 = parent2Raw === "*" ? -1 : Number(parent2Raw);
      const outcomePNo = Number(btn.dataset.outcome);
      if (!parent1 || !outcomePNo) return;
      if (!(await customConfirm(`确定要删除这条配种记录吗？`))) return;
      const result = await apiDelete({
        action: "deleteBreeding",
        breeding: { parent1, parent2: parent2Raw === "*" ? "*" : parent2, outcomePNo },
      });
      if (result.ok) {
        toast("配种已删除");
        emit("ui-refresh", undefined);
        showDetail(p.pNo); // 重渲染抽屉
      } else {
        toast(result.error || "删除失败", 3200);
      }
    });
  });

  $("#drawer")?.classList.add("open");
  $("#drawerBg")?.classList.add("open");
}

export function closeDrawer(): void {
  const drawer = $("#drawer"), bg = $("#drawerBg");
  drawer?.classList.remove("open");
  bg?.classList.remove("open");
  if (drawer) drawer.style.transform = "";
  if (drawer) drawer.style.transition = "";
  if (bg) bg.style.opacity = "";
  currentDetailPNo = null;
}

export function getCurrentDetailPNo(): number | null {
  return currentDetailPNo;
}


export function setupDrawer(): void {
  $("#drawerBg")?.addEventListener("click", closeDrawer);

  const drawerEl = $("#drawer");
  if (!drawerEl) return;
  const drawer: HTMLElement = drawerEl;
  const SWIPE_CLOSE_PX = 100;
  const DRAG_START_PX = 6;
  let startY = 0, currentY = 0, activePointerId: number | null = null;
  let armed = false, dragging = false;

  drawer.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!drawer.classList.contains("open")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const onHandle = (e.target as HTMLElement).closest(".handle");
    if (!onHandle && drawer.scrollTop > 0) return;
    armed = true; dragging = false;
    startY = e.clientY; currentY = startY;
    activePointerId = e.pointerId;
    drawer.style.transition = "none";
  });

  drawer.addEventListener("pointermove", (e: PointerEvent) => {
    if (!armed || e.pointerId !== activePointerId) return;
    currentY = e.clientY;
    const dy = currentY - startY;
    if (dy <= 0) {
      drawer.style.transform = "";
      const bg = $("#drawerBg");
      if (bg) bg.style.opacity = "";
      return;
    }
    if (dy > DRAG_START_PX) {
      dragging = true;
      if (drawer.setPointerCapture && activePointerId !== null) {
        try { drawer.setPointerCapture(activePointerId); } catch { /* ignore */ }
      }
    }
    if (dragging) {
      drawer.style.transform = `translateY(${dy}px)`;
      const progress = Math.min(1, dy / 300);
      const bg = $("#drawerBg");
      if (bg) bg.style.opacity = String(Math.max(0.2, 1 - progress * 0.8));
    }
  });

  drawer.addEventListener("touchmove", (e: TouchEvent) => {
    if (!armed) return;
    const dy = (e.touches[0] ? e.touches[0].clientY : currentY) - startY;
    if (dy > DRAG_START_PX && e.cancelable) e.preventDefault();
  }, { passive: false });

  function endDrag(): void {
    if (!armed) return;
    const dy = currentY - startY;
    drawer.style.transition = "";
    const bg = $("#drawerBg");
    if (bg) bg.style.opacity = "";
    if (dragging && dy > SWIPE_CLOSE_PX) closeDrawer();
    else drawer.style.transform = "";
    armed = false; dragging = false;
    activePointerId = null;
  }
  drawer.addEventListener("pointerup", endDrag);
  drawer.addEventListener("pointercancel", endDrag);
  drawer.addEventListener("pointerleave", (e: PointerEvent) => {
    if (!drawer.hasPointerCapture || !drawer.hasPointerCapture(e.pointerId)) endDrag();
  });

  const content = $("#drawerContent");
  content?.addEventListener("click", async (e: Event) => {
    const badgeStateBtn = (e.target as HTMLElement).closest(".badge-state");
    if (badgeStateBtn) {
      e.stopPropagation();
      const pNo = parseInt(badgeStateBtn.getAttribute("data-badge-pno") || "", 10);
      const kind = badgeStateBtn.getAttribute("data-badge-kind");
      if (!pNo || (kind !== "small" && kind !== "big")) return;
      const set = kind === "small" ? state.smallBadges : state.bigBadges;
      setPigBadge(pNo, kind as "small" | "big", !set.has(pNo));
      if (currentDetailPNo) showDetail(currentDetailPNo);
      return;
    }
    const chk = (e.target as HTMLElement).closest("[data-owned-pno]");
    if (chk) {
      e.stopPropagation();
      const pNo = parseInt(chk.getAttribute("data-owned-pno") || "", 10);
      if (!pNo) return;
      if (!(await setPigOwnedAfterConfirm(pNo, !state.ownedEventPigs.has(pNo)))) return;
      if (currentDetailPNo) showDetail(currentDetailPNo);
      return;
    }
    const t = (e.target as HTMLElement).closest("[data-pno]");
    if (!t) return;
    const target = parseInt(t.getAttribute("data-pno") || "", 10);
    if (!target || target === currentDetailPNo) return;
    e.stopPropagation();
    showDetail(target);
    if (content) content.scrollTop = 0;
  });
}
