/**
 * Cloudflare Pages Function: 用户登录
 * POST /api/auth/login
 */

import { jsonResponse, badRequest, readJson, cleanNickname, cleanDeviceCode, corsOptionsResponse, buildSessionCookie } from "../_utils.ts";

interface Env {
  DB: D1Database;
}

interface UserRow {
  id: string;
  nickname: string;
  device_code: string;
  created_at: number;
  last_sync_at: number | null;
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
  const deviceCode = cleanDeviceCode(body.deviceCode);

  if (!nickname) {
    return badRequest("昵称格式不正确");
  }

  if (!deviceCode) {
    return badRequest("设备码格式不正确(6位字母数字)");
  }

  try {
    // 验证昵称和设备码匹配
    const user = await db
      .prepare(`
        SELECT id, nickname, device_code, created_at, last_sync_at
        FROM users
        WHERE nickname = ? AND device_code = ?
        LIMIT 1
      `)
      .bind(nickname, deviceCode)
      .first<UserRow>();

    if (!user) {
      return jsonResponse(
        { ok: false, error: "昵称或设备码不正确" },
        401
      );
    }

    // 更新最后登录时间
    const now = Date.now();
    await db
      .prepare("UPDATE users SET updated_at = ? WHERE id = ?")
      .bind(now, user.id)
      .run();

    return jsonResponse({
      ok: true,
      user: {
        id: user.id,
        nickname: user.nickname,
        deviceCode: user.device_code,
        createdAt: user.created_at,
        lastSyncAt: user.last_sync_at,
      },
    }, 200, { "Set-Cookie": buildSessionCookie(user.id, context.request) });
  } catch (error) {
    console.error("[auth/login] Error:", error);
    return jsonResponse({ ok: false, error: "登录失败,请稍后重试" }, 500);
  }
}

export function onRequestOptions(): Response {
  return corsOptionsResponse("POST, OPTIONS");
}
