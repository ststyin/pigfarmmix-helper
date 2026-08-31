/**
 * @vitest-environment jsdom
 *
 * Bug 5 回归测试: 「添加产出行」必须生成唯一 containerId,
 * 多条产出行能各自存值, getSearchSelectValue() / 直接 query 都能识别。
 *
 * 原实现给所有添加行的 search-select 用了同一个 data-ss-id=""。
 * 当前因为收集逻辑用 row.querySelector(".de-search-select") 而不是 id 查询,
 * 没有立即炸, 但裸 id 冲突是定时炸弹 — 未来任何按 id 取元素的逻辑都会拿到第一行。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as auth from "../js/auth.js";
import * as dataMod from "../js/data.js";
import * as events from "../js/events.js";
import { state } from "../js/state.js";

vi.spyOn(auth, "getCurrentUser").mockReturnValue({ id: "u1", nickname: "tester", deviceCode: "d1" } as any);
vi.spyOn(dataMod, "refreshDataFromServer").mockResolvedValue({ ok: true });
vi.spyOn(events, "emit").mockImplementation(() => {});

import { addOutcomeRow } from "./data-editor.js";
import type { Pig } from "../js/types/index.js";

beforeEach(() => {
  document.body.innerHTML = `<div id="dbOutcomeRows"></div>`;
  state.pigsById.set(1, { pNo: 1, name: "甲", rare: 3, color: 1 } as Pig);
  state.pigsById.set(2, { pNo: 2, name: "乙", rare: 3, color: 1 } as Pig);
  state.pigsById.set(3, { pNo: 3, name: "丙", rare: 3, color: 1 } as Pig);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("addOutcomeRow - 唯一 id", () => {
  it("添加 3 行 → 每行的 search-select 应有不同 data-ss-id", () => {
    const container = document.getElementById("dbOutcomeRows")!;
    for (let i = 0; i < 3; i++) {
      container.appendChild(addOutcomeRow());
    }
    const sels = container.querySelectorAll<HTMLElement>(".de-search-select");
    expect(sels.length).toBe(3);
    const ids = Array.from(sels).map(s => s.getAttribute("data-ss-id"));
    expect(new Set(ids).size).toBe(3); // 三行 id 必须互不重复
    for (const id of ids) expect(id).toBeTruthy(); // 不能是空字符串
  });

  it("点击 delete 按钮能删掉对应行", () => {
    const container = document.getElementById("dbOutcomeRows")!;
    const r1 = addOutcomeRow();
    const r2 = addOutcomeRow();
    container.appendChild(r1);
    container.appendChild(r2);

    const del1 = r1.querySelector<HTMLElement>(".de-outcome-del");
    del1?.click();

    expect(container.querySelectorAll(".de-outcome-row").length).toBe(1);
    expect(container.contains(r2)).toBe(true);
  });
});
