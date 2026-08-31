#!/usr/bin/env node
/**
 * JSON → D1 迁移脚本
 *
 * 把 static/data/pigs_full_zhs.json 转换为可直接导入 Cloudflare D1 的 SQL 文件。
 *
 * 用法:
 *   node scripts/seed-d1.mjs [--input <json路径>] [--output <sql路径>]
 *
 * 默认输入: static/data/pigs_full_zhs.json
 * 默认输出: functions/db/seed.sql
 *
 * 导入方式 (二选一):
 *   1. wrangler d1 execute <DB_NAME> --file=functions/db/seed.sql --remote
 *   2. 本地开发: wrangler d1 execute <DB_NAME> --file=functions/db/seed.sql --local
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const INPUT = resolve(getArg("--input", "static/data/pigs_full_zhs.json"));
const OUTPUT = resolve(getArg("--output", "functions/db/seed.sql"));

function main() {
  const raw = readFileSync(INPUT, "utf8");
  const bundle = JSON.parse(raw);

  if (!bundle || !Array.isArray(bundle.pigs)) {
    console.error("数据格式错误: 缺少 pigs 数组");
    process.exit(1);
  }

  const lines = [];
  lines.push("-- ============================================================");
  lines.push("-- 图鉴数据 seed (由 scripts/seed-d1.mjs 自动生成)");
  lines.push(`-- 来源: ${INPUT}`);
  lines.push("-- 生成时间: " + new Date().toISOString());
  lines.push("-- ============================================================");
  lines.push("");

  // ---------- pigs 表 ----------
  lines.push("DELETE FROM pigs;");
  lines.push("");

  const pigValues = [];
  for (const p of bundle.pigs) {
    const atlas = p.atlas || {};
    const weight = p.weight || {};
    const acquisition = p.acquisition ? JSON.stringify(p.acquisition) : null;
    const feeding = p.feeding ? JSON.stringify(p.feeding) : null;
    const breedingGuide = p.breedingGuide ? JSON.stringify(p.breedingGuide) : null;
    const hints = p.hints && p.hints.length ? JSON.stringify(p.hints) : null;

    const esc = (s) => String(s).replace(/'/g, "''");
    const vals = [
      Number(p.pNo),
      `'${esc(p.name)}'`,
      Number(p.rare) || 1,
      Number(p.color) || 0,
      p.description ? `'${esc(p.description)}'` : "NULL",
      atlas.type != null ? Number(atlas.type) : "NULL",
      atlas.index != null ? Number(atlas.index) : "NULL",
      atlas.visible == null ? 1 : (atlas.visible ? 1 : 0),
      weight.small != null ? Number(weight.small) : "NULL",
      weight.big != null ? Number(weight.big) : "NULL",
      p.rent != null ? Number(p.rent) : "NULL",
      p.price != null ? Number(p.price) : "NULL",
      p.lifespan != null ? Number(p.lifespan) : "NULL",
      p.graze ? 1 : 0,
      p.special ? 1 : 0,
      p.status ? `'${esc(p.status)}'` : "'normal'",
      acquisition ? `'${esc(acquisition)}'` : "NULL",
      feeding ? `'${esc(feeding)}'` : "NULL",
      breedingGuide ? `'${esc(breedingGuide)}'` : "NULL",
      hints ? `'${esc(hints)}'` : "NULL",
      Date.now(),
      "NULL",  // updated_by — seed 猪无编辑人,显示 System
    ];
    pigValues.push(`(${vals.join(", ")})`);
  }

  // 分批 INSERT (每批 100 行, 避免单条语句过大)
  for (let i = 0; i < pigValues.length; i += 100) {
    const chunk = pigValues.slice(i, i + 100);
    lines.push("INSERT INTO pigs (");
    lines.push("  p_no, name, rare, color, description,");
    lines.push("  atlas_type, atlas_index, atlas_visible,");
    lines.push("  weight_small, weight_big,");
    lines.push("  rent, price, lifespan, graze, special, status,");
    lines.push("  acquisition, feeding, breeding_guide, hints, updated_at, updated_by");
    lines.push(") VALUES");
    lines.push(chunk.join(",\n") + ";");
    lines.push("");
  }

  // ---------- breeding 表 ----------
  lines.push("DELETE FROM breeding;");
  lines.push("");

  const breedValues = [];
  for (const rec of bundle.breeding || []) {
    const [p1, p2] = rec.parents;
    const p2Final = p2 === "*" ? -1 : Number(p2);
    for (const outcome of rec.outcomes || []) {
      breedValues.push(
        `(${Number(p1)}, ${p2Final}, ${Number(outcome.pNo)}, ${Number(outcome.prob)}, ${rec.visible ? 1 : 0}, ${Date.now()})`
      );
    }
  }

  for (let i = 0; i < breedValues.length; i += 100) {
    const chunk = breedValues.slice(i, i + 100);
    lines.push("INSERT INTO breeding (parent1, parent2, outcome_p_no, outcome_prob, visible, updated_at) VALUES");
    lines.push(chunk.join(",\n") + ";");
    lines.push("");
  }


  writeFileSync(OUTPUT, lines.join("\n"), "utf8");
  console.log(`✅ 已生成 ${OUTPUT}`);
  console.log(`   pigs: ${bundle.pigs.length} 行`);
  console.log(`   breeding: ${breedValues.length} 行`);
}

main();
