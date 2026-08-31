/**
 * @vitest-environment jsdom
 *
 * Bug 3 回归测试: closeAllDropdowns 必须清掉多选下拉里的搜索框 (.de-multi-search)
 * 与可搜索单选里 (.de-search-select-input) 的残留文字。
 *
 * 复现: 用户在多选下拉里输入了过滤词 → 关闭面板 → 再打开 → 搜索框还残留上次的过滤词,
 * 导致看不见初始列表状态。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeAllDropdowns } from "./data-editor.js";

function makeMultiSelect(id: string, searchInputId: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="de-multi-select" data-multi-id="${id}">
      <button type="button" class="de-multi-toggle" aria-expanded="true"></button>
      <div class="de-multi-panel">
        <input type="search" class="de-multi-search" id="${searchInputId}" />
        <div class="de-multi-options" id="${id}"></div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  return wrap.querySelector(".de-multi-select") as HTMLElement;
}

function makeSearchSelect(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="de-search-select" data-ss-id="dbParent1">
      <button type="button" class="de-ss-toggle">
        <span class="de-ss-selected">请选择...</span>
      </button>
      <div class="de-search-select-panel">
        <input type="search" class="de-search-select-input" />
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  return wrap.querySelector(".de-search-select") as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("closeAllDropdowns - 多选下拉的搜索框残留", () => {
  it("用户输入过滤词后关闭 → 再打开 → multi-search 输入框已被清空", () => {
    const ms = makeMultiSelect("deHuntSites", "msSearch");
    const panel = ms.querySelector(".de-multi-panel") as HTMLElement;
    panel.hidden = false;
    const input = ms.querySelector(".de-multi-search") as HTMLInputElement;
    input.value = "草原";

    closeAllDropdowns();

    expect(panel.hidden).toBe(true);
    expect(ms.classList.contains("open")).toBe(false);
    expect(input.value).toBe(""); // ❌ 历史 bug 这里失败
  });

  it("search-select 的搜索框同样被清空", () => {
    const ss = makeSearchSelect();
    const panel = ss.querySelector(".de-search-select-panel") as HTMLElement;
    panel.hidden = false;
    const input = ss.querySelector(".de-search-select-input") as HTMLInputElement;
    input.value = "123";

    closeAllDropdowns();

    expect(panel.hidden).toBe(true);
    expect(input.value).toBe("");
  });
});
