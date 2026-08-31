-- ============================================================
-- 猪猪图鉴 — D1 数据库 Schema
--
-- 两张核心表:
--   pigs      猪基础信息表 (主图鉴 186 + Events 活动猪 + 隐藏猪)
--   breeding  配种表 (父母 -> 产出)
--
-- 用户收藏/徽章/同步相关的表沿用原项目:
--   users / collections / event_collections / badges
--   raising_records / push_subscriptions
-- ============================================================

-- ---------- 图鉴数据 ----------

-- 猪基础信息表
CREATE TABLE IF NOT EXISTS pigs (
  p_no          INTEGER PRIMARY KEY,          -- 猪编号 (对应原 JSON 的 pNo)
  name          TEXT NOT NULL,                -- 名称 (简体中文)
  rare          INTEGER NOT NULL DEFAULT 1,   -- 星级 1~6
  color         INTEGER NOT NULL DEFAULT 0,   -- 颜色代码 1~6
  description   TEXT,                         -- 描述
  atlas_type    INTEGER,                      -- 图鉴号 1~7 (7=Events)
  atlas_index   INTEGER,                      -- 页内序号 (1-based)
  atlas_visible INTEGER NOT NULL DEFAULT 1,   -- 是否在图鉴中可见
  weight_small  REAL,                         -- 小章体重阈值
  weight_big    REAL,                         -- 大章体重阈值
  rent          INTEGER,                      -- 借猪费用
  price         INTEGER,                      -- 售价
  lifespan      INTEGER,                      -- 成猪寿命 (小时)
  graze         INTEGER NOT NULL DEFAULT 0,   -- 是否放牧 (0/1)
  special       INTEGER NOT NULL DEFAULT 0,   -- 是否特殊猪 (0/1)
  status        TEXT NOT NULL DEFAULT 'normal', -- normal / hidden / removed
  acquisition   TEXT,                         -- JSON: {shop, hunt, fail, specialFeeding}
  feeding       TEXT,                         -- JSON: {interval, times, picky}
  breeding_guide TEXT,                        -- JSON: {requirements, tips}
  hints         TEXT,                         -- JSON: string[]
  updated_at    INTEGER NOT NULL DEFAULT 0,
  updated_by    TEXT                          -- 最后编辑人 userId (NULL = System / seed)
);

-- 图鉴位置索引
CREATE INDEX IF NOT EXISTS idx_pigs_atlas ON pigs (atlas_type, atlas_index);
CREATE INDEX IF NOT EXISTS idx_pigs_status ON pigs (status);

-- 配种表
CREATE TABLE IF NOT EXISTS breeding (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent1    INTEGER NOT NULL,                -- 父母1 pNo
  parent2    INTEGER NOT NULL,                -- 父母2 pNo, -1 表示 "*" (任意)
  outcome_p_no  INTEGER NOT NULL,             -- 产出猪 pNo
  outcome_prob  REAL NOT NULL DEFAULT 0,      -- 产出概率 (%)
  visible    INTEGER NOT NULL DEFAULT 0,      -- 是否公开可见
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_breeding_parents ON breeding (parent1, parent2);
CREATE INDEX IF NOT EXISTS idx_breeding_outcome ON breeding (outcome_p_no);

-- ---------- 用户 / 同步 (沿用原 schema) ----------

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  nickname       TEXT NOT NULL,
  device_code    TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0,
  last_sync_at   INTEGER NOT NULL DEFAULT 0,
  data_modified_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collections (
  user_id  TEXT NOT NULL,
  p_no     INTEGER NOT NULL,
  added_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, p_no)
);

CREATE TABLE IF NOT EXISTS event_collections (
  user_id  TEXT NOT NULL,
  p_no     INTEGER NOT NULL,
  added_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, p_no)
);

CREATE TABLE IF NOT EXISTS badges (
  user_id    TEXT NOT NULL,
  badge_type TEXT NOT NULL,   -- 'small' | 'big'
  p_no       INTEGER NOT NULL,
  added_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, badge_type, p_no)
);

CREATE TABLE IF NOT EXISTS raising_records (
  id                   TEXT PRIMARY KEY,
  device_id            TEXT NOT NULL,
  p_no                 INTEGER NOT NULL,
  pig_name             TEXT,
  floor                TEXT NOT NULL DEFAULT 'normal',
  started_at           INTEGER NOT NULL DEFAULT 0,
  last_fed_at          INTEGER NOT NULL DEFAULT 0,
  feed_count           INTEGER NOT NULL DEFAULT 0,
  next_feed_at         INTEGER NOT NULL DEFAULT 0,
  notified_next_feed_at INTEGER,
  updated_at           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_raising_device ON raising_records (device_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_id    TEXT PRIMARY KEY,
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);
