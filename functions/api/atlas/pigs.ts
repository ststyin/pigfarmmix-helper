/**
 * Cloudflare Pages Function: 图鉴数据 API
 * GET /api/atlas/pigs — 返回全部猪数据和配种表
 * (调用前需 D1 已通过 schema.sql 建表 + seed 脚本导入数据)
 *
 * 类型: D1 相关类型使用 @cloudflare/workers-types。
 */

import { jsonResponse } from "../_utils.js";

export interface Pig {
  pNo: number;
  name: string;
  rare: number;
  color: number;
  description?: string;
  atlas?: { type: number; index: number; visible: boolean };
  weight?: { small: number; big: number };
  rent?: number;
  price?: number;
  lifespan?: number;
  graze?: boolean;
  special?: boolean;
  status?: "normal" | "hidden" | "removed";
  acquisition?: Record<string, unknown>;
  feeding?: Record<string, unknown>;
  breedingGuide?: Record<string, unknown>;
  hints?: string[];
  /** 最后编辑人 userId (NULL = System / seed 数据) */
  updatedBy?: string | null;
  /** 最后编辑人昵名 (NULL = System 或用户已被删除) — atlas/pigs.ts 用 LEFT JOIN users 填充 */
  updatedByName?: string | null;
  /** 最后编辑时间戳 (毫秒) */
  updatedAt?: number;
}

export interface BreedingRecord {
  parents: (number | "*")[];
  outcomes: { pNo: number; prob: number }[];
  visible: boolean;
}

function parseJsonField(value: unknown): unknown {
  if (value == null) return undefined;
  try { return JSON.parse(String(value)); } catch { return undefined; }
}

function rowToPig(row: Record<string, unknown>): Pig {
  const pig: Pig = {
    pNo: Number(row.p_no),
    name: String(row.name),
    rare: Number(row.rare),
    color: Number(row.color),
    description: row.description ? String(row.description) : undefined,
    atlas: {
      type: row.atlas_type ? Number(row.atlas_type) : 0,
      index: row.atlas_index ? Number(row.atlas_index) : 0,
      visible: Boolean(row.atlas_visible),
    },
    weight: (row.weight_small != null && row.weight_big != null)
      ? { small: Number(row.weight_small), big: Number(row.weight_big) }
      : undefined,
    rent: row.rent != null ? Number(row.rent) : undefined,
    price: row.price != null ? Number(row.price) : undefined,
    lifespan: row.lifespan != null ? Number(row.lifespan) : undefined,
    graze: Boolean(row.graze),
    special: Boolean(row.special),
    status: (row.status as string) as Pig["status"] || "normal",
    acquisition: parseJsonField(row.acquisition) as Record<string, unknown> | undefined,
    feeding: parseJsonField(row.feeding) as Record<string, unknown> | undefined,
    breedingGuide: parseJsonField(row.breeding_guide) as Record<string, unknown> | undefined,
    hints: parseJsonField(row.hints) as string[] | undefined,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedByName: row.updated_by_name ? String(row.updated_by_name) : null,
    updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
  };
  return pig;
}

export async function onRequestGet(context: { env: { DB: D1Database } }): Promise<Response> {
  const db = context.env.DB;

  try {
    const [pigsResult, breedingResult] = await Promise.all([
      db.prepare(`
        SELECT p.*, u.nickname AS updated_by_name
        FROM pigs p
        LEFT JOIN users u ON p.updated_by = u.id
        ORDER BY p.p_no
      `).all(),
      db.prepare("SELECT * FROM breeding ORDER BY id").all(),
    ]);

    const pigs: Pig[] = (pigsResult.results || []).map(rowToPig);

    // 按 parent1,parent2 聚合成配种记录
    const breedingMap = new Map<string, { parents: (number | "*")[]; outcomes: { pNo: number; prob: number }[]; visible: boolean }>();
    for (const row of breedingResult.results || []) {
      const r = row as Record<string, unknown>;
      const p1 = Number(r.parent1);
      const p2 = Number(r.parent2);
      const p2Final: number | "*" = p2 === -1 ? "*" : p2;
      const key = `${p1}-${p2Final}`;
      const outcome = { pNo: Number(r.outcome_p_no), prob: Number(r.outcome_prob) };

      if (!breedingMap.has(key)) {
        breedingMap.set(key, {
          parents: [p1, p2Final],
          outcomes: [],
          visible: Boolean(r.visible),
        });
      }
      breedingMap.get(key)!.outcomes.push(outcome);
    }

    const breeding: BreedingRecord[] = Array.from(breedingMap.values());
    // 合并 outcomes 中相同 pNo 的概率
    for (const rec of breeding) {
      const merged = new Map<number, number>();
      for (const o of rec.outcomes) {
        merged.set(o.pNo, (merged.get(o.pNo) || 0) + o.prob);
      }
      rec.outcomes = Array.from(merged.entries()).map(([pNo, prob]) => ({ pNo, prob }));
    }

    return jsonResponse({
      version: 3,
      count: pigs.length,
      pigs,
      breeding,
    });
  } catch (error) {
    console.error("[atlas] Error:", error);
    return jsonResponse({ ok: false, error: "服务器内部错误" }, 500);
  }
}

// 说明: Cache-Control 已统一走 _utils.ts 的 no-store。
// 之前这里写过 "public, max-age=3600, s-maxage=3600",导致编辑设备拿到 1 小时前的 CDN 缓存,
// 看不到自己刚做的修改,其他设备反而能看到。200 行数据 D1 读一次才 1-2ms,无需缓存。
