/**
 * @vitest-environment jsdom
 *
 * Bug 2 回归测试: 配种产出概率输入框留空时默认值应为 100 (与种子数据语义一致),
 * 不应是 1.0 (display "${prob}%" 显示为 1%)。
 *
 * commit 3fbd49d 的标题「概率留空默认 100%」但 src 实际是 1.0,与 commit message 不符。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as auth from "../js/auth.js";
import * as dataMod from "../js/data.js";

vi.spyOn(auth, "getCurrentUser").mockReturnValue({ id: "u1", nickname: "tester", deviceCode: "d1" } as any);
vi.spyOn(dataMod, "refreshDataFromServer").mockResolvedValue({ ok: true });

import { saveBreedingFromForm } from "./data-editor.js";
import * as events from "../js/events.js";

// 捕获 fetch 调用
const fetchCalls: { url: string; body: any }[] = [];
(globalThis as any).fetch = vi.fn(async (url: string, opts: any) => {
  fetchCalls.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ ok: true, breeding: true }) };
});

vi.spyOn(events, "emit").mockImplementation(() => {});

beforeEach(() => {
  document.body.innerHTML = "";
  fetchCalls.length = 0;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("saveBreedingFromForm - 概率默认值", () => {
  it("用户留空概率 → 提交到后端的 prob 必须是 100 (与显示 ${prob}% 一致)", async () => {
    // 渲染一个最小的 breeding form DOM
    // saveBreedingFromForm 依赖: data-ss-id="dbParent1", "dbParent2", #dbOutcomeRows, .de-outcome-row 等
    document.body.innerHTML = `
      <div id="deBody">
        <div class="de-search-select" data-ss-id="dbParent1" data-ss-value="7">
          <span class="de-ss-selected">#7 父</span>
        </div>
        <div class="de-search-select" data-ss-id="dbParent2" data-ss-value="*">
          <span class="de-ss-selected">* 任意</span>
        </div>
        <div id="dbOutcomeRows">
          <div class="de-outcome-row">
            <div class="de-search-select" data-ss-value="42">
              <span class="de-ss-selected">#42 子</span>
            </div>
            <input type="number" class="de-outcome-prob" value="" />
            <button type="button" class="de-outcome-del">✕</button>
          </div>
        </div>
        <p id="dbMsg"></p>
      </div>
      <div id="mineDataView">
        <button class="de-tab" data-de-tab="breeding"></button>
      </div>
    `;

    await saveBreedingFromForm();

    expect(fetchCalls).toHaveLength(1);
    const sent = fetchCalls[0].body;
    expect(sent.breeding.outcomes).toEqual([{ pNo: 42, prob: 100 }]);
    // 关键断言: 不能是 1.0 (历史 bug)
    expect(sent.breeding.outcomes[0].prob).not.toBe(1.0);
  });

  it("display `${prob}%` 与种子数据 (60/100) 同单位 — 1.0 会显示成 1%,与 commit 描述 100% 矛盾", () => {
    // 这是 commit message 与实现矛盾的直接演示
    const storedProb = 100;
    const displayed = `${storedProb}%`;
    expect(displayed).toBe("100%");
    // 历史 bug: prob=1.0 会显示成 "1%"
    const buggyStored = 1.0;
    const buggyDisplay = `${buggyStored}%`;
    expect(buggyDisplay).toBe("1%"); // ❌ 与 commit 描述不符
  });
});
