'use strict';
/*
 * bench.js — 检索配置评测台（不做断言，只出数据，用于推导默认配置）
 *
 * 背景：CLI 有三组可调旋钮——全量搜索（--deep）/ 跨源去重 / 加权排行（--rank --weights）。
 *       三者组合出的实际效果没有任何量化依据，默认配置是拍脑袋定的。
 *       本脚本用固定查询集把各组合的「召回 / 精度 / 去重 / 耗时」跑成数据，供人做决策。
 *
 * 设计约束：
 *   1. 自包含：web 侧直接读 data/web-cache/*.json（离线，不打网络）。无缓存时该组跳过并标注。
 *   2. 不改产品代码：只读取 + 复刻评分逻辑做对照，不 import sg.js（它是脚本，无导出）。
 *   3. 本地侧走子进程调 sg.js --json，保证测的是真实产品行为而非复刻。
 *
 * 指标口径：
 *   召回 hit    —— 命中条目总数（越大覆盖越广）
 *   精度 desc%  —— TopN 中含描述的条目占比（无描述=纯 URL 索引空壳，无法判断相关性）
 *   可用 avail% —— TopN 中本地有镜像（能读正文/能真用）的条目占比，仅本地 search 侧
 *   去重 uniq   —— TopN 中名称归一化后的唯一条目数（<N 即存在重复刷屏）
 *   来源 src    —— TopN 覆盖的来源数（跨源命中多样性）
 *   耗时 ms     —— 该组合单次检索耗时
 *
 * 用法: node test/bench.js [--json] [--local-only] [--web-only]
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const W = require('../lib/web-sources.js');
const CACHE_DIR = W.WEB_CACHE_DIR;
const SG = path.join(__dirname, '..', 'sg.js');

/* ---------------- 查询集 ---------------- */
// 通用词（考察精度）/ 长尾词（考察召回）/ 中文词（考察本地中文检索）三类
const WEB_QUERIES = ['pdf', 'excel', 'git', 'research', 'test', 'pdf-extractor', 'browser', 'markdown'];
const LOCAL_QUERIES = ['文档', '表格', 'pdf', 'ppt', '图片', 'excel', '视频', '搜索'];

const TOPN = 10;

/* ---------------- web 侧：候选池构造 ---------------- */
function loadCache() {
  const ids = W.SOURCES.filter((s) => !s.disabled).map((s) => s.id);
  const out = {};
  let ok = true;
  for (const id of ids) {
    const p = path.join(CACHE_DIR, `${id}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const fresh = Date.now() - raw.fetchedAt < W.CACHE_TTL_MS;
      if (!fresh) ok = false;
      out[id] = raw.items || [];
      out[id + ':mode'] = raw.mode;
      out[id + ':fresh'] = fresh;
    } catch { out[id] = []; out[id + ':mode'] = null; out[id + ':fresh'] = false; ok = false; }
  }
  return { byId: out, ids, complete: ok };
}

// 结构化条目 = 有描述的实体条目（API/SSR 实拉，可判断相关性）
// 索引条目   = sitemap 派生，仅 URL 末段作名，无描述
const isRich = (it) => (it.description || '').length > 10;

function pools(byId, ids) {
  const all = [];
  for (const id of ids) for (const it of byId[id]) all.push(it);
  const rich = all.filter(isRich);
  const indexOnly = all.filter((it) => !isRich(it));
  // 浅拉近似：SSR/API 首屏量（无 deep 缓存时按比例截断，仅用于对照趋势）
  const shallow = [];
  for (const id of ids) {
    const items = byId[id];
    const cap = { skillsmp: 48, claudeskills: 50, skillssh: 189, skillsrest: 12, skillhubclub: 12 }[id] || items.length;
    shallow.push(...items.slice(0, cap));
  }
  return { all, rich, indexOnly, shallow };
}

/* ---------------- web 侧：评分方案 ---------------- */
// score0 = 旧现状（sg.js cmdWeb 旧版）：name 精确5/前缀3/包含2 + desc 包含1（空壳霸榜，已废弃）
function score0(it, ql) {
  const nl = (it.name || '').toLowerCase();
  const dl = (it.description || '').toLowerCase();
  let s = 0;
  if (nl === ql) s += 5; else if (nl.startsWith(ql)) s += 3; else if (nl.includes(ql)) s += 2;
  if (dl.includes(ql)) s += 1;
  return s;
}

// score1 = 质量加权（bench 实验版）：空壳降权 35% 但不清零——实测对"精确名空壳"仍不够狠（5×0.35=1.75 > 实体 desc 命中 1）
function score1(it, ql) {
  const raw = score0(it, ql);
  if (raw === 0) return 0;
  const quality = isRich(it) ? 1 : 0.35;                       // 空壳降到 35%，不再霸占 TopN
  const namePenalty = /^[a-z0-9]+-[a-f0-9]{6,}$/.test(it.name || '') ? 0.8 : 1; // sitemap 哈希后缀垃圾名再降
  return +(raw * quality * namePenalty).toFixed(3);
}

// scoreWeb = 产品默认（v0.8.1，sg.js cmdWeb 实际使用）：三级分层 真描述×1/模板×0.55/空壳×0.2
const scoreWeb = (it, ql) => W.scoreWeb(it, ql);

function runWebSearch(items, q, scorer, limit) {
  const ql = q.toLowerCase();
  const scored = [];
  for (const it of items) {
    const s = scorer(it, ql);
    if (s > 0) scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit);
}

/* ---------------- 指标计算 ---------------- */
function metrics(scored, ms) {
  const top = scored.slice(0, TOPN);
  const withDesc = top.filter((x) => isRich(x.it)).length;      // 有信息 = 非空壳（描述 >10 字符，含模板）
  const keys = new Set(top.map((x) => W.nameKey(x.it.name)));
  const srcs = new Set(top.flatMap((x) => x.it.sources || [x.it.source]));
  return {
    hit: scored.length,
    infoPct: top.length ? Math.round((withDesc / top.length) * 100) : 0, // 非空壳占比（空壳=纯 URL 索引壳）
    uniq: keys.size,
    src: srcs.size,
    ms,
  };
}

/* ---------------- 本地侧：子进程调真实 CLI ---------------- */
function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SG, ...args], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// 有镜像 = market 含「缓存」，即可读 SKILL.md 正文、能真用；纯索引条目装不上
const isAvailable = (row) => (row.market || '').includes('缓存');

function localMetrics(rows) {
  const top = rows.slice(0, TOPN);
  return {
    hit: rows.length,
    avail: top.filter(isAvailable).length,
    availPct: top.length ? Math.round((top.filter(isAvailable).length / top.length) * 100) : 0,
    hotHit: top.filter((r) => (r.usage || 0) > 0).length,
    names: top.map((r) => r.name),
  };
}

/* ---------------- 主流程 ---------------- */
async function benchWeb(jsonMode) {
  const { byId, ids, complete } = loadCache();
  const empty = ids.every((id) => !byId[id].length);
  if (empty) {
    console.log('\n[web] 跳过：data/web-cache 无缓存（先跑 sg web <词> --deep 预热）');
    return { skipped: true };
  }
  const P = pools(byId, ids);
  if (!complete) console.log('\n[web] 警告：部分缓存已过期（TTL 6h），趋势仍可参考');

  const configs = [
    { id: 'A1 浅拉+去重+现状分', items: W.dedupeWeb(P.shallow), scorer: score0, dedupe: true },
    { id: 'A2 全量+去重+现状分(旧)', items: W.dedupeWeb(P.all), scorer: score0, dedupe: true },
    { id: 'A3 全量+去重+质量加权(实验)', items: W.dedupeWeb(P.all), scorer: score1, dedupe: true },
    { id: 'A4 结构化全量+去重', items: W.dedupeWeb(P.rich), scorer: score0, dedupe: true },
    { id: 'A5 结构化全量+质量加权', items: W.dedupeWeb(P.rich), scorer: score1, dedupe: true },
    { id: 'A6 全量+去重+质量加权+空壳补尾', items: W.dedupeWeb(P.rich).concat(W.dedupeWeb(P.indexOnly)), scorer: score1, dedupe: true },
    { id: 'A7 全量+不去重+现状分', items: P.all, scorer: score0, dedupe: false },
    { id: 'A8 全量+去重+三级分层(产品v0.8.1)', items: W.dedupeWeb(P.all), scorer: scoreWeb, dedupe: true },
  ];

  const rows = [];
  for (const cfg of configs) {
    const agg = { hit: 0, infoPct: 0, uniq: 0, src: 0, ms: 0 };
    let t0 = Date.now();
    for (const q of WEB_QUERIES) {
      const t = Date.now();
      const scored = runWebSearch(cfg.items, q, cfg.scorer, TOPN);
      const m = metrics(scored, Date.now() - t);
      agg.hit += m.hit; agg.infoPct += m.infoPct; agg.uniq += m.uniq; agg.src += m.src; agg.ms += m.ms;
    }
    const n = WEB_QUERIES.length;
    rows.push({
      配置: cfg.id, 候选池: cfg.items.length,
      命中总数: agg.hit,
      'TopN有信息%': Math.round(agg.infoPct / n),
      'TopN唯一': +(agg.uniq / n).toFixed(1),
      'TopN来源数': +(agg.src / n).toFixed(1),
      '平均ms': Math.round(agg.ms / n),
    });
    void t0;
  }

  if (jsonMode) { console.log(JSON.stringify(rows, null, 2)); return { rows }; }
  console.log('\n## web 直读源（S5）配置矩阵');
  console.log(`查询集 ${WEB_QUERIES.length} 个词，TopN=${TOPN}，候选池来自 6h 内缓存\n`);
  printTable(rows);
  return { rows };
}

async function benchLocal(jsonMode) {
  // 权重组合与产品实际一致（含 avail 信号，v0.8.1）：rank.js DEFAULT_WEIGHTS.mixed = match 0.45/avail 0.3/usage 0.15/recency 0.1
  // 实测结论（2026-09-02）：本地池信号稀疏（仅 24 个有 usage 的镜像），含 avail 的任意权重组合可用率
  // 均达 1.9（Top8），Top3 样例相同；去掉 avail 掉到 1.6、纯相关掉到 0.9。权重在当前数据上不敏感，
  // 默认值保持。分层实验（name 级优先）能修"图片"类查询污染但误伤"文档"类 desc 命中可用镜像，弃用。
  const configs = [
    { id: 'L1 纯相关(--rank off)', args: ['--rank', 'off'] },
    { id: 'L2 产品默认 0.45/0.3/0.15/0.1', args: ['--rank', 'mixed'] },
    { id: 'L3 match主导 0.55/0.25/0.1/0.1', args: ['--rank', 'mixed', '--weights', 'match=0.55,avail=0.25,usage=0.1,recency=0.1'] },
    { id: 'L4 avail主导 0.35/0.4/0.15/0.1', args: ['--rank', 'mixed', '--weights', 'match=0.35,avail=0.4,usage=0.15,recency=0.1'] },
    { id: 'L5 无avail 0.7/0/0.2/0.1', args: ['--rank', 'mixed', '--weights', 'match=0.7,usage=0.2,recency=0.1'] },
    { id: 'L6 usage主导 0.35/0.2/0.35/0.1', args: ['--rank', 'mixed', '--weights', 'match=0.35,avail=0.2,usage=0.35,recency=0.1'] },
  ];
  const rows = [];
  for (const cfg of configs) {
    let avail = 0, hotHit = 0, hit = 0, ms = 0, n = 0;
    const samples = [];
    for (const q of LOCAL_QUERIES) {
      const t = Date.now();
      const rowsJson = await runCli(['search', q, '--limit', String(TOPN), '--json', ...cfg.args]);
      ms += Date.now() - t;
      if (!rowsJson) continue;
      // --limit 会截断，命中总数不可得，这里只统计 TopN 质量
      const m = localMetrics(rowsJson);
      avail += m.avail; hotHit += m.hotHit; hit += rowsJson.length; n++;
      if (q === '文档' || q === '表格') samples.push(`${q}: ${rowsJson.slice(0, 3).map((r) => r.name + (isAvailable(r) ? '*' : '')).join(' / ')}`);
    }
    rows.push({
      配置: cfg.id,
      'TopN可用条数': +(avail / (n || 1)).toFixed(1),
      '可用率%': Math.round((avail / (n || 1)) / TOPN * 100),
      'TopN有热度条数': +(hotHit / (n || 1)).toFixed(1),
      '平均ms': Math.round(ms / (n || 1)),
      样例: samples.join('  ‖  '),
    });
    void hit;
  }
  if (jsonMode) { console.log(JSON.stringify(rows, null, 2)); return { rows }; }
  console.log('\n## 本地六源 search 配置矩阵');
  console.log(`查询集 ${LOCAL_QUERIES.length} 个词，TopN=${TOPN}，* 标记 = 本地有镜像（能读正文/能真用）\n`);
  printTable(rows);
  return { rows };
}

function printTable(rows) {
  const cols = Object.keys(rows[0]);
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  console.log('| ' + cols.map((c) => c.padEnd(width[c])).join(' | ') + ' |');
  console.log('|' + cols.map((c) => '-'.repeat(width[c] + 2)).join('|') + '|');
  for (const r of rows) console.log('| ' + cols.map((c) => String(r[c]).padEnd(width[c])).join(' | ') + ' |');
  console.log('');
}

(async () => {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const only = argv.includes('--local-only') ? 'local' : argv.includes('--web-only') ? 'web' : 'all';
  console.log('# 检索配置评测（bench）');
  console.log(`# 时间: ${new Date().toISOString()}`);
  if (only !== 'local') await benchWeb(jsonMode);
  if (only !== 'web') await benchLocal(jsonMode);
})();
