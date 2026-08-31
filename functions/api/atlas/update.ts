/**
 * Cloudflare Pages Function: 图鉴数据编辑
 * POST /api/atlas/update — 保存猪数据 / 新增猪 / 新增配种信息
 *
 * 权限: 需要登录 (从 session cookie 取 userId, 不信任 body 里的 userId)。
 * 记录最后编辑人 (写入 pigs.updated_by)。
 */

import { jsonResponse, badRequest, readJson, getAuthUserId, unauthorizedResponse } from "../_utils.ts";

interface Env {
  DB: D1Database;
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(value: unknown, maxLen = 200): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function cleanJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    const s = JSON.stringify(value);
    if (s && s.length <= 10000) return s;
    return null;
  } catch {
    return null;
  }
}

// ---------- 保存猪 ----------

interface PigInput {
  pNo?: unknown;
  name?: unknown;
  rare?: unknown;
  color?: unknown;
  description?: unknown;
  atlasType?: unknown;
  atlasIndex?: unknown;
  atlasVisible?: unknown;
  weightSmall?: unknown;
  weightBig?: unknown;
  rent?: unknown;
  price?: unknown;
  lifespan?: unknown;
  graze?: unknown;
  special?: unknown;
  status?: unknown;
  acquisition?: unknown;
  feeding?: unknown;
  breedingGuide?: unknown;
  hints?: unknown;
}

async function savePig(db: D1Database, body: Record<string, unknown>, editorId: string): Promise<{ pNo: number } | null> {
  const raw = body.pig as PigInput | undefined;
  if (!raw || typeof raw !== "object") return null;

  // 新增: pNo 为空时自动分配 (max+1)
  let pNo = toInt(raw.pNo);
  let isNew = false;
  if (!pNo || pNo <= 0) {
    isNew = true;
    const maxRow = await db.prepare("SELECT MAX(p_no) AS m FROM pigs").first<{ m: number | null }>();
    pNo = (maxRow && maxRow.m ? Number(maxRow.m) : 0) + 1;
  }

  const name = cleanStr(raw.name, 80);
  if (!name) return null;
  const rare = Math.max(1, Math.min(6, toInt(raw.rare, 1)));
  const color = Math.max(0, Math.min(6, toInt(raw.color, 0)));
  const atlasType = Math.max(0, Math.min(7, toInt(raw.atlasType, 0)));
  const atlasIndex = Math.max(0, toInt(raw.atlasIndex, 0));
  const atlasVisible = raw.atlasVisible === false || raw.atlasVisible === 0 ? 0 : 1;
  const weightSmall = raw.weightSmall != null ? toNum(raw.weightSmall) : null;
  const weightBig = raw.weightBig != null ? toNum(raw.weightBig) : null;
  const rent = raw.rent != null ? toInt(raw.rent) : null;
  const price = raw.price != null ? toInt(raw.price) : null;
  const lifespan = raw.lifespan != null ? toInt(raw.lifespan) : null;
  const graze = raw.graze ? 1 : 0;
  const special = raw.special ? 1 : 0;
  const status = raw.status === "hidden" || raw.status === "removed" ? String(raw.status) : "normal";
  const acquisition = cleanJson(raw.acquisition);
  const feeding = cleanJson(raw.feeding);
  const breedingGuide = cleanJson(raw.breedingGuide);
  const hints = cleanJson(raw.hints);
  const now = Date.now();

  await db.prepare(`
    INSERT INTO pigs (
      p_no, name, rare, color, description, atlas_type, atlas_index, atlas_visible,
      weight_small, weight_big, rent, price, lifespan, graze, special, status,
      acquisition, feeding, breeding_guide, hints, updated_at, updated_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(p_no) DO UPDATE SET
      name = excluded.name,
      rare = excluded.rare,
      color = excluded.color,
      description = excluded.description,
      atlas_type = excluded.atlas_type,
      atlas_index = excluded.atlas_index,
      atlas_visible = excluded.atlas_visible,
      weight_small = excluded.weight_small,
      weight_big = excluded.weight_big,
      rent = excluded.rent,
      price = excluded.price,
      lifespan = excluded.lifespan,
      graze = excluded.graze,
      special = excluded.special,
      status = excluded.status,
      acquisition = CASE WHEN excluded.acquisition IS NULL THEN acquisition ELSE excluded.acquisition END,
      feeding = CASE WHEN excluded.feeding IS NULL THEN feeding ELSE excluded.feeding END,
      breeding_guide = CASE WHEN excluded.breeding_guide IS NULL THEN breeding_guide ELSE excluded.breeding_guide END,
      hints = CASE WHEN excluded.hints IS NULL THEN hints ELSE excluded.hints END,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(
    pNo, name, rare, color,
    raw.description != null ? cleanStr(raw.description, 2000) : null,
    atlasType || null, atlasIndex || null, atlasVisible,
    weightSmall, weightBig, rent, price, lifespan, graze, special, status,
    acquisition, feeding, breedingGuide, hints, now, editorId,
  ).run();

  return { pNo };
}

// ---------- 新增配种 ----------

interface BreedingInput {
  parent1?: unknown;
  parent2?: unknown;
  outcomes?: unknown;
  visible?: unknown;
}

async function addBreeding(db: D1Database, body: Record<string, unknown>): Promise<boolean> {
  const raw = body.breeding as BreedingInput | undefined;
  if (!raw || typeof raw !== "object") return false;

  const p1 = toInt(raw.parent1);
  let p2: number;
  if (raw.parent2 === "*" || raw.parent2 === -1 || raw.parent2 === "-1") {
    p2 = -1;
  } else {
    p2 = toInt(raw.parent2);
  }
  if (!p1 || p1 <= 0) return false;
  if (p2 !== -1 && (!p2 || p2 <= 0)) return false;

  const visible = raw.visible === false ? 0 : 1;
  const outcomes = Array.isArray(raw.outcomes)
    ? raw.outcomes
      .map(o => {
        if (!o || typeof o !== "object") return null;
        const rec = o as { pNo?: unknown; prob?: unknown };
        const pNo = toInt(rec.pNo);
        if (!pNo || pNo <= 0) return null;
        return { pNo, prob: Math.max(0, toNum(rec.prob, 0)) };
      })
      .filter((x): x is { pNo: number; prob: number } => x !== null)
    : [];

  if (outcomes.length === 0) return false;

  const now = Date.now();
  const statements = outcomes.map(o =>
    db.prepare(`
      INSERT INTO breeding (parent1, parent2, outcome_p_no, outcome_prob, visible, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent1, parent2, outcome_p_no) DO UPDATE SET
        outcome_prob = excluded.outcome_prob,
        visible = excluded.visible,
        updated_at = excluded.updated_at
    `).bind(p1, p2, o.pNo, o.prob, visible, now)
  );

  await db.batch(statements);
  return true;
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const db = context.env.DB;
  if (!db) return jsonResponse({ ok: false, error: "D1 binding DB is missing" }, 500);

  // 鉴权: 从 session cookie 取 userId, 不信任 body 里的 userId (防身份伪造)
  const userId = await getAuthUserId(context.request, db);
  if (!userId) return unauthorizedResponse();

  const body = await readJson(context.request);
  if (!body) return badRequest("Invalid JSON body");

  const results: Record<string, unknown> = { ok: true };

  try {
    // 动作路由: 软删除 (仅写 status / deleted, 不动其他字段)
    if (body.action === "deletePig" && (body.pig as { pNo?: unknown })?.pNo) {
      const pNo = Number((body.pig as { pNo: unknown }).pNo);
      const row = await db.prepare("SELECT special FROM pigs WHERE p_no = ? LIMIT 1").bind(pNo).first<{ special: number }>();
      if (!row) return badRequest("猪不存在");
      // 业务规则: 仅活动猪 (special=1) 可软删除
      if (!row.special) return badRequest("普通猪不能删除 (仅允许活动猪)");
      const now = Date.now();
      await db.prepare("UPDATE pigs SET status = 'removed', updated_at = ?, updated_by = ? WHERE p_no = ?")
        .bind(now, userId, pNo).run();
      results.deleted = { type: "pig", pNo };
      return jsonResponse(results);
    }

    if (body.action === "deleteBreeding" && body.breeding) {
      const { parent1, parent2, outcomePNo } = body.breeding as {
        parent1: unknown; parent2: unknown; outcomePNo: unknown;
      };
      const p1 = Number(parent1);
      const p2Val = parent2 === "*" || parent2 === -1 ? -1 : Number(parent2);
      const op = Number(outcomePNo);
      if (!p1 || p1 <= 0) return badRequest("parent1 无效");
      if (p2Val !== -1 && (!p2Val || p2Val <= 0)) return badRequest("parent2 无效");
      if (!op || op <= 0) return badRequest("outcomePNo 无效");
      const now = Date.now();
      const result = await db.prepare(`
        UPDATE breeding SET deleted = 1, deleted_at = ?, deleted_by = ?
        WHERE parent1 = ? AND parent2 = ? AND outcome_p_no = ? AND deleted = 0
      `).bind(now, userId, p1, p2Val, op).run();
      if (!result.meta || result.meta.changes === 0) return badRequest("配种记录不存在或已删除");
      results.deleted = { type: "breeding", parent1: p1, parent2: p2Val, outcomePNo: op };
      return jsonResponse(results);
    }

    if (body.pig) {
      const saved = await savePig(db, body, userId);
      if (!saved) return badRequest("猪数据无效");
      results.pig = saved;
    }

    if (body.breeding) {
      const added = await addBreeding(db, body);
      if (!added) return badRequest("配种数据无效");
      results.breeding = true;
    }

    if (!body.pig && !body.breeding) {
      return badRequest("没有可保存的数据");
    }

    return jsonResponse(results);
  } catch (error) {
    console.error("[atlas/update] Error:", error);
    return jsonResponse({ ok: false, error: "服务器内部错误" }, 500);
  }
}

export function onRequestOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
