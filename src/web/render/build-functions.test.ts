/**
 * @vitest-environment jsdom
 *
 * Bug 1 回归测试: buildAcquisition / buildFeeding / buildGuide 编辑模式
 * 必须在「只改了子字段」时,通过 spread base 把未变更的子字段保留下来。
 *
 * 后端 SQL 是「整列替换或保留」(`CASE WHEN excluded.X IS NULL THEN ...`),
 * 如果 build* 输出不含未变更子字段,数据会永久丢失。历史上 commit
 * `5b6b066` 标题「保留 hunt.prob」但实现未生效。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Pig, PigAcquisition, PigFeeding, BreedingGuide } from "../js/types/index.js";

import * as auth from "../js/auth.js";
import * as dataMod from "../js/data.js";

vi.spyOn(auth, "getCurrentUser").mockReturnValue({ id: "u1", nickname: "tester", deviceCode: "d1" } as any);
vi.spyOn(dataMod, "refreshDataFromServer").mockResolvedValue({ ok: true });

import { buildAcquisition, buildFeeding, buildGuide } from "./data-editor.js";

/** 给 form input 塞值 */
function setValue(sel: string, value: string): void {
  const m = sel.match(/^#(.+)$/);
  if (!m) throw new Error(`unsupported sel: ${sel}`);
  const el = document.getElementById(m[1]);
  if (!el) throw new Error(`element not found: ${sel}`);
  (el as HTMLInputElement).value = value;
}

function setChecked(id: string, on: boolean): void {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element not found: #${id}`);
  (el as HTMLInputElement).checked = on;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("buildAcquisition 编辑模式 — 浅合并 base,保留未变更字段", () => {
  // 把 base 渲染进表单 (复用 pigFormHTML — 我们导入了之后整个模块,需要 mock 一下 state)

  it("改了 sites (清空) → hunt.prob 必须保留 (否则 = 永久数据丢失)", () => {
    // 表单已经按 pigFormHTML 的逻辑 pre-fill:
    //   shop / fail / specialFeeding / hunt.sites 联动勾选
    // 这里模拟:用户打开表单 → 手动清空所有 site 勾选 → 其他不改动
    document.body.innerHTML = `
      <input id="deShopA" value="10" />
      <input id="deShopB" value="5" />
      <input id="deShopC" value="3" />
      <div id="deHuntSites">
        <input type="checkbox" value="3" />
        <input type="checkbox" value="4" />
      </div>
      <div id="deFailFrom">
        <input type="checkbox" value="10" checked />
        <input type="checkbox" value="20" checked />
      </div>
      <input type="checkbox" id="deSpecialFeeding" checked />
    `;
    // 模拟用户清空全部 site
    document.querySelectorAll<HTMLInputElement>('#deHuntSites input').forEach((el) => { el.checked = false; });

    const base: PigAcquisition = {
      shop: [0.1, 0.05, 0.03],
      hunt: {
        sites: [3, 4],
        prob: { any: { "3": 0.05, "4": 0.03 }, same: { "3": 0.05 } },
      },
      fail: [10, 20],
      specialFeeding: true,
    };

    const a = buildAcquisition(base, /* isNew */ false);

    // 核心断言: hunt 必须保留 base 里的 prob (改为 sites: [] 但 prob 完整保留)
    expect(a).toBeDefined();
    expect(a?.hunt).toBeDefined();
    expect(a?.hunt?.sites).toEqual([]);
    expect(a?.hunt?.prob).toEqual({
      any: { "3": 0.05, "4": 0.03 },
      same: { "3": 0.05 },
    });
    // 也要保留 user 没改的 shop / fail / specialFeeding
    expect(a?.shop).toEqual([0.1, 0.05, 0.03]);
    expect(a?.fail).toEqual([10, 20]);
    expect(a?.specialFeeding).toBe(true);
  });

  it("只改 hunt sites (不影响 shop/fail/sf) → 整体合并 base", () => {
    // 表单 pre-fill,user 只把 site 从 [3, 4] 改成 [3, 5]
    document.body.innerHTML = `
      <input id="deShopA" value="10" />
      <input id="deShopB" value="0" />
      <input id="deShopC" value="0" />
      <div id="deHuntSites">
        <input type="checkbox" value="3" checked />
        <input type="checkbox" value="4" />
        <input type="checkbox" value="5" checked />
      </div>
      <div id="deFailFrom">
        <input type="checkbox" value="11" checked />
      </div>
      <input type="checkbox" id="deSpecialFeeding" checked />
    `;
    // 模拟:用户取消勾选 site 4,但 3, 5 勾上 (变更 sites)
    document.querySelectorAll<HTMLInputElement>('#deHuntSites input[value="4"]').forEach((el) => { el.checked = false; });

    const base: PigAcquisition = {
      shop: [0.1, 0, 0],
      hunt: {
        sites: [3, 4],
        prob: { any: { "3": 0.05 }, same: { "3": 0.05 } },
      },
      fail: [11],
      specialFeeding: true,
    };

    const a = buildAcquisition(base, false);
    expect(a?.hunt?.sites).toEqual([3, 5]);
    expect(a?.hunt?.prob).toEqual({ any: { "3": 0.05 }, same: { "3": 0.05 } });
    expect(a?.shop).toEqual([0.1, 0, 0]);
    expect(a?.fail).toEqual([11]);
    expect(a?.specialFeeding).toBe(true);
  });

  it("没改任何字段 → 返回 undefined (不发送 acquisition,后端保留原值)", () => {
    document.body.innerHTML = `
      <input id="deShopA" value="10" />
      <input id="deShopB" value="5" />
      <input id="deShopC" value="3" />
      <div id="deHuntSites">
        <input type="checkbox" value="3" checked />
      </div>
      <div id="deFailFrom">
        <input type="checkbox" value="10" checked />
      </div>
      <input type="checkbox" id="deSpecialFeeding" checked />
    `;

    const base: PigAcquisition = {
      shop: [0.1, 0.05, 0.03],
      hunt: { sites: [3], prob: { any: { "3": 0.05 }, same: {} } },
      fail: [10],
      specialFeeding: true,
    };

    const a = buildAcquisition(base, false);
    expect(a).toBeUndefined();
  });
});

describe("buildFeeding 编辑模式 — 浅合并 base,保留未变更字段", () => {
  it("只改了 picky → interval/times 必须保留", () => {
    document.body.innerHTML = `
      <input id="deFeedInterval" value="8" />
      <input id="deFeedTimes" value="3" />
      <div id="deFeedPicky">
        <input type="checkbox" value="2" checked />
      </div>
    `;

    const base: PigFeeding = { interval: 8, times: 3, picky: [1] };
    const f = buildFeeding(base);

    expect(f).toBeDefined();
    expect(f?.interval).toBe(8);
    expect(f?.times).toBe(3);
    expect(f?.picky).toEqual([2]);
  });

  it("没改任何字段 → 返回 undefined", () => {
    document.body.innerHTML = `
      <input id="deFeedInterval" value="8" />
      <input id="deFeedTimes" value="3" />
      <div id="deFeedPicky">
        <input type="checkbox" value="1" checked />
      </div>
    `;

    const base: PigFeeding = { interval: 8, times: 3, picky: [1] };
    const f = buildFeeding(base);
    expect(f).toBeUndefined();
  });
});

describe("buildGuide 编辑模式 — 浅合并 base,保留未变更字段", () => {
  it("只改了 tips → requirements 必须保留", () => {
    document.body.innerHTML = `
      <textarea id="deGuideReq"></textarea>
      <textarea id="deGuideTips">每次都喂不同食物</textarea>
    `;

    const base: BreedingGuide = { requirements: "成猪前体重 >= 128kg" };
    const g = buildGuide(base);

    expect(g).toBeDefined();
    expect(g?.requirements).toBe("成猪前体重 >= 128kg");
    expect(g?.tips).toBe("每次都喂不同食物");
  });

  it("没改任何字段 → 返回 undefined", () => {
    document.body.innerHTML = `
      <textarea id="deGuideReq">维持原值</textarea>
      <textarea id="deGuideTips">保持</textarea>
    `;

    const base: BreedingGuide = { requirements: "维持原值", tips: "保持" };
    const g = buildGuide(base);
    expect(g).toBeUndefined();
  });
});
