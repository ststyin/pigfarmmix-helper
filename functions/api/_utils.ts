/**
 * Cloudflare Pages Functions 共享工具
 */

/** 统一 JSON 响应 (extraHeaders 可覆盖默认,例如 Set-Cookie) */
export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

/** 400 错误响应 */
export function badRequest(message: string): Response {
  return jsonResponse({ ok: false, error: message }, 400);
}

/** 安全读取请求 JSON */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** CORS 预检响应 */
export function corsOptionsResponse(methods = "GET, POST, OPTIONS"): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

/** 清理和验证昵称 (1-30 字符) */
export function cleanNickname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return null;
  const cleaned = trimmed.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

/** 清理和验证设备码 (6 位大写字母+数字) */
export function cleanDeviceCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(trimmed)) return null;
  return trimmed;
}

/** 验证用户 ID (UUID v4 格式) */
export function validateUserId(userId: unknown): userId is string {
  if (typeof userId !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId);
}

// ==================== Session Cookie 鉴权 ====================
//
// 鉴权流程:
//   1. 登录/注册成功后,后端 Set-Cookie: pigfarm_session=<userId>; HttpOnly; SameSite=Lax
//   2. 后续写操作请求,后端从 Cookie header 取 userId,查 users 表确认存在
//   3. 完全不信任请求 body / query 里的 userId — 防止身份伪造
//
// Secure 标志在 https 时才加 (本地开发 http 不加否则 cookie 不会发)

const SESSION_COOKIE_NAME = "pigfarm_session";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

/** 构造 session cookie 值 */
export function buildSessionCookie(userId: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const flags = [
    `Path=/`,
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE_NAME}=${userId}; ${flags.join("; ")}`;
}

/** 从 Cookie header 解析 session userId (不查表, 仅格式校验) */
export function getSessionUserId(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE_NAME) {
      const v = decodeURIComponent(rest.join("=").trim());
      return validateUserId(v) ? v : null;
    }
  }
  return null;
}

/** 从 session cookie 取 userId, 并查 users 表确认用户存在
 *  返回 userId 或 null (未登录 / cookie 无效 / 用户不存在) */
export async function getAuthUserId(request: Request, db: D1Database): Promise<string | null> {
  const userId = getSessionUserId(request);
  if (!userId) return null;
  const row = await db
    .prepare("SELECT id FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();
  return row ? userId : null;
}

/** 401 未登录响应 */
export function unauthorizedResponse(): Response {
  return jsonResponse({ ok: false, error: "请先登录" }, 401);
}
