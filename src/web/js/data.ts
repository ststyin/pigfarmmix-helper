/**
 * 数据加载和处理 — 支持 API (D1) + IndexedDB 缓存 + JSON 文件兜底
 */

import type { Pig, PigDataBundle, BreedingRecord, BreedingEntry, BreedingResultKind, RaisingItem } from "./types/index.js";
import { DATA_URL_BY_LANG, HUNT_SITES, HUNT_REGION_CODES, HUNT_NORMAL_CODES, HUNT_RARE_CODES, BOOK_COLOR_TEXT, COLOR_TEXT, STORAGE_KEY_BADGE_SMALL, STORAGE_KEY_BADGE_BIG } from "./constants.js";
import { state } from "./state.js";
import { currentLang, saveHiddenUnlocked, saveCollection, saveOwnedEventPigs, saveSmallBadges, saveBigBadges, loadCollection, loadOwnedEventPigs, loadBadgeSet, saveRaisingPigs } from "./storage.js";
import { showUnlockCelebration } from "./utils.js";

// ---- IndexedDB 缓存 ----
const DB_NAME = "pigfarmmix-cache";
const DB_VERSION = 1;
const STORE_NAME = "atlas";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheBundle(bundle: PigDataBundle): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ key: "bundle", data: bundle, cachedAt: Date.now() });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* ignore cache errors */ }
}

async function loadCachedBundle(): Promise<PigDataBundle | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get("bundle");
    const result = await new Promise<{ key: string; data: PigDataBundle; cachedAt: number } | null>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result ? result.data : null;
  } catch {
    return null;
  }
}

// ---- 数据加载 ----

/** 从 API 加载图鉴数据 */
async function loadFromApi(): Promise<PigDataBundle | null> {
  try {
    const res = await fetch("/api/atlas/pigs");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.pigs)) return null;
    return data as PigDataBundle;
  } catch {
    return null;
  }
}

/** 从 JSON 文件加载 (兜底 + 首次 seed) */
async function loadFromJson(): Promise<PigDataBundle> {
  const res = await fetch(DATA_URL_BY_LANG[currentLang()]);
  if (!res.ok) throw new Error("加载数据失败: " + res.status);
  const bundle = await res.json() as PigDataBundle;
  if (!bundle || !Array.isArray(bundle.pigs)) throw new Error("数据格式错误");
  return bundle;
}

// ---- 数据处理 ----

/** 推导 book/page/slot/color_text */
export function enrichPig(p: Pig): Pig {
  const atlas = p.atlas;
  const type = atlas?.type;
  const index = atlas?.index;

  if (type && type >= 1 && type <= 6 && index) {
    p.book = type;
    p.page = Math.ceil(index / 6);
    p.slot = ((index - 1) % 6) + 1;
  } else if (type === 7 && index) {
    p.book = 7;
    p.page = null;
    p.slot = null;
  } else {
    p.book = type;
    p.page = null;
    p.slot = null;
  }

  const bookColor = BOOK_COLOR_TEXT[p.book ?? -1];
  if (bookColor) {
    p.color_text = bookColor;
  } else if (p.color != null && COLOR_TEXT[p.color]) {
    p.color_text = COLOR_TEXT[p.color];
  } else if (p.special) {
    p.color_text = "其他";
  }

  if (typeof p.graze === "boolean") {
    p.isExer = p.graze;
  } else {
    p.isExer = p.isExer === true || (p as { isExer?: unknown }).isExer === 1;
    p.graze = p.isExer;
  }

  return p;
}

/** 把隐藏猪并入 main */
export function mergeHiddenIntoMain(): void {
  for (const p of state.hiddenPigsById.values()) {
    state.pigsById.set(p.pNo, p);
    const atlas = p.atlas;
    if (atlas?.type && atlas.index) {
      state.pigsByListKey.set(`${atlas.type}-${atlas.index}`, p.pNo);
    }
  }
}

/** 集齐 186 主图鉴的判定 */
function basePigPNos(): number[] {
  const out: number[] = [];
  for (const [pNo, pig] of state.pigsById) {
    if (pig.status !== "hidden") out.push(pNo);
  }
  return out;
}

export function checkAndUnlockHidden(): boolean {
  if (state.hiddenUnlocked) return false;
  if (!state.dataLoaded) return false;
  const base = basePigPNos();
  if (base.length === 0) return false;
  const ownedSet = new Set(state.collection);
  for (const pNo of base) {
    if (!ownedSet.has(pNo)) return false;
  }
  state.hiddenUnlocked = true;
  saveHiddenUnlocked(state.hiddenUnlocked);
  mergeHiddenIntoMain();
  buildBreedingIndex(state.breedingTable);
  showUnlockCelebration();
  return true;
}

/** 构建反向配种索引 */
export function buildBreedingIndex(breedingTable: BreedingRecord[]): void {
  state.breedByParent = new Map();
  const seen = new Map<number, Set<string>>();

  function getPigByPNo(pNo: number): Pig | undefined {
    return state.pigsById.get(pNo) || state.eventPigsById.get(pNo) || state.hiddenPigsById.get(pNo);
  }

  function enrichOutcomes(outcomes: { pNo: number; prob: number }[]): BreedingResultKind[] {
    return outcomes.map(o => {
      const pig = getPigByPNo(o.pNo);
      return {
        prob: o.prob,
        pigKind: pig ? {
          pNo: pig.pNo,
          name: pig.name,
          rare: pig.rare,
          special: pig.special,
          rent: pig.rent,
          bigWeight: pig.weight?.big,
          smallWeight: pig.weight?.small,
          color: pig.color,
        } : { pNo: o.pNo },
      };
    });
  }

  function addEntry(pNo: number, entry: BreedingEntry): void {
    const key = `${entry.partner ? entry.partner.pNo : "any"}-${entry.isview}-${entry.any ? 1 : 0}`;
    if (!seen.has(pNo)) seen.set(pNo, new Set());
    const s = seen.get(pNo)!;
    if (s.has(key)) return;
    s.add(key);
    if (!state.breedByParent.has(pNo)) state.breedByParent.set(pNo, []);
    state.breedByParent.get(pNo)!.push(entry);
  }

  for (const record of breedingTable || []) {
    const [p1, p2] = record.parents;
    const isAny = p2 === "*";
    const isview = record.visible ? 1 : -1;

    const enrichedResults = enrichOutcomes(record.outcomes || []);

    const p1Pig = getPigByPNo(p1 as number);
    const p2Pig = isAny ? null : getPigByPNo(p2 as number);

    const entry: BreedingEntry = {
      partner: isAny ? null : (p2Pig ? {
        pNo: p2Pig.pNo,
        name: p2Pig.name,
        rent: p2Pig.rent,
      } : { pNo: p2 as number }),
      isview,
      any: isAny,
      result: enrichedResults,
    };

    addEntry(p1 as number, entry);

    if (!isAny) {
      addEntry(p2 as number, {
        partner: p1Pig ? {
          pNo: p1Pig.pNo,
          name: p1Pig.name,
          rent: p1Pig.rent,
        } : { pNo: p1 as number },
        isview,
        any: false,
        result: enrichedResults,
      });
    }
  }
}

/** 获得方式推导 */
export function deriveAcquisitions(pig: Pig): Record<string, string[]> {
  const groups: Record<string, string[]> = { shop: [], hunt: [], hunt_event: [], fail: [], feed_special: [] };
  const acq = pig.acquisition || {};

  // 商店
  const shop = acq.shop || [0, 0, 0];
  const costs = [1000, 500, 100];
  const labels = ["A", "B", "C"];
  for (let i = 0; i < 3; i++) {
    if (shop[i] > 0) {
      groups.shop.push(`${labels[i]}级 ${costs[i]}pt  概率 ${(shop[i] * 100).toFixed(2)}%`);
    }
  }

  // 狩猎
  const hunt = acq.hunt || {};
  const sites = hunt.sites || [];
  const prob = hunt.prob || { any: {}, same: {} };
  const pickProb = (m: Record<string, number> | undefined, code: number): number | null => {
    if (!m) return null;
    return m[String(code)] != null ? m[String(code)] : null;
  };
  const hAny = prob.any || {};
  const hSame = prob.same || {};

  for (const code of sites) {
    if (code >= 3 && code <= 16) {
      const site = HUNT_SITES[code] || `siteid=${code}`;
      const a = pickProb(hAny, code);
      const s = pickProb(hSame, code);
      const ex = (a || s) ? `  [任意 ${((a || 0) * 100).toFixed(2)}% / 按幼猪 ${((s || 0) * 100).toFixed(2)}%]` : "";
      groups.hunt.push(site + ex);
    } else if (code >= 81 && code <= 99) {
      const site = HUNT_SITES[code] || `siteid=${code}`;
      groups.hunt_event.push(site);
    }
  }

  // 养成失败
  for (const pNo of acq.fail || []) {
    const failPig = state.pigsById.get(pNo) || state.eventPigsById.get(pNo);
    if (failPig) {
      groups.fail.push(`养成失败自 #${pNo} ${failPig.name}`);
    }
  }

  // 超分歧
  if (acq.specialFeeding) {
    groups.feed_special.push("有超分歧/超出世系条件 (详情见描述)");
  }

  return groups;
}

export function pigHasMethod(pig: Pig, method: string): boolean {
  if (!method) return true;
  const g = deriveAcquisitions(pig);
  if (method === "breed") {
    return state.breedByParent.has(pig.pNo);
  }
  return (g[method] || []).length > 0;
}

export function pigMatchesShopRank(pig: Pig, rank: string): boolean {
  if (!rank) return true;
  const idx = rank === "A" ? 0 : rank === "B" ? 1 : rank === "C" ? 2 : -1;
  if (idx < 0) return true;
  const shop = pig.acquisition?.shop || [0, 0, 0];
  return (shop[idx] || 0) > 0;
}

export function pigMatchesHunt(pig: Pig, region: string, ticket: string): boolean {
  if (!region && !ticket) return true;
  const sites = pig.acquisition?.hunt?.sites || [];
  for (const code of sites) {
    if (!(code >= 3 && code <= 16)) continue;
    if (region) {
      const pair = HUNT_REGION_CODES[region];
      if (!pair || pair.indexOf(code) < 0) continue;
    }
    if (ticket === "normal" && !HUNT_NORMAL_CODES.has(code)) continue;
    if (ticket === "rare" && !HUNT_RARE_CODES.has(code)) continue;
    return true;
  }
  return false;
}

/** loadData 选项 */
export interface LoadDataOptions {
  /**
   * 强制只走 API,失败抛错。
   * 用于「手动刷新按钮」「数据编辑保存后」 — 必须拿到服务端最新数据,不能让旧缓存蒙混过关。
   * 默认 false: 仅使用本地数据 (IndexedDB → JSON 兜底),不打 API。
   */
  force?: boolean;
}

/** 主加载入口
 *  - 默认 (force=false): IndexedDB → JSON 兜底,不打 API。应用启动时直接拿本地数据。
 *  - force=true:           强制只走 API,失败抛错。手动刷新 / 编辑保存后使用。
 */
export async function loadData(opts: LoadDataOptions = {}): Promise<void> {
  let bundle: PigDataBundle | null = null;

  if (opts.force) {
    // 强制模式: 只走 API,失败抛错。手动刷新按钮 / 编辑保存后使用。
    const apiBundle = await loadFromApi();
    if (!apiBundle) {
      throw new Error("无法从服务器获取最新数据,请检查网络后重试");
    }
    bundle = apiBundle;
    cacheBundle(apiBundle).catch(() => {});
  } else {
    // 默认模式: 仅使用本地数据 (IndexedDB → JSON 兜底),不打 API。
    // 应用打开时不连服务器;服务器拉取由「手动刷新」按钮显式触发。
    bundle = await loadCachedBundle();
    if (!bundle) {
      bundle = await loadFromJson();
      cacheBundle(bundle).catch(() => {});
    }
  }

  // 处理数据
  for (const raw of bundle.pigs) {
    const p = enrichPig(raw);

    if (p.status === "removed") continue;

    const atlas = p.atlas;
    if (p.status === "hidden") {
      state.hiddenPigsById.set(p.pNo, p);
      continue;
    }

    const isMain = atlas ? atlas.type >= 1 && atlas.type <= 6 && atlas.visible : false;
    if (isMain) {
      state.pigsById.set(p.pNo, p);
      if (atlas?.type && atlas.index) {
        state.pigsByListKey.set(`${atlas.type}-${atlas.index}`, p.pNo);
      }
    } else {
      state.eventPigsById.set(p.pNo, p);
    }
  }

  if (state.hiddenUnlocked) mergeHiddenIntoMain();

  state.breedingTable = bundle.breeding || [];
  buildBreedingIndex(state.breedingTable);

  state.dataLoaded = true;
}

/**
 * 从服务器强制刷新图鉴数据 — 编辑保存后 / 手动刷新按钮共用。
 * 流程: 清除 state → 强制走 API → 失败则降级到本地缓存。
 * 不调用 emit/ui-refresh, 由调用方决定何时 re-render。
 */
export async function refreshDataFromServer(): Promise<{ ok: boolean; error?: string }> {
  // 清除当前 state,准备接受新数据
  state.dataLoaded = false;
  state.pigsById = new Map();
  state.eventPigsById = new Map();
  state.hiddenPigsById = new Map();
  state.pigsByListKey = new Map();
  state.breedingTable = [];
  state.breedByParent = new Map();

  // 1) 强制从 API 拿最新数据
  let apiErr = "";
  try {
    await loadData({ force: true });
    return { ok: true };
  } catch (err) {
    apiErr = err instanceof Error ? err.message : "无法从服务器刷新";
    console.warn("[refresh] force reload from API failed:", err);
  }

  // 2) API 拿不到 → 用本地数据兜底 (loadData 默认不打 API,IndexedDB → JSON)
  try {
    await loadData();
    return { ok: false, error: `服务器刷新失败 · 当前显示本地数据 (${apiErr})` };
  } catch {
    return { ok: false, error: "数据刷新失败,请手动刷新页面" };
  }
}

// ---- 拥有/徽章操作 ----

export function setPigOwned(pNo: number, owned: boolean): void {
  const isEvent = !state.pigsById.has(pNo) && state.eventPigsById.has(pNo);
  if (isEvent) {
    if (owned) state.ownedEventPigs.add(pNo);
    else state.ownedEventPigs.delete(pNo);
    saveOwnedEventPigs(state.ownedEventPigs);
  } else {
    const i = state.collection.indexOf(pNo);
    if (owned && i < 0) state.collection.push(pNo);
    else if (!owned && i >= 0) state.collection.splice(i, 1);
    if (owned) state.ownedSet.add(pNo);
    else state.ownedSet.delete(pNo);
    saveCollection(state.collection);
  }
  if (!owned) {
    if (state.smallBadges.has(pNo)) {
      state.smallBadges.delete(pNo);
      saveSmallBadges(state.smallBadges);
    }
    if (state.bigBadges.has(pNo)) {
      state.bigBadges.delete(pNo);
      saveBigBadges(state.bigBadges);
    }
  }
  if (owned && !isEvent) checkAndUnlockHidden();
}

export function setPigBadge(pNo: number, kind: "small" | "big", on: boolean): void {
  const set = kind === "small" ? state.smallBadges : state.bigBadges;
  if (on) set.add(pNo);
  else set.delete(pNo);
  if (kind === "small") saveSmallBadges(state.smallBadges);
  else saveBigBadges(state.bigBadges);
  if (on) {
    const isEvent = !state.pigsById.has(pNo) && state.eventPigsById.has(pNo);
    const alreadyOwned = isEvent
      ? state.ownedEventPigs.has(pNo)
      : state.ownedSet.has(pNo);
    if (!alreadyOwned) setPigOwned(pNo, true);
  }
}

// ---- 集中式状态操作 (P1-B) ----

/**
 * 从 localStorage 重载收藏相关状态 (云同步后调用)
 */
export function reloadCollectionState(): void {
  state.collection = loadCollection();
  state.ownedSet = new Set(state.collection);
  state.ownedEventPigs = loadOwnedEventPigs();
  state.smallBadges = loadBadgeSet(STORAGE_KEY_BADGE_SMALL);
  state.bigBadges = loadBadgeSet(STORAGE_KEY_BADGE_BIG);
}

/**
 * 整体替换收藏状态 (覆盖导入用)
 */
export function replaceCollectionState(list: number[]): void {
  state.collection = list.slice();
  state.ownedSet = new Set(list);
  saveCollection(state.collection);
}

/**
 * 整体替换事件猪拥有状态 (覆盖导入用)
 */
export function replaceOwnedEventPigs(pNos: Iterable<number>): void {
  state.ownedEventPigs = new Set(pNos);
  saveOwnedEventPigs(state.ownedEventPigs);
}

/**
 * 整体替换徽章状态 (覆盖导入用)
 */
export function replaceBadges(small: Iterable<number>, big: Iterable<number>): void {
  state.smallBadges = new Set(small);
  state.bigBadges = new Set(big);
  saveSmallBadges(state.smallBadges);
  saveBigBadges(state.bigBadges);
}

/**
 * 整体替换养成列表 (覆盖导入用)
 */
export function replaceRaisingPigs(items: RaisingItem[]): void {
  state.raisingPigs = items.map(item => ({ ...item }));
  saveRaisingPigs(state.raisingPigs);
}

/**
 * 清空全部用户记录 (清空按钮用)
 * 注意: 隐藏图鉴解锁状态的清理由调用方处理 (需要操作 pigsById)
 */
export function resetAllRecords(): void {
  state.collection = [];
  state.ownedSet = new Set();
  state.ownedEventPigs = new Set();
  state.smallBadges = new Set();
  state.bigBadges = new Set();
  state.raisingPigs = [];
  saveCollection(state.collection);
  saveOwnedEventPigs(state.ownedEventPigs);
  saveSmallBadges(state.smallBadges);
  saveBigBadges(state.bigBadges);
  saveRaisingPigs(state.raisingPigs);
}
