/**
 * Cloudflare Pages Function: 用户注册
 * POST /api/auth/register
 */

import { jsonResponse, badRequest, readJson, cleanNickname, corsOptionsResponse, buildSessionCookie } from "../_utils.ts";

interface Env {
  DB: D1Database;
}

/**
 * 生成 6 位设备识别码
 * 格式:大写字母+数字混合,避免易混淆字符(0/O, 1/I/L)
 */
function generateDeviceCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 排除 0,O,1,I,L
  let code = "";
  const randomValues = new Uint8Array(6);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < 6; i++) {
    code += chars[randomValues[i] % chars.length];
  }
  return code;
}

/** 生成 UUID v4 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/** 尝试生成唯一的设备码(最多重试 10 次) */
async function generateUniqueDeviceCode(db: D1Database): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = generateDeviceCode();
    const existing = await db
      .prepare("SELECT id FROM users WHERE device_code = ? LIMIT 1")
      .bind(code)
      .first<{ id: string }>();
    if (!existing) return code;
  }
  throw new Error("Failed to generate unique device code");
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const db = context.env.DB;
  if (!db) {
    return jsonResponse({ ok: false, error: "数据库未配置" }, 500);
  }

  const body = await readJson(context.request);
  if (!body) {
    return badRequest("请求格式错误");
  }

  const nickname = cleanNickname(body.nickname);
  if (!nickname) {
    return badRequest("昵称格式不正确(1-30 字符)");
  }

  try {
    const userId = generateUUID();
    const deviceCode = await generateUniqueDeviceCode(db);
    const now = Date.now();

    await db
      .prepare(`
        INSERT INTO users (id, nickname, device_code, created_at, updated_at, last_sync_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(userId, nickname, deviceCode, now, now, null)
      .run();

    return jsonResponse({
      ok: true,
      user: {
        id: userId,
        nickname,
        deviceCode,
        createdAt: now,
      },
    }, 200, { "Set-Cookie": buildSessionCookie(userId, context.request) });
  } catch (error) {
    console.error("[auth/register] Error:", error);
    return jsonResponse({ ok: false, error: "注册失败,请稍后重试" }, 500);
  }
}

export function onRequestOptions(): Response {
  return corsOptionsResponse("POST, OPTIONS");
}
