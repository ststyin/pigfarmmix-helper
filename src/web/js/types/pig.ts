/**
 * 猪基础信息类型
 */

/** 图鉴三元组位置 */
export interface AtlasPosition {
  /** 图鉴号 1~7 (7 = Events/活动) */
  type: number;
  /** 页内序号 (1-based, 每页 6 格) */
  index: number;
  /** 是否在对应图鉴中可见 */
  visible: boolean;
}

/** 体重阈值 (小章/大章) */
export interface PigWeights {
  small: number;
  big: number;
}

/** 喂食信息 */
export interface PigFeeding {
  /** 喂食间隔 (小时) */
  interval?: number;
  /** 最少喂食次数 */
  times?: number;
  /** 挑食食材 ID 列表 */
  picky?: number[];
}

/** 配种指南 */
export interface BreedingGuide {
  requirements?: string;
  tips?: string | null;
}

/** 获取途径 */
export interface PigAcquisition {
  /** 商店等级概率 [A, B, C], 值为概率 (0~1) */
  shop?: number[];
  /** 狩猎 */
  hunt?: {
    /** 狩猎场 site id 列表 */
    sites?: number[];
    /** 概率 { any: {siteId: prob}, same: {siteId: prob} } */
    prob?: {
      any?: Record<string, number>;
      same?: Record<string, number>;
    };
  };
  /** 养成失败来源 pNo 列表 */
  fail?: number[];
  /** 超分歧/超出世 */
  specialFeeding?: boolean;
}

/** 猪的状态 */
export type PigStatus = "normal" | "hidden" | "removed";

/** 挑食程度 */
export type PickyLevel = "none" | "some" | "picky";

/** 猪基础信息 (对应 D1 `pigs` 表) */
export interface Pig {
  /** 猪的编号 (主键) */
  pNo: number;
  /** 名称 */
  name: string;
  /** 星级 1~6 */
  rare: number;
  /** 颜色代码 1~6 */
  color: number;
  /** 颜色文本 (由 book 或 color 推导) */
  color_text?: string;
  /** 描述 */
  description?: string;
  /** 图鉴位置 */
  atlas?: AtlasPosition;
  /** 推导出的图鉴号 (1~7) */
  book?: number;
  /** 推导出的页码 */
  page?: number | null;
  /** 推导出的格号 */
  slot?: number | null;
  /** 小章/大章阈值 */
  weight?: PigWeights;
  /** 借猪费用 */
  rent?: number;
  /** 售价 */
  price?: number;
  /** 成猪寿命 (小时) */
  lifespan?: number;
  /** 是否放牧 */
  graze?: boolean;
  /** 是否放牧 (isExer 别名) */
  isExer?: boolean;
  /** 是否特殊猪 (6星/超稀有) */
  special?: boolean;
  /** 状态: normal / hidden / removed */
  status?: PigStatus;
  /** 获取途径 */
  acquisition?: PigAcquisition;
  /** 喂食信息 */
  feeding?: PigFeeding;
  /** 配种指南 */
  breedingGuide?: BreedingGuide;
  /** 提示列表 */
  hints?: string[];
  /** 最后编辑人 userId (NULL = System / seed 数据) */
  updatedBy?: string | null;
  /** 最后编辑人昵名 (NULL = System 或用户已删除) — 后端用 LEFT JOIN users 填充 */
  updatedByName?: string | null;
  /** 最后编辑时间戳 (毫秒) — 可选展示 */
  updatedAt?: number;
}

/** 图鉴颜色 */
export type BookColor = 1 | 2 | 3 | 4 | 5 | 6;

/** 获得方式 */
export type AcquireMethod = "shop" | "hunt" | "hunt_event" | "breed" | "fail" | "feed_special";
