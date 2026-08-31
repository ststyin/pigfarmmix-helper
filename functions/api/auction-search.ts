/**
 * Cloudflare Pages Function: 拍卖场接口代理
 *
 * 浏览器直接调上游 http://pig2cnt.j-o-e.jp/auctionSearch_new.php 不通:
 *   - 站点跑在 HTTPS(CF Pages),明文 HTTP 触发 mixed-content
 *   - 上游不发 Access-Control-Allow-Origin,CORS 直接挡
 * Worker 跑在 CF 边缘,**不受**浏览器这两条限制,可以放心 fetch 上游。
 *
 * 路由:POST /api/auction-search?<query params>
 */

import { jsonResponse, getAuthUserId, corsOptionsResponse } from "./_utils.ts";

interface Env {
  DB: D1Database;
}

// 上游有两套:台服 (pig2cnt) 默认;日服 (pig2) 由 ?server=jp 切换
const AUCTION_ENDPOINTS: Record<string, string> = {
  tw: "http://pig2cnt.j-o-e.jp/auctionSearch_new.php",
  jp: "http://pig2.j-o-e.jp/auctionSearch_new.php",
};
const DEFAULT_SERVER = "tw";
const DEFAULT_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 12; sdk_gphone64_arm64 Build/SE1A.220203.002.A1)";

// 完整 bType 白名单:1-1199 覆盖普通 / 事件 / 配种衍生 / 双特殊 全部段
const ALL_BTYPES = Array.from({ length: 1199 }, (_, i) => i + 1);

// 响应中每条记录的字段名称
const RECORD_FIELDS = [
  "pigNo", "nowPrice", "weight", "limitdate", "owner",
  "rare", "isExer", "foodtype", "pNo", "pigletOrSex",
  "ownername", "bidownername", "bidowner", "bidcount", "bType",
] as const;

interface AuctionRecord {
  pigNo: number;
  nowPrice: number;
  weight: number;
  limitdate: string;
  owner: number;
  rare: number;
  isExer: number;
  foodtype: number;
  pNo: number;
  pigletOrSex: number;
  ownername: string;
  bidownername: string;
  bidowner: number | null;
  bidcount: number;
  bType: number;
}

interface FetchOpts {
  count: number;
  rare: string;
  isExer: string;
  foodtype: string;
  sex: string;
  sort: string;
  color: string;
  server: string;
}

/** e/f 字段必须带尾随逗号才被上游识别为筛选(实测)。空 = 不限。 */
function csvFilter(v: string): string {
  return v ? `${v},` : "";
}

function buildAuctionBody({ count, rare, isExer, foodtype, sex, sort, color }: FetchOpts): string {
  const fields: [string, string][] = [
    ["p", color || "0"],
    ["r", rare || "0"],
    ["e", csvFilter(isExer)],
    ["f", csvFilter(foodtype)],
    ["w", "99"],
    ["d", sort || "1"],
    ["s", sex || "99"],
    ["ownerNo", "1123455"],
    ["cnt", String(count)],
    ["list", ALL_BTYPES.join(",")],
    ["cash", String(Math.floor(Math.random() * 100))],
  ];
  return fields
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ",")}`)
    .join("&");
}

function parseResponse(body: string): AuctionRecord[] {
  const cleaned = body.replace(/^/, "").trim();
  if (!cleaned || cleaned === "-1") return [];
  const parts = cleaned.split("&");
  const records: AuctionRecord[] = [];
  for (const raw of parts.slice(1)) {
    const cols = raw.split(",");
    if (cols.length !== RECORD_FIELDS.length) continue;
    const pigNo = parseInt(cols[0], 10);
    if (Number.isNaN(pigNo)) continue;
    records.push({
      pigNo,
      nowPrice: parseInt(cols[1], 10),
      weight: parseFloat(cols[2]),
      limitdate: cols[3],
      owner: parseInt(cols[4], 10),
      rare: parseInt(cols[5], 10),
      isExer: parseInt(cols[6], 10),
      foodtype: parseInt(cols[7], 10),
      pNo: parseInt(cols[8], 10),
      pigletOrSex: parseInt(cols[9], 10),
      ownername: cols[10],
      bidownername: cols[11],
      bidowner: cols[12] ? parseInt(cols[12], 10) : null,
      bidcount: parseInt(cols[13], 10),
      bType: parseInt(cols[14], 10),
    });
  }
  return records;
}

function unauthorizedResponse(): Response {
  return jsonResponse(
    { status: "error", error: "请先登录才能使用拍卖场功能" },
    401,
  );
}



/** 上游单次最多 30 条;按色组 fan-out 才能拿全。 */
const COLOR_CODES = ["700", "704", "708", "712", "716", "720"];

async function fetchOnce(opts: FetchOpts): Promise<AuctionRecord[]> {
  const body = buildAuctionBody(opts);
  const endpoint = AUCTION_ENDPOINTS[opts.server] || AUCTION_ENDPOINTS[DEFAULT_SERVER];
  const r = await fetch(endpoint, {
    method: "POST",
    body,
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
    },
  });
  if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
  return parseResponse(await r.text());
}

async function scrapeAllColors(opts: FetchOpts): Promise<AuctionRecord[]> {
  const results = await Promise.allSettled(
    COLOR_CODES.map(code => fetchOnce({ ...opts, color: code })),
  );
  const seen = new Map<string, AuctionRecord>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const rec of r.value) {
      seen.set(`${rec.pigNo}-${rec.owner}`, rec);
    }
  }
  const merged = Array.from(seen.values());
  const asc = opts.sort === "0";
  merged.sort((a, b) =>
    asc ? a.limitdate.localeCompare(b.limitdate)
        : b.limitdate.localeCompare(a.limitdate),
  );
  return merged;
}

/** 记录拍卖场搜索行为(用于统计) */
async function logAuctionSearch(
  db: D1Database,
  userId: string,
  searchParams: FetchOpts,
  resultCount: number
): Promise<void> {
  try {
    const searchId = crypto.randomUUID();
    const now = Date.now();
    await db
      .prepare(`
        INSERT INTO auction_searches (
          id, user_id, searched_at, server, rare, is_exer,
          foodtype, sex, color, sort, result_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        searchId,
        userId,
        now,
        searchParams.server || DEFAULT_SERVER,
        searchParams.rare || null,
        searchParams.isExer || null,
        searchParams.foodtype || null,
        searchParams.sex || null,
        searchParams.color || null,
        searchParams.sort || "1",
        resultCount,
      )
      .run();
  } catch (err) {
    console.error("[auction-search] Failed to log search:", err);
  }
}

export async function onRequestPost(context: { request: Request; env: Env; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> {
  const db = context.env.DB;

  // 鉴权: 从 session cookie 取 userId, 不信任 query/body 里的 userId (防身份伪造)
  if (!db) {
    return jsonResponse({ ok: false, error: "数据库未配置" }, 500);
  }
  const userId = await getAuthUserId(context.request, db);
  if (!userId) return unauthorizedResponse();

  const url = new URL(context.request.url);

  const sp = url.searchParams;
  const get = (k: string, def = ""): string => sp.get(k) ?? def;

  let count = parseInt(get("count", "30"), 10);
  if (Number.isNaN(count)) count = 30;
  count = Math.max(1, Math.min(count, 1000));

  const serverParam = get("server", DEFAULT_SERVER);
  const server = AUCTION_ENDPOINTS[serverParam] ? serverParam : DEFAULT_SERVER;

  const opts: FetchOpts = {
    count,
    rare: get("rare"),
    isExer: get("is_exer"),
    foodtype: get("foodtype"),
    sex: get("sex"),
    sort: get("sort", "1"),
    color: get("color"),
    server,
  };

  try {
    let records: AuctionRecord[];
    if (opts.color) {
      records = await fetchOnce(opts);
    } else {
      records = await scrapeAllColors(opts);
    }

    // 记录搜索行为(异步,不阻塞响应)
    context.waitUntil(logAuctionSearch(db, userId!, opts, records.length));

    return jsonResponse({
      status: "ok",
      count: records.length,
      records,
      fetched_at: new Date().toISOString(),
      scraped: !opts.color,
    });
  } catch (err) {
    return jsonResponse({
      status: "error",
      error: `${(err as Error).name}: ${(err as Error).message}`,
    });
  }
}

/** 防止有人误用 GET,给一个明确的提示。 */
export function onRequestGet(): Response {
  return jsonResponse(
    { status: "error", error: "method not allowed; use POST" },
    405,
  );
}

export function onRequestOptions(): Response {
  return corsOptionsResponse("POST, OPTIONS");
}
