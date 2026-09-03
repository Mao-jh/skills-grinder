'use strict';
/*
 * body-fetch.js — web 源 SKILL.md 正文抓取（S5 深度扩展，v0.10.0）
 *
 * 背景：S5 web 直读源只给"条目级"数据（名称+简介+链接），拿不到完整 SKILL.md。
 *       本模块把命中条目的链接解析成可读正文（GitHub 仓库 / 直读站页面），
 *       配合 sg.js 的 fetch-body 命令复用既有清洗管道，让 AI 拿到"方法级"内容
 *       （工作流 / 判别表 / 铁律——这正是实验里 sg 相比通用搜索缺的那块深度）。
 *
 * 零配置 vs 可选只读 token：
 *   - 零配置可用：raw.githubusercontent.com 公网仓库无需鉴权即可读；GitHub API 限流 60 次/时。
 *   - 可选只读 token（SG_GITHUB_TOKEN 环境变量 或 --github-token 参数）：
 *       仅发往 api.github.com / raw.githubusercontent.com，API 限流升至 5000 次/时；
 *       任何输出绝不回显 token 值（token 只进请求头，不出 stdout / stderr / 错误信息）。
 *
 * 解析器：
 *   - GitHub：tree / blob / raw / 仓库根 四形态 + skills.sh 派生 URL（owner/repo/skill）
 *   - 直读站：claudskills.com / skillmd.ai / nanoskill.ai 等页面内 SKILL.md 通用提取
 *
 * 缓存：data/body-cache/<sha1(URL)>.json（fetchedAt + body），TTL 24h；--force 跳过。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpGet } = require('./sources.js');
const { WEB_CACHE_DIR, nameKey } = require('./web-sources.js');

const BODY_CACHE_DIR = path.join(__dirname, '..', 'data', 'body-cache');
const BODY_TTL_MS = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function getText(url, timeoutMs = 20000, headers = {}) {
  return httpGet(url, timeoutMs, { 'User-Agent': UA, ...headers });
}

/* ---------- GitHub URL 解析（tree/blob/raw/根 + skills.sh 派生） ---------- */
function githubInfo(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return null;
    const owner = decodeURIComponent(seg[0]);
    const repo = decodeURIComponent(seg[1]);
    if (seg.length === 2) return { kind: 'root', owner, repo, ref: 'HEAD', path: '' };
    const third = seg[2].toLowerCase();
    if (third === 'tree' || third === 'blob' || third === 'raw') {
      const ref = seg[3] ? decodeURIComponent(seg[3]) : 'HEAD';
      const p = seg.slice(4).map(decodeURIComponent).join('/');
      return { kind: third, owner, repo, ref, path: p };
    }
    // github.com/owner/repo/<branch>/<path...> —— 隐式 tree
    const ref = decodeURIComponent(seg[2]);
    const p = seg.slice(3).map(decodeURIComponent).join('/');
    return { kind: 'tree', owner, repo, ref, path: p };
  }
  if (host === 'raw.githubusercontent.com' || host === 'githubusercontent.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 4) return null;
    return {
      kind: 'raw',
      owner: decodeURIComponent(seg[0]),
      repo: decodeURIComponent(seg[1]),
      ref: decodeURIComponent(seg[2]),
      path: seg.slice(3).map(decodeURIComponent).join('/'),
    };
  }
  if (host === 'skills.sh' || host === 'www.skills.sh') {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 3) return null;
    return { kind: 'skillssh', owner: decodeURIComponent(seg[0]), repo: decodeURIComponent(seg[1]), path: seg.slice(2).map(decodeURIComponent).join('/'), ref: 'HEAD' };
  }
  return null;
}

/* ---------- SKILL.md 判别与页面提取 ---------- */
function looksLikeSkillMd(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 50) return false;
  if (/^---\r?\n/.test(t)) return true;                       // frontmatter 开头
  const head = t.split(/\r?\n/).slice(0, 80).join('\n');
  if (/^name\s*:/m.test(head) && /^description\s*:/m.test(head)) return true;
  // 至少 2 个 markdown 标题（≥##）才算——避免单个 shell 注释 `# xxx` 误判为 SKILL.md
  return (t.match(/^#{1,3}\s+\S+/gm) || []).length >= 2;
}

function extractSkillMd(html) {
  if (!html) return null;
  const t = html.trim();
  // 1. 整页即原始 markdown（frontmatter 开头，或前几行就是 markdown 标题）→ 最高优先级，
  //    避免被页内示例代码块（如 claudskills.com 的进度条围栏）误抢。
  if (/^---\r?\n/.test(t) || /^#{1,3}\s+\S+/m.test(t.split(/\r?\n/).slice(0, 6).join('\n'))) {
    if (looksLikeSkillMd(t)) return t;
  }
  // 2. 围栏代码块（markdown / md / skillmd）
  const fenceRe = /```(?:markdown|md|skillmd|SKILL\.md)?\s*\r?\n([\s\S]*?)\r?\n```/g;
  let m;
  while ((m = fenceRe.exec(html))) {
    if (looksLikeSkillMd(m[1])) return m[1];
  }
  // 3. <pre>/<code> 块（解 HTML 实体）
  const preRe = /<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi;
  while ((m = preRe.exec(html))) {
    const block = m[1].replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
    if (looksLikeSkillMd(block)) return block;
  }
  return null;
}

/* ---------- token 处理（只进请求头，绝不回显） ---------- */
function githubHeaders(opts = {}) {
  if (!opts.githubToken) return {};
  return { Authorization: `Bearer ${opts.githubToken}` };
}
function githubApiHeaders(opts = {}) {
  return { Accept: 'application/vnd.github+json', ...githubHeaders(opts) };
}

/* ---------- GitHub 正文解析 ---------- */
async function githubResolve(info, opts = {}) {
  const rawBase = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.ref}`;
  const candidates = [];
  if (info.kind === 'raw') {
    candidates.push(`${rawBase}/${info.path}`);
  } else if (info.kind === 'blob') {
    candidates.push(info.path.toLowerCase().endsWith('.md')
      ? `${rawBase}/${info.path}`
      : `${rawBase}/${info.path}/SKILL.md`);
  } else {
    // tree / root / skillssh：目录下按惯例放 SKILL.md
    candidates.push(`${rawBase}/${info.path ? info.path + '/' : ''}SKILL.md`);
  }
  for (const url of candidates) {
    try {
      const body = await getText(url, opts.timeout || 20000, githubHeaders(opts));
      if (info.kind === 'raw' || info.kind === 'blob' || looksLikeSkillMd(body)) {
        return { body, url, via: 'raw' };
      }
    } catch { /* 404 → 下一候选 */ }
  }
  // 直接路径未命中且是仓库根 → GitHub API 树发现（可选 token 提升限流 60→5000 次/时）
  if (info.kind === 'root' || (info.kind === 'tree' && !info.path)) {
    return treeDiscover(info, opts);
  }
  return null;
}

async function treeDiscover(info, opts = {}) {
  const apiUrl = `https://api.github.com/repos/${info.owner}/${info.repo}/git/trees/${info.ref}?recursive=1`;
  let json;
  try {
    json = JSON.parse(await getText(apiUrl, opts.timeout || 20000, githubApiHeaders(opts)));
  } catch (e) {
    throw Object.assign(new Error(`GitHub API 树发现失败（限流 60 次/时匿名；可用只读 token 提至 5000 次/时）: ${e.message}`), { code: 'GITHUB_TREE_FAIL' });
  }
  const paths = (json.tree || [])
    .filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path))
    .map((t) => t.path);
  if (!paths.length) return null;
  // 优先与 skill 名匹配，否则取最短路径（仓库根的 SKILL.md 惯例）
  const nameHint = (opts.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (nameHint) {
    const hit = paths.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(nameHint));
    if (hit) paths.sort((a, b) => (a === hit ? -1 : b === hit ? 1 : a.length - b.length));
  } else {
    paths.sort((a, b) => a.length - b.length);
  }
  for (const p of paths.slice(0, 3)) {
    const url = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.ref}/${p}`;
    try {
      const body = await getText(url, opts.timeout || 20000, githubHeaders(opts));
      if (looksLikeSkillMd(body)) return { body, url, via: 'api-tree' };
    } catch { /* next */ }
  }
  return null;
}

/* ---------- 直读站页面解析 ---------- */
async function pageResolve(url, opts = {}) {
  const html = await getText(url, opts.timeout || 20000);
  const body = extractSkillMd(html);
  return body ? { body, url, via: 'page' } : null;
}

/* ---------- 已知直读站按名兜底（GitHub 不可达/解析失败时的第二落点） ----------
 * 直接托管 `<slug>/SKILL.md` 的站点（可达性不依赖 GitHub），本机实测：
 * claudskills.com 返回裸 markdown；skillmd.ai 页内嵌围栏代码块；nanoskill.ai 同理。
 */
const SKILL_HOST_TEMPLATES = [
  (slug) => `https://claudskills.com/skills/${slug}/SKILL.md`,
  (slug) => `https://www.skillmd.ai/skills/${slug}/SKILL.md`,
  (slug) => `https://nanoskill.ai/skills/${slug}/SKILL.md`,
];

async function hostFallbackByName(name, opts = {}) {
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
  if (!slug) return null;
  for (const tmpl of SKILL_HOST_TEMPLATES) {
    try {
      const r = await pageResolve(tmpl(slug), opts);
      if (r) return r;
    } catch { /* 该站 404/不可达 → 下一站 */ }
  }
  return null;
}

/* ---------- 按名称在 web 缓存中定位条目 ---------- */
function findWebEntry(name) {
  if (!name) return null;
  const key = nameKey(name);
  if (!fs.existsSync(WEB_CACHE_DIR)) return null;
  let best = null;
  for (const f of fs.readdirSync(WEB_CACHE_DIR)) {
    if (!f.endsWith('.json')) continue;
    let items;
    try { items = JSON.parse(fs.readFileSync(path.join(WEB_CACHE_DIR, f), 'utf8')).items || []; } catch { continue; }
    for (const it of items) {
      if (!it.name || nameKey(it.name) !== key || !it.url) continue;
      if (!best || (it.description || '').length > (best.description || '').length) best = { ...it };
    }
  }
  return best;
}

/* ---------- 正文缓存（TTL 24h，--force 跳过） ---------- */
function cacheFile(url) {
  return path.join(BODY_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
}
function readBodyCache(url) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8'));
    if (raw && raw.body && Date.now() - raw.fetchedAt < BODY_TTL_MS) {
      return { body: raw.body, url: raw.url || url, via: raw.via || 'cache', cached: true };
    }
  } catch { /* 无缓存或损坏 */ }
  return null;
}
function writeBodyCache(url, data) {
  try {
    fs.mkdirSync(BODY_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(url), JSON.stringify({ ...data, fetchedAt: Date.now() }), 'utf8');
  } catch { /* 缓存失败不致命 */ }
}

/**
 * 抓取正文主入口
 * @param {{name?:string, url:string}|string} entryOrUrl 条目（含 url）或完整 URL
 * @param {{force?:boolean, githubToken?:string, timeout?:number}} opts
 * @returns {Promise<{body:string, url:string, via:string, cached?:boolean}|null>}
 */
async function fetchBody(entryOrUrl, opts = {}) {
  const url = typeof entryOrUrl === 'string' ? entryOrUrl : (entryOrUrl && entryOrUrl.url);
  const name = typeof entryOrUrl === 'string' ? '' : ((entryOrUrl && entryOrUrl.name) || '');
  if (!url) return null;
  if (!opts.force) {
    const c = readBodyCache(url);
    if (c) return c;
  }
  // 第一落点：GitHub 解析（tree/blob/raw/根/skills.sh）——普通网络直接命中
  const info = githubInfo(url);
  let result = null;
  if (info) {
    result = await githubResolve(info, { ...opts, name });
  }
  // 第二落点：直读站页面解析（claudskills / skillmd / nanoskill 等直接托管 SKILL.md）
  if (!result) {
    try { result = await pageResolve(url, opts); } catch { result = null; }
  }
  // 第三落点：按名称在已知直读站兜底（GitHub 不可达 + 条目链接不是直读站时）
  if (!result) {
    result = await hostFallbackByName(name, opts);
  }
  if (result) writeBodyCache(url, result);
  return result;
}

module.exports = {
  fetchBody,
  findWebEntry,
  githubInfo,
  extractSkillMd,
  looksLikeSkillMd,
  hostFallbackByName,
  SKILL_HOST_TEMPLATES,
  BODY_CACHE_DIR,
  BODY_TTL_MS,
};
