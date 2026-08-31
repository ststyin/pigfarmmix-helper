/**
 * 猪卡片 / 列表行构建 — 列表(186/Events) / 我的 共用
 */

import type { Pig } from "../js/types/index.js";
import { state } from "../js/state.js";
import { el, imgUrl, stars, fmtKg, badgeWeights, pigPicky } from "../js/utils.js";
import { setPigOwned, setPigBadge } from "../js/data.js";
import { customConfirm } from "../js/modal.js";
import { emit } from "../js/events.js";

async function confirmCancelOwned(p: Pig): Promise<boolean> {
  const name = p && p.name ? `「${p.name}」` : "这只猪";
  return await customConfirm(
    `确定要把${name}改为未拥有吗?`,
    `取消后,小章和大章记录也会一起清除。`
  );
}

async function setPigOwnedAfterConfirm(pNo: number, owned: boolean): Promise<boolean> {
  const p = state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
  if (!owned && p && !(await confirmCancelOwned(p))) return false;
  setPigOwned(pNo, owned);
  return true;
}

export interface CardOptions {
  showCollected?: boolean;
  showBadges?: boolean;
}

interface BadgeChipSpec {
  kind: "small" | "big";
  has: boolean;
  weight: number;
  op: string;
  iconSrc: string;
  label: string;
}

function badgeSpecsFor(p: Pig, showBadges: boolean): BadgeChipSpec[] {
  const w = badgeWeights(p);
  if (!w) return [];
  return [
    {
      kind: "small",
      has: showBadges && state.smallBadges.has(p.pNo),
      weight: w.small,
      op: "≤",
      iconSrc: "/img/small.png",
      label: "小章",
    },
    {
      kind: "big",
      has: showBadges && state.bigBadges.has(p.pNo),
      weight: w.big,
      op: "≥",
      iconSrc: "/img/big.png",
      label: "大章",
    },
  ];
}

function makeBadgeChip(p: Pig, spec: BadgeChipSpec, interactive: boolean): HTMLElement {
  const cls = `card-badge-chip ${spec.kind}${spec.has ? " is-on" : ""}`;
  const attrs: Record<string, unknown> = {
    class: cls,
    title: `${spec.label}: ${spec.op} ${fmtKg(spec.weight)}kg${spec.has ? " · 已拥有" : ""}`,
  };
  if (interactive) {
    attrs.onclick = (ev: Event) => {
      ev.stopPropagation();
      const set = spec.kind === "small" ? state.smallBadges : state.bigBadges;
      setPigBadge(p.pNo, spec.kind, !set.has(p.pNo));
      emit("owned-changed", p.pNo);
    };
  }
  const tag = interactive ? "button" : "span";
  return el(tag as "button", attrs, [
    el("img", { class: "card-badge-img", src: spec.iconSrc, alt: spec.label }),
    el("span", { class: "card-badge-w" }, `${spec.op}${fmtKg(spec.weight)}`),
  ]);
}

function ownedToggle(p: Pig, isOwn: boolean): HTMLElement {
  return el("button", {
    class: "card-owned-toggle" + (isOwn ? " is-on" : ""),
    "aria-pressed": String(isOwn),
    title: isOwn ? "已拥有 — 点击取消" : "标记为已拥有",
    onclick: async (ev: Event) => {
      ev.stopPropagation();
      if (!(await setPigOwnedAfterConfirm(p.pNo, !isOwn))) return;
      emit("owned-changed", p.pNo);
    },
  }, isOwn ? "✅ 已拥有" : "⬜ 未拥有");
}

function isEventPig(p: Pig): boolean {
  return p.book === 7 || !state.pigsById.has(p.pNo);
}

function isPigOwned(p: Pig): boolean {
  return isEventPig(p)
    ? state.ownedEventPigs.has(p.pNo)
    : state.ownedSet.has(p.pNo);
}

function pigMetaParts(p: Pig): (HTMLElement | null)[] {
  const posText = p.book && p.book <= 6
    ? `图鉴${p.book} 页${p.page} #${p.slot}`
    : (p.book === 7 ? "Events图鉴" : "");
  const grazeBadge = p.isExer
    ? el("span", { class: "graze yes", title: "放牧" }, "🌿 放牧")
    : el("span", { class: "graze no", title: "不放牧" }, "🏠 不放牧");
  const picky = pigPicky(p);
  const pickyTitle = picky.level === "none"
    ? "🍽️ 不挑食"
    : `🍽️ ${picky.label}: ${picky.foods.join(" / ")}`;
  const pickyLabel = picky.level === "none" ? "🍽️ 不挑食" : `🍽️ ${picky.label}`;
  const pickyEl = el("span", { class: "picky " + picky.level, title: pickyTitle }, pickyLabel);
  const feedN = (p.feeding && p.feeding.times) || 0;
  const editorName = p.updatedByName || "System";
  const editorTitle = p.updatedAt
    ? `最后编辑: ${editorName} · ${new Date(p.updatedAt).toLocaleString("zh-CN")}`
    : `最后编辑: ${editorName}`;
  const editorEl = el("span", { class: "last-editor", title: editorTitle }, `✏️ ${editorName}`);
  return [
    p.color_text ? el("span", { class: "color" }, p.color_text) : null,
    posText ? el("span", { class: "pos" }, posText) : null,
    el("span", { class: "feed", title: `最少喂食 ${feedN} 次` }, `🍚 ${feedN}`),
    grazeBadge,
    pickyEl,
    editorEl,
  ];
}

function starEl(p: Pig): HTMLElement {
  return el("span", { class: "stars" + (p.special ? " special" : "") }, stars(p.rare, p.special));
}

// ==================== 列表行(186 / Events tab 用) ====================

export function buildListRow(p: Pig, opts: CardOptions = {}): HTMLElement {
  const { showCollected = true, showBadges = false } = opts;
  const isOwn = isPigOwned(p);
  const children: (HTMLElement | Text | string)[] = [];

  // 缩略图
  children.push(el("div", { class: "thumb" },
    el("img", { src: imgUrl(p.pNo), loading: "lazy", alt: p.name })
  ));

  // 信息区: 名称+星级 一行, 属性 meta 一行, 章 chip 一行(可选)
  const infoChildren: (HTMLElement | null)[] = [
    el("div", { class: "name-line" }, [
      el("span", { class: "name" }, p.name),
      starEl(p),
    ]),
    el("div", { class: "meta" }, pigMetaParts(p).filter(Boolean)),
  ];
  const badgeRow = badgeSpecsFor(p, showBadges);
  if (badgeRow.length) {
    infoChildren.push(
      el("div", { class: "badge-row" + (showBadges ? " interactive" : "") },
        badgeRow.map(s => makeBadgeChip(p, s, showBadges)))
    );
  }
  children.push(el("div", { class: "info" }, infoChildren));

  // 右侧: 已拥有切换(仅「我的」场景)
  if (showCollected) {
    children.push(ownedToggle(p, isOwn));
  }

  return el("div", {
    class: "list-row" + (showCollected && isOwn ? " collected" : ""),
    "data-pno": String(p.pNo),
    "data-show-collected": showCollected ? "1" : "0",
    "data-show-badges": showBadges ? "1" : "0",
    onclick: () => emit("show-detail", p.pNo),
  }, children);
}

export { setPigOwnedAfterConfirm };
