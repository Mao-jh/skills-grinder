'use strict';
/*
 * rank.js — 多信号加权排行（--rank）
 *
 * 背景：单信号排序有盲区（hot 只看次数、latest 只看时间、search 只看相关度）。
 *       本模块把候选的多个信号归一化后按权重融合，输出可解释的综合分。
 *
 * 四个信号：
 *   match    相关度分 0~100（search 场景产生，hot/latest 无）
 *   avail    可用性：本地有镜像（可读 SKILL.md 正文、能真用）=1，纯市场索引条目=0
 *   usage    真实使用次数（缓存镜像有，索引条目为 0）
 *   recency  新近信号：versionTs（版本内嵌 unix 秒）或 mtime（毫秒），取有值者
 *
 * avail 为什么必须有（2026-09-02 bench 实测）：本地候选池 489 个索引条目中仅 38 个
 * 有本地镜像（7.8%），其余搜到了也读不到正文。纯按相关度排时，Top10 平均只有 1.1 条
 * 可用（11%）——AI 拿到一堆装不上的条目。availability 是「能不能用」，
 * relevance 是「像不像」，前者是硬约束，必须在默认权重里占位。
 *
 * 设计约束：
 *   1. 量纲归一化：所有信号先归一化到 0~1 再加权。禁止直接相加——
 *      时间戳是 10 位数，直接加权会吞掉其他信号（usage=115 在 1788112410 面前约等于 0）。
 *   2. 缺失兜底：信号缺失给 0（不给中性分）——缺失即"不贡献"。
 *      索引条目 usage/recency 为 0 是诚实的，不伪装。
 *   3. 权重可调：默认权重写死理由；--weights 可覆盖；权重自动归一化到总和 1。
 *   4. 可解释：输出分数构成（total + 各分量），不搞黑盒。
 *   5. 归一化基准 = 当前候选集内部（min-max），即"榜内相对"。
 */

/* 场景默认权重（权重之和不必为 1，rankCandidates 内会归一化）
 * 数值来自 test/bench.js 实测：以「Top3 可用条数」为主指标、「不埋没精确名称匹配」为约束。
 * avail 在 search 场景给 0.3——足以把可用条目抬进 Top3，又不至于让低相关的高热条目霸榜。 */
const DEFAULT_WEIGHTS = {
  mixed: { match: 0.45, avail: 0.3, usage: 0.15, recency: 0.1 }, // search：相关>可用>热度>新近
  hot: { avail: 0.35, usage: 0.5, recency: 0.15 },               // 热度主导，可用破平（空描述内部件不再霸榜）
  latest: { avail: 0.35, recency: 0.5, usage: 0.15 },            // 新近主导，可用破平
};

/** min-max 基准；空集返回 [0,1]（归一化结果全为中性 0.5） */
function minMax(values) {
  if (!values.length) return [0, 1];
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** 归一化到 0~1；max===min（无区分度）时：全 0 = 信号缺失，给 0（缺失即不贡献，不伪装）；
 *  非零且相等（如全部 usage=5）给中性 0.5（有数据但无区分度，取中间值公平）。 */
function norm(v, min, max) {
  if (max === min) return max === 0 ? 0 : 0.5;
  return (v - min) / (max - min);
}

/** recency 原始值：versionTs（秒）→ 毫秒统一；无则 mtime（已是毫秒）；再无 → 0 */
function recencyRaw(c) {
  if (c.versionTs) return c.versionTs * 1000;
  if (c.mtime) return c.mtime;
  return 0;
}

/** avail 原始值：有本地镜像（能读正文）=1，纯索引条目=0。
 *  判定用 mirror 字段；退而用 isIndex===false 覆盖未挂 mirror 的非索引条目。 */
function availRaw(c) {
  if (c.mirror) return 1;
  if (c.isIndex === false) return 1;
  return 0;
}

/**
 * 对候选集做加权排行
 * @param {object[]} cands 候选（需含 usage/mtime/versionTs/matchScore 字段，缺失按 0）
 * @param {{mode?: string, weights?: object}} opts mode=mixed|hot|latest；weights 形如 {match:0.5,usage:0.3}
 * @returns {{c: object, rank: {total:number, match:number, usage:number, recency:number}}[]} 按 total 降序
 */
function rankCandidates(cands, opts = {}) {
  if (!cands || !cands.length) return [];
  const mode = opts.mode || 'mixed';
  const w = opts.weights && Object.keys(opts.weights).length ? opts.weights : DEFAULT_WEIGHTS[mode] || DEFAULT_WEIGHTS.mixed;
  const keys = Object.keys(w);
  const wSum = keys.reduce((s, k) => s + (w[k] || 0), 0) || 1;
  const wN = {};
  for (const k of keys) wN[k] = (w[k] || 0) / wSum;

  const [uMin, uMax] = minMax(cands.map((c) => c.usage || 0));
  const [rMin, rMax] = minMax(cands.map(recencyRaw));

  return cands
    .map((c) => {
      const m = keys.includes('match') ? Math.min(1, (c.matchScore || 0) / 100) : undefined; // clamp：匹配分可叠加超 100，封顶 1
      const a = keys.includes('avail') ? availRaw(c) : undefined;                            // 已是 0/1，无需归一化
      const u = keys.includes('usage') ? norm(c.usage || 0, uMin, uMax) : undefined;
      const r = keys.includes('recency') ? norm(recencyRaw(c), rMin, rMax) : undefined;
      const total = (wN.match || 0) * (m || 0) + (wN.avail || 0) * (a || 0)
        + (wN.usage || 0) * (u || 0) + (wN.recency || 0) * (r || 0);
      const rank = { total: +total.toFixed(3) };
      if (m !== undefined) rank.match = +m.toFixed(3);   // 未参与权重的信号不输出（如榜单加权无 match）
      if (a !== undefined) rank.avail = a;               // 可用 1 / 不可用 0
      if (u !== undefined) rank.usage = +u.toFixed(3);   // 避免"相关 0 / 热度 1"式的噪音分量
      if (r !== undefined) rank.recency = +r.toFixed(3);
      return { c, rank };
    })
    .sort((a, b) => b.rank.total - a.rank.total || a.c.indexOrder - b.c.indexOrder);
}

/** 解析 --weights "match=0.5,usage=0.3" → {match:0.5, usage:0.3}；非法输入返回 null */
function parseWeights(str) {
  if (!str) return null;
  const out = {};
  for (const pair of String(str).split(',')) {
    const [k, v] = pair.split('=');
    if (!k || !v) return null;
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    out[k.trim()] = n;
  }
  return out;
}

module.exports = { rankCandidates, parseWeights, minMax, norm, recencyRaw, availRaw, DEFAULT_WEIGHTS };
