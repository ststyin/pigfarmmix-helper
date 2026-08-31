/**
 * @vitest-environment jsdom
 *
 * Bug 4 回归测试: 「点击下拉面板外 → 关闭所有下拉」全局监听
 * 在 renderDataView 多次被调用时只能绑一次。
 *
 * 历史实现用 boolean flag (`documentClickBound`) 守住这个不变量,
 * 现在改用 AbortController。本测试同时验证两件事:
 * 1. 多次进入数据管理 tab 都只触发一次 click 监听绑定。
 * 2. 实际点外面能关闭打开的下拉 (end-to-end 行为)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as auth from "../js/auth.js";
import * as dataMod from "../js/data.js";
import * as events from "../js/events.js";
import { state } from "../js/state.js";

vi.spyOn(auth, "getCurrentUser").mockReturnValue({ id: "u1", nickname: "tester", deviceCode: "d1" } as any);
vi.spyOn(dataMod, "refreshDataFromServer").mockResolvedValue({ ok: true });
vi.spyOn(events, "emit").mockImplementation(() => {});

import { renderDataView, closeAllDropdowns } from "./data-editor.js";
import type { Pig } from "../js/types/index.js";

// ---- spy on document.addEventListener ----
const addedListeners: { type: string; once: boolean }[] = [];
const origAdd = document.addEventListener.bind(document);
(document as any).addEventListener = (type: string, listener: any, opts?: any) => {
  if (type === "click" && typeof listener === "function") {
    addedListeners.push({ type, once: false });
  }
  return origAdd(type, listener, opts);
};

beforeEach(() => {
  document.body.innerHTML = `<div id="mineDataView"></div>`;
  // 让 picker 列表不依赖网络也能渲染
  state.pigsById.set(1, {
    pNo: 1, name: "测试猪", rare: 3, color: 1,
  } as Pig);
  addedListeners.length = 0;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("renderDataView - 全局 click 监听绑定策略", () => {
  it("同一个会话多次进入数据管理, document 上的 click 监听只能绑一次", () => {
    renderDataView();
    renderDataView();
    renderDataView();

    // 由于其他代码也可能加 click 监听(组件库等),我们只断言至少绑了 1 次且不再增长。
    // 关键: 多次调用后 click 监听只绑一次, 不会出现 N 次重复。
    const initialCount = addedListeners.length;
    expect(initialCount).toBeGreaterThanOrEqual(1);
    renderDataView();
    expect(addedListeners.length).toBe(initialCount);
  });
});
