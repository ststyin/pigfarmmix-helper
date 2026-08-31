/**
 * Cloudflare Pages Function: 收藏数据同步
 * POST /api/sync/collection - 上传本地数据并获取合并后的云端数据
 * GET  /api/sync/collection - 仅获取云端数据
 */

import { jsonResponse, badRequest, readJson, getAuthUserId, unauthorizedResponse, corsOptionsResponse } from "../_utils.ts";

interface Env {
  DB: D1Database;
}

interface LocalData {
  collection?: unknown;
  eventPigs?: unknown;
  smallBadges?: unknown;
  bigBadges?: unknown;
}

interface CloudData {
  collection: number[];
  eventPigs: number[];
  smallBadges: number[];
  bigBadges: number[];
}

/**
 * 清理编号数组(过滤非法值 + 去重;长度校验在入口处做,超限直接报错)
 */
function cleanNumberArray(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  return Array.from(new Set(arr.filter((n): n is number => Number.isInteger(n) && n > 0)));
}

// 单个数组的长度上限
const MAX_ARRAY_LENGTH = 10000;

// D1 单条语句的绑定参数上限
const MAX_BOUND_PARAMS = 96;

interface BuildInsertOptions {
  table: string;
  columns: string[];
  conflictTarget: string;
  rows: number[];
  buildRowParams: (pNo: number) => (string | number)[];
}

/**
 * 构造多行 INSERT 语句数组,单条语句的绑定参数不超过 MAX_BOUND_PARAMS
 */
function buildInsertStatements(
  db: D1Database,
  { table, columns, conflictTarget, rows, buildRowParams }: BuildInsertOptions
): D1PreparedStatement[] {
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    const slice = rows.slice(i, i + rowsPerStatement);
    statements.push(
      db.prepare(`
        INSERT INTO ${table} (${columns.join(", ")})
        VALUES ${slice.map(() => rowPlaceholder).join(", ")}
        ON CONFLICT ${conflictTarget} DO NOTHING
      `).bind(...slice.flatMap(buildRowParams))
    );
  }

  return statements;
}

/**
 * 校验 localData 各数组长度,超限返回错误信息,否则返回 null
 */
function validateLocalDataSize(localData: LocalData): string | null {
  for (const key of ["collection", "eventPigs", "smallBadges", "bigBadges"]) {
    const arr = localData[key as keyof LocalData];
    if (Array.isArray(arr) && arr.length > MAX_ARRAY_LENGTH) {
      return `${key} 数据量超过上限 (${arr.length} > ${MAX_ARRAY_LENGTH}),已拒绝同步以避免数据丢失`;
    }
  }
  return null;
}

/**
 * 从数据库加载用户的收藏数据
 */
async function loadCloudData(db: D1Database, userId: string): Promise<CloudData> {
  const [collections, eventCollections, badges] = await Promise.all([
    db.prepare("SELECT p_no FROM collections WHERE user_id = ? ORDER BY p_no")
      .bind(userId)
      .all<{ p_no: number }>(),
    db.prepare("SELECT p_no FROM event_collections WHERE user_id = ? ORDER BY p_no")
      .bind(userId)
      .all<{ p_no: number }>(),
    db.prepare("SELECT badge_type, p_no FROM badges WHERE user_id = ? ORDER BY badge_type, p_no")
      .bind(userId)
      .all<{ badge_type: string; p_no: number }>(),
  ]);

  const smallBadges: number[] = [];
  const bigBadges: number[] = [];
  for (const row of badges.results || []) {
    if (row.badge_type === "small") {
      smallBadges.push(row.p_no);
    } else if (row.badge_type === "big") {
      bigBadges.push(row.p_no);
    }
  }

  return {
    collection: (collections.results || []).map(row => row.p_no),
    eventPigs: (eventCollections.results || []).map(row => row.p_no),
    smallBadges,
    bigBadges,
  };
}

/**
 * 用本地数据完全替换云端数据(Last-Write-Wins:本地胜出时调用)
 */
async function overwriteCloudData(
  db: D1Database,
  userId: string,
  localData: LocalData,
  now: number,
  localModifiedAt: number
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM collections WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM event_collections WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM badges WHERE user_id = ?").bind(userId),
  ];

  statements.push(...buildInsertStatements(db, {
    table: "collections",
    columns: ["user_id", "p_no", "added_at"],
    conflictTarget: "(user_id, p_no)",
    rows: cleanNumberArray(localData.collection),
    buildRowParams: pNo => [userId, pNo, now],
  }));

  statements.push(...buildInsertStatements(db, {
    table: "event_collections",
    columns: ["user_id", "p_no", "added_at"],
    conflictTarget: "(user_id, p_no)",
    rows: cleanNumberArray(localData.eventPigs),
    buildRowParams: pNo => [userId, pNo, now],
  }));

  for (const [badgeType, key] of [["small", "smallBadges"], ["big", "bigBadges"]] as const) {
    statements.push(...buildInsertStatements(db, {
      table: "badges",
      columns: ["user_id", "badge_type", "p_no", "added_at"],
      conflictTarget: "(user_id, badge_type, p_no)",
      rows: cleanNumberArray(localData[key]),
      buildRowParams: pNo => [userId, badgeType, pNo, now],
    }));
  }

  statements.push(
    db.prepare("UPDATE users SET last_sync_at = ?, updated_at = ?, data_modified_at = ? WHERE id = ?")
      .bind(now, now, localModifiedAt, userId)
  );

  await db.batch(statements);
}

/**
 * GET 请求:仅获取云端数据
 */
export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const db = context.env.DB;
  if (!db) {
    return jsonResponse({ ok: false, error: "数据库未配置" }, 500);
  }

  // 鉴权: 从 session cookie 取 userId, 不信任 query 里的 userId (防身份伪造)
  const userId = await getAuthUserId(context.request, db);
  if (!userId) return unauthorizedResponse();

  try {
    const user = await db
      .prepare("SELECT id, last_sync_at FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ id: string; last_sync_at: number | null }>();

    if (!user) {
      return jsonResponse({ ok: false, error: "用户不存在" }, 404);
    }

    const cloudData = await loadCloudData(db, userId);

    return jsonResponse({
      ok: true,
      data: cloudData,
      lastSyncAt: user.last_sync_at,
    });
  } catch (error) {
    console.error("[sync/collection GET] Error:", error);
    return jsonResponse({ ok: false, error: "获取数据失败" }, 500);
  }
}

/**
 * POST 请求:Last-Write-Wins 同步
 */
export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const db = context.env.DB;
  if (!db) {
    return jsonResponse({ ok: false, error: "数据库未配置" }, 500);
  }

  // 鉴权: 从 session cookie 取 userId, 不信任 body 里的 userId (防身份伪造)
  const userId = await getAuthUserId(context.request, db);
  if (!userId) return unauthorizedResponse();

  const body = await readJson(context.request);
  if (!body) {
    return badRequest("请求格式错误");
  }

  const localData = body.localData;
  if (!localData || typeof localData !== "object") {
    return badRequest("本地数据格式错误");
  }

  const sizeError = validateLocalDataSize(localData as LocalData);
  if (sizeError) {
    return badRequest(sizeError);
  }

  const localModifiedAt = Number(body.localModifiedAt) || 0;

  try {
    const user = await db
      .prepare("SELECT id, data_modified_at FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ id: string; data_modified_at: number | null }>();

    if (!user) {
      return jsonResponse({ ok: false, error: "用户不存在" }, 404);
    }

    const cloudModifiedAt = user.data_modified_at || 0;
    const now = Date.now();

    let winner: "local" | "cloud" = "local";
    let resultData: LocalData | CloudData = localData as LocalData;

    if (localModifiedAt === 0 && cloudModifiedAt === 0) {
      // 老用户首次同步场景:比较数据量
      const ld = localData as LocalData;
      const localCount = (Array.isArray(ld.collection) ? ld.collection.length : 0) +
                        (Array.isArray(ld.eventPigs) ? ld.eventPigs.length : 0) +
                        (Array.isArray(ld.smallBadges) ? ld.smallBadges.length : 0) +
                        (Array.isArray(ld.bigBadges) ? ld.bigBadges.length : 0);

      const cloudData = await loadCloudData(db, userId);
      const cloudCount = cloudData.collection.length +
                        cloudData.eventPigs.length +
                        cloudData.smallBadges.length +
                        cloudData.bigBadges.length;

      if (localCount > 0) {
        winner = "local";
        await overwriteCloudData(db, userId, ld, now, now);
        resultData = ld;
      } else if (cloudCount > 0) {
        winner = "cloud";
        resultData = cloudData;
        await db
          .prepare("UPDATE users SET last_sync_at = ?, updated_at = ? WHERE id = ?")
          .bind(now, now, userId)
          .run();
      } else {
        winner = "local";
        resultData = ld;
      }
    } else if (localModifiedAt > cloudModifiedAt) {
      winner = "local";
      await overwriteCloudData(db, userId, localData as LocalData, now, localModifiedAt);
      resultData = localData as LocalData;
    } else {
      winner = "cloud";
      resultData = await loadCloudData(db, userId);

      await db
        .prepare("UPDATE users SET last_sync_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, userId)
        .run();
    }

    return jsonResponse({
      ok: true,
      winner,
      cloudData: resultData,
      dataModifiedAt: winner === "local" ? localModifiedAt : cloudModifiedAt,
      lastSyncAt: now,
    });
  } catch (error) {
    console.error("[sync/collection POST] Error:", error);
    return jsonResponse({ ok: false, error: "同步失败,请稍后重试" }, 500);
  }
}

export function onRequestOptions(): Response {
  return corsOptionsResponse("GET, POST, OPTIONS");
}
