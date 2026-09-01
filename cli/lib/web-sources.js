'use strict';
/*
 * web-sources.js — S5 web 直读源（外部 skills 网站，打开即见具体条目）
 *
 * 背景：本地六路源（S1-S4）之外，互联网上有大量"打开就能读到具体技能条目"的 skills 目录站。
 * 本项目只接「直读」源——不接需要登录/客户端渲染逆向/专用 CLI 的站。
 *
 * 接入源（5 个可直读）：
 *   skillsmp     SkillsMP      JSON API（limit≤48，封顶 1200 条）—— 最结构化
 *   claudeskills ClaudeSkills  JSON API（需浏览器 UA + Accept: application/json；全量约 383 条）
 *   skillssh     Skills.sh     HTML 首页排行榜（SSR ~189 条）；--deep 拉 sitemap-skills-*.xml（2 万 URL 索引）
 *   skillsrest   Skills.rest   HTML explore 首屏（SSR ~12 条）；--deep 拉 sitemap-index/*.xml（数万 URL 索引）
 *   skillhubclub SkillHub Club HTML 首页卡片（SSR 12 条）；--deep 翻页（/skills?page=N，默认 10 页）
 *
 * 暂不可直读（disabled，标注原因）：
 *   clawhub      客户端渲染（条目经 JS 加载，无 SSR 数据）
 *   skillhubcn   客户端渲染（腾讯 cloudcache JS 加载，需逆向）
 *   agentskill   服务端 503，暂不可用
 *   lobehub      需官方 CLI（npx @lobehub/market-cli 搜索），非直读
 *
 * 去重：跨源按名称归一化合并（lowercase + 去非字母数字），同名多源聚合来源标签、
 *       保留描述最长者 —— CLI 检索时同一 skill 不再重复刷屏。
 *
 * 缓存：拉取结果落 data/web-cache/<id>.json（含 fetchedAt），TTL 6 小时；
 *       --force 跳过缓存强制刷新。缓存复用避免每次搜索都打爆外部站。
 */

const fs = require('fs');
const path = require('path');
const { httpGet } = require('./sources.js');

const WEB_CACHE_DIR = path.join(__dirname, '..', 'data', 'web-cache');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ---------- 基础拉取 ---------- */
function getText(url, timeoutMs = 20000, headers = {}) {
  return httpGet(url, timeoutMs, { 'User-Agent': UA, ...headers });
}

/* ---------- 条目规范化 ---------- */
function norm(sourceId, market, name, description, url, author, extra = {}) {
  return {
    name: String(name || '').trim(),
    description: String(description || '').trim().slice(0, 400),
    url: String(url || '').trim(),
    author: String(author || '').trim(),
    market,
    source: sourceId,
    ...extra,
  };
}

/* ---------- 各源解析 ---------- */

// Skills.sh：首页 SSR 排行榜。条目为 <a class="group grid..." href="/owner/repo/name"><h3>name</h3><p>owner/repo</p>...
function parseSkillssh(html) {
  const out = [];
  const re = /<a class="group grid[\s\S]*?href="\/([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>[\s\S]*?<p[^>]*>([^<]+)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    out.push(norm('skillssh', 'Skills.sh', m[2].trim(), `由 ${m[3].trim()} 提供，见源站排行榜`, 'https://www.skills.sh/' + m[1], m[3].trim()));
  }
  return out;
}

// Skills.rest：explore 页 RSC payload（HTML 内转义 \" 需先解开一层）
function parseSkillsrest(html) {
  const c = html.replace(/\\"/g, '"');
  const out = [];
  const re = /"slug":"([^"]+)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(c))) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const seg = c.slice(m.index, m.index + 700);
    const name = (seg.match(/"name":"([^"]+)"/) || [])[1] || slug;
    const tag = (seg.match(/"tagline":"([^"]+)"/) || [])[1] || '';
    const au = (seg.match(/"author_name":"([^"]+)"/) || [])[1] || '';
    const url = (seg.match(/"source_url":"([^"]+)"/) || [])[1] || 'https://skills.rest/skill/' + slug;
    out.push(norm('skillsrest', 'Skills.rest', name, tag, url, au));
  }
  // slug 正则把 RSC 引用里的 slug 也抓进来，剔除无 name 且无 tagline 的噪音
  return out.filter((x) => x.name && (x.description || x.author || /^[a-z0-9-]{4,}$/.test(x.name)));
}

// SkillHub Club：首页 SSR 卡片。条目为 <a class="block h-full min-w-0 group" href="/skills/slug">...@author...<h3/lang>...
function parseSkillhubclub(html) {
  const out = [];
  const re = /<a class="block h-full min-w-0 group" href="\/skills\/([^"]+)"[\s\S]*?@<!-- -->([a-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    const author = m[2];
    const lang = (html.slice(m.index, m.index + 2500).match(/<h[23][^>]*>([^<]{2,12})<\/h[23]>/) || [])[1] || '';
    out.push(norm('skillhubclub', 'SkillHub Club', slug, `由 @${author} 提供${lang ? `（语言 ${lang}）` : ''}`, 'https://www.skillhub.club/skills/' + slug, author));
  }
  return out;
}

/* ---------- sitemap 工具（--deep 用） ---------- */
function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

// 从 sitemap URL 列表提取条目（URL 末段作名称，无描述 —— 纯索引）
function indexFromUrls(urls, sourceId, market, nameFn) {
  const out = [];
  for (const u of urls) {
    const name = nameFn ? nameFn(u) : decodeURIComponent(u.split('/').filter(Boolean).pop() || '');
    if (name) out.push(norm(sourceId, market, name, '', u, ''));
  }
  return out;
}

/* ---------- 并发拉取（deep 分页/索引用，控制对源站的压力） ---------- */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch { results[i] = null; }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

/* ---------- 源注册表 ---------- */
const SOURCES = [
  {
    id: 'skillsmp', name: 'SkillsMP', homepage: 'https://skillsmp.com/zh',
    note: '2.8M SKILL.md 收录；API 封顶 1200 条（--deep 拉全量）',
    fetch: async (deep) => {
      const limit = 48;
      const pages = deep ? 25 : 1;
      const all = [];
      for (let p = 1; p <= pages; p++) {
        const j = JSON.parse(await getText(`https://skillsmp.com/api/skills?limit=${limit}&page=${p}`));
        const items = (j.skills || []).map((s) =>
          norm('skillsmp', 'SkillsMP', s.name, s.description || '', s.githubUrl || '', s.author || ''));
        all.push(...items);
        if (!(j.pagination && j.pagination.hasNext)) break;
      }
      return all;
    },
  },
  {
    id: 'claudeskills', name: 'ClaudeSkills', homepage: 'https://claudeskills.info/skills',
    note: '42,820 已收录；API 暴露约 383 条（--deep 拉全量）',
    fetch: async (deep) => {
      const limit = 50;
      const maxItems = deep ? 600 : 50;
      const all = [];
      let offset = 0;
      let total = Infinity;
      while (all.length < maxItems && offset < total) {
        const j = JSON.parse(await getText(
          `https://claudeskills.info/api/skills?limit=${limit}&offset=${offset}`,
          20000, { Accept: 'application/json' }));
        const items = j.skills || [];
        total = j.total || items.length;
        all.push(...items.map((s) =>
          norm('claudeskills', 'ClaudeSkills', s.name, s.summary || s.description || '',
            s.repo_url || `https://claudeskills.info/skills/${s.slug}`, s.repo_owner || s.author_name || '')));
        if (!items.length) break;
        offset += limit;
      }
      return all;
    },
  },
  {
    id: 'skillssh', name: 'Skills.sh', homepage: 'https://skills.sh/',
    note: '首页 SSR 排行榜 ~189 条；--deep 拉 sitemap 2 万 URL 索引',
    fetch: async (deep) => {
      const items = parseSkillssh(await getText('https://www.skills.sh/'));
      if (!deep) return items;
      const index = await getText('https://www.skills.sh/sitemap.xml');
      const subSitemaps = extractLocs(index).filter((u) => u.includes('sitemap-skills-'));
      const xmls = await mapLimit(subSitemaps, 3, (u) => getText(u));
      const urls = [];
      for (const xml of xmls) urls.push(...extractLocs(xml));
      const idx = indexFromUrls(urls, 'skillssh', 'Skills.sh(索引)', (u) => {
        const parts = u.split('/').filter(Boolean);
        return parts[parts.length - 1] || '';
      });
      return items.concat(idx);
    },
  },
  {
    id: 'skillsrest', name: 'Skills.rest', homepage: 'https://skills.rest/explore',
    note: 'explore 首屏 SSR ~12 条；--deep 拉 sitemap 全量 skill URL 索引',
    fetch: async (deep) => {
      const items = parseSkillsrest(await getText('https://skills.rest/explore'));
      if (!deep) return items;
      const index = await getText('https://skills.rest/sitemap.xml');
      const subSitemaps = extractLocs(index).filter((u) => u.includes('sitemap-index/'));
      // 65 个子索引太多，deep 拉前 20 个（约数万 URL 已足够检索用）
      const xmls = await mapLimit(subSitemaps.slice(0, 20), 5, (u) => getText(u));
      const urls = [];
      for (const xml of xmls) urls.push(...extractLocs(xml));
      const skillUrls = urls.filter((u) => u.includes('/skill/'));
      const idx = indexFromUrls(skillUrls, 'skillsrest', 'Skills.rest(索引)');
      return items.concat(idx);
    },
  },
  {
    id: 'skillhubclub', name: 'SkillHub Club', homepage: 'https://www.skillhub.club/skills',
    note: '首页 SSR 12 条；--deep 翻页最多 10 页',
    fetch: async (deep) => {
      const items = parseSkillhubclub(await getText('https://www.skillhub.club/skills'));
      if (!deep) return items;
      const pages = await mapLimit(Array.from({ length: 10 }, (_, i) => i + 2), 3, async (p) => {
        const html = await getText(`https://www.skillhub.club/skills?page=${p}`);
        return parseSkillhubclub(html);
      });
      return items.concat(...pages);
    },
  },
  // ---- 暂不可直读（disabled） ----
  { id: 'clawhub', name: 'ClawHub', homepage: 'https://clawhub.ai/skills', disabled: true, reason: '客户端渲染，条目经 JS 加载，无 SSR 数据可解析' },
  { id: 'skillhubcn', name: 'SkillHub 腾讯', homepage: 'https://skillhub.cn/skills', disabled: true, reason: '客户端渲染（腾讯 cloudcache JS 加载），需逆向' },
  { id: 'agentskill', name: 'AgentSkill.sh', homepage: 'https://agentskill.sh/', disabled: true, reason: '服务端 503，暂不可用' },
  { id: 'lobehub', name: 'LobeHub', homepage: 'https://lobehub.com/skills', disabled: true, reason: '需官方 CLI（npx @lobehub/market-cli 搜索），非直读' },
];

/* ---------- 缓存 ---------- */
function cachePath(id) { return path.join(WEB_CACHE_DIR, `${id}.json`); }

// 浅拉/深拉缓存分开：--deep 命中深拉缓存，普通模式命中浅拉缓存，互不串用
function readCache(id, deep) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(id), 'utf8'));
    if (raw && Array.isArray(raw.items) && raw.mode === (deep ? 'deep' : 'shallow') && Date.now() - raw.fetchedAt < CACHE_TTL_MS) return raw.items;
  } catch { /* 无缓存或损坏 */ }
  return null;
}

function writeCache(id, items, deep) {
  try {
    fs.mkdirSync(WEB_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(id), JSON.stringify({ fetchedAt: Date.now(), mode: deep ? 'deep' : 'shallow', items }), 'utf8');
  } catch { /* 缓存失败不致命 */ }
}

/* ---------- 拉取单源（缓存优先） ---------- */
async function fetchSource(src, opts = {}) {
  if (src.disabled) return [];
  const deep = !!opts.deep;
  const cache = opts.force ? null : readCache(src.id, deep);
  if (cache) return cache;
  const items = await src.fetch(deep);
  writeCache(src.id, items, deep);
  return items;
}

/* ---------- 条目分层 + 三级评分（web 搜索排序，2026-09-02 bench 定稿） ----------
 * 背景：--deep 全量 22 万条候选里 99.4% 是 sitemap URL 索引空壳（名称即 URL 末段，
 *       天然命中词根）。旧评分（score0，仅 name/desc 包含）下空壳霸榜：
 *       搜 "pdf" Top10 有 6 个空壳、"pdf-extractor" Top10 全是同名变体空壳，
 *       实体条目（有真描述）永远沉底。三级分层后实体必压过空壳：
 *         real（真描述实体）×1  >  tpl（模板话术，有作者无功能）×0.55  >  shell（纯链接）×0.2
 *       哈希后缀名（sitemap 派生的 repo 名）再乘 0.8。
 */
const WEB_TIER_MULT = { real: 1, tpl: 0.55, shell: 0.2 };
const HASH_NAME_RE = /^[a-z0-9]+-[a-f0-9]{6,}$/;
// 模板话术特征：SSR 首页卡片"由 xxx 提供，见源站排行榜" / "@xxx 提供（语言 xx）"
const TPL_DESC_RE = /^(由|@)[^，。]{1,40}(提供|$)/;

/** 条目分层：real=真描述实体 / tpl=模板伪实体（有作者无功能描述） / shell=空壳（仅链接） */
function entryTier(it) {
  const d = (it.description || '').trim();
  if (d.length <= 10) return 'shell';
  if (TPL_DESC_RE.test(d.replace(/\s+/g, ''))) return 'tpl';
  return 'real';
}

/** 三级分层评分：name 精确5/前缀3/包含2 + desc 包含1，再乘层级系数与哈希名惩罚 */
function scoreWeb(it, ql) {
  const nl = (it.name || '').toLowerCase();
  const dl = (it.description || '').toLowerCase();
  let s = 0;
  if (nl === ql) s += 5; else if (nl.startsWith(ql)) s += 3; else if (nl.includes(ql)) s += 2;
  if (dl.includes(ql)) s += 1;
  if (s === 0) return 0;
  const mult = WEB_TIER_MULT[entryTier(it)] ?? 1;
  const penalty = HASH_NAME_RE.test(it.name || '') ? 0.8 : 1;
  return +(s * mult * penalty).toFixed(3);
}

/* ---------- 跨源去重（名称归一化合并） ---------- */
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dedupeWeb(items) {
  const byKey = new Map();
  for (const it of items) {
    if (!it.name) continue;
    const key = nameKey(it.name);
    const hit = byKey.get(key);
    if (!hit) { byKey.set(key, { ...it, sources: [it.source] }); continue; }
    if (!hit.sources.includes(it.source)) hit.sources.push(it.source);
    if (it.description.length > hit.description.length) {
      hit.description = it.description;
      hit.url = it.url || hit.url;
      hit.author = it.author || hit.author;
    }
  }
  return [...byKey.values()];
}

/* ---------- 全源拉取 + 合流去重 ---------- */
async function pullAllWeb(opts = {}) {
  const enabled = SOURCES.filter((s) => !s.disabled);
  const results = await mapLimit(enabled, 3, (s) => fetchSource(s, opts));
  const all = [];
  // 注意：不能用 all.push(...items) —— 大数组（skillsrest --deep 可达 20 万条）spread 会爆调用栈
  for (const items of results) { for (const it of items) all.push(it); }
  return { items: dedupeWeb(all), sources: enabled };
}

/* ---------- 源状态（sg sources 用） ---------- */
function webSourceStatus() {
  return SOURCES.map((s) => {
    if (s.disabled) return { id: s.id, name: s.name, homepage: s.homepage, disabled: true, reason: s.reason };
    const cache = readCache(s.id, true) || readCache(s.id, false);
    return {
      id: s.id, name: s.name, homepage: s.homepage, disabled: false, note: s.note,
      cached: !!cache, cachedAt: cache ? new Date(cache.fetchedAt || Date.now()).toISOString() : null, count: cache ? cache.length : 0,
    };
  });
}

module.exports = {
  SOURCES,
  pullAllWeb,
  fetchSource,
  dedupeWeb,
  nameKey,
  entryTier,
  scoreWeb,
  WEB_TIER_MULT,
  parseSkillssh,
  parseSkillsrest,
  parseSkillhubclub,
  webSourceStatus,
  WEB_CACHE_DIR,
  CACHE_TTL_MS,
};
