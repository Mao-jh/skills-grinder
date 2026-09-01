'use strict';
/*
 * sources.js — 数据源发现与解析
 *
 * 数据源优先级（按可信度与完整度）：
 *   S1 官方市场索引   ~/.workbuddy/skills-marketplace/.codebuddy-skill/marketplace.json（227 skills）
 *   S2 插件市场索引×3 ~/.workbuddy/plugins/marketplaces/<mkt>/.codebuddy-plugin/marketplace.json
 *                     workbuddy-builtin（内置市场）/ cb_teams_marketplace（团队市场）/ codebuddy-plugins-official（官方插件市场）
 *   S3 本地缓存镜像×3 ~/.workbuddy/plugins/cache/<mkt>/<plugin>/<version>/skills/<skill>/SKILL.md
 *   S4 远程同步镜像   cli/data/synced/<name>.json（sg sync 拉取，可配置）
 *
 * 热度信号：缓存目录中 .in_use/<pid> 文件数量（真实会话使用痕迹，按插件去重聚合）。
 * 新近信号：版本号内嵌 unix 时间戳（如 0.1.1787966564）+ 文件系统 mtime。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const CLI_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(CLI_ROOT, 'data', 'synced');

const PATHS = {
  officialIndex: path.join(HOME, '.workbuddy', 'skills-marketplace', '.codebuddy-skill', 'marketplace.json'),
  builtinIndex: path.join(HOME, '.workbuddy', 'plugins', 'marketplaces', 'workbuddy-builtin', '.codebuddy-plugin', 'marketplace.json'),
  teamsIndex: path.join(HOME, '.workbuddy', 'plugins', 'marketplaces', 'cb_teams_marketplace', '.codebuddy-plugin', 'marketplace.json'),
  officialPluginsIndex: path.join(HOME, '.workbuddy', 'plugins', 'marketplaces', 'codebuddy-plugins-official', '.codebuddy-plugin', 'marketplace.json'),
  cacheRoot: path.join(HOME, '.workbuddy', 'plugins', 'cache', 'workbuddy-builtin'),
  officialCacheRoot: path.join(HOME, '.workbuddy', 'plugins', 'cache', 'codebuddy-plugins-official'),
  teamsCacheRoot: path.join(HOME, '.workbuddy', 'plugins', 'cache', 'cb_teams_marketplace'),
};

/* ---------- 版本号内嵌时间戳 ---------- */
function versionTimestamp(version) {
  if (!version) return 0;
  const m = version.match(/(\d{9,10})/);
  if (m) {
    const ts = parseInt(m[1], 10);
    if (ts > 1e9 && ts < 2e9) return ts; // 合法 unix 秒
  }
  return 0;
}

/* ---------- 热度：.in_use PID 计数（去重聚合） ---------- */
function usageCount(pluginDir) {
  if (!fs.existsSync(pluginDir)) return 0;
  const pids = new Set();
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.in_use') {
        try {
          for (const f of fs.readdirSync(path.join(d, e.name))) pids.add(f);
        } catch { /* ignore */ }
      } else if (e.isDirectory()) {
        walk(path.join(d, e.name));
      }
    }
  };
  walk(pluginDir);
  return pids.size;
}

/* ---------- 官方市场索引 ---------- */
function loadOfficialIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.officialIndex, 'utf8'));
    return (raw.skills || []).map((s, i) => ({
      name: s.name,
      version: s.version,
      description: s.description_zh || s.description || '',
      examples: s.examples_zh || s.examples || [],
      tags: s.tags_zh || s.tags || [],
      source: s.source || 'official-market',
      indexOrder: i,
      market: '官方市场',
    }));
  } catch (e) {
    return [];
  }
}

/* ---------- 插件型市场索引（顶层 plugins[] 数组，递归 walk 兜底） ---------- */
function loadPluginsIndex(indexPath, market, sourceTag) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return [];
  }
  const out = [];
  const push = (node) => {
    if (!node || typeof node !== 'object' || !node.name) return;
    out.push({
      name: node.name,
      version: node.version || '',
      description: node.description_zh || node.description || '',
      examples: node.examples_zh || node.examples || [],
      tags: node.tags_zh || node.tags || [],
      source: node.source || sourceTag,
      indexOrder: out.length,
      market,
    });
  };
  if (Array.isArray(raw.plugins)) {
    raw.plugins.forEach(push);
    return out;
  }
  // 兜底：递归 walk（兼容非 plugins 顶层结构的旧格式）
  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (node.name && (node.description || node.description_zh)) push(node);
    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(raw, 0);
  return out;
}

function loadBuiltinIndex() {
  return loadPluginsIndex(PATHS.builtinIndex, '内置市场', 'builtin-market');
}

/* ---------- 团队市场索引（cb_teams_marketplace，含 skills 字段） ---------- */
function loadTeamsIndex() {
  return loadPluginsIndex(PATHS.teamsIndex, '团队市场', 'teams-market');
}

/* ---------- 官方插件市场索引（codebuddy-plugins-official） ---------- */
function loadOfficialPluginsIndex() {
  return loadPluginsIndex(PATHS.officialPluginsIndex, '官方插件市场', 'official-plugins');
}

/* ---------- 本地缓存镜像（完整 SKILL.md 可解析） ---------- */
function scanCacheMirrors() {
  const mirrors = [];
  const MARKET_BY_ROOT = {
    [PATHS.cacheRoot]: '内置市场(缓存)',
    [PATHS.officialCacheRoot]: '官方插件市场(缓存)',
    [PATHS.teamsCacheRoot]: '团队市场(缓存)',
  };
  const scanRoot = (root) => {
    if (!fs.existsSync(root)) return;
    let plugins;
    try { plugins = fs.readdirSync(root); } catch { return; }
    for (const plugin of plugins) {
      const pluginDir = path.join(root, plugin);
      if (!fs.statSync(pluginDir).isDirectory()) continue;
      const usage = usageCount(pluginDir);
      let versions = [];
      try { versions = fs.readdirSync(pluginDir); } catch { continue; }
      for (const v of versions) {
        const vDir = path.join(pluginDir, v);
        if (!fs.statSync(vDir).isDirectory()) continue;
        const skillsDir = path.join(vDir, 'skills');
        let skillDirs = [];
        if (fs.existsSync(skillsDir)) {
          try { skillDirs = fs.readdirSync(skillsDir).filter((d) => fs.statSync(path.join(skillsDir, d)).isDirectory()); } catch { skillDirs = []; }
        }
        const mtime = fs.statSync(vDir).mtimeMs;
        const ts = versionTimestamp(v);
        const skillNames = skillDirs.map((d) => d).join(', ') || plugin;
        mirrors.push({
          plugin,
          version: v,
          versionTs: ts,
          mtime,
          usage,
          skillDirs,
          root: vDir,
          skillNames,
          market: MARKET_BY_ROOT[root] || '未知市场(缓存)',
        });
      }
    }
  };
  scanRoot(PATHS.cacheRoot);
  scanRoot(PATHS.officialCacheRoot);
  scanRoot(PATHS.teamsCacheRoot);
  return mirrors;
}

/* ---------- 读取某镜像下某 skill 的 SKILL.md 全文 ---------- */
function readSkillMarkdown(mirror, skillDirName) {
  if (!mirror) return '';
  const p = path.join(mirror.root, 'skills', skillDirName, 'SKILL.md');
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/* ---------- 全部源汇总 ---------- */
function collectSources() {
  return {
    official: loadOfficialIndex(),
    builtin: loadBuiltinIndex(),
    teams: loadTeamsIndex(),
    officialPlugins: loadOfficialPluginsIndex(),
    mirrors: scanCacheMirrors(),
  };
}

/* ---------- 远程同步（爬取外部 skills 网站，可配置） ---------- */
// 进程内 http/https 拉取（node 内置模块，零外部依赖）：
//   为何不用 execFileSync(curl/子进程 node) —— 实测踩坑：execFileSync 同步阻塞主进程事件循环，
//   若本机正有 http server 在监听（如门禁的 sync 端到端测试），server 无法 accept，子进程连接必超时。
//   当前进程直连（async）则事件循环正常，本机与远程皆可拉取。
function httpGet(url, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const doGet = (u, hops) => {
      const req = lib.get(u, { timeout: timeoutMs, headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (hops >= 5) { res.resume(); reject(new Error('重定向过多')); return; }
          res.resume();
          doGet(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

async function syncRemote(url, outName) {
  if (!url) throw new Error('缺少远程源 URL。用法: sg sync --url <marketplace.json 的 URL> [--name 名称]');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const name = (outName || url.split('/').pop().replace(/\.json$/, '') || 'remote').replace(/[^\w-]/g, '_');
  const { execFileSync } = require('child_process');
  const outFile = path.join(DATA_DIR, `${name}.json`);
  // 回环地址（本机测试/本地 server）给 curl 显式 --noproxy：curl 遵循 HTTP_PROXY，
  // 全局代理会把 127.0.0.1 也转发到代理而超时。
  const loopback = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url);
  let body, via = 'node';
  try {
    body = await httpGet(url, 30000);
  } catch (e) {
    via = 'curl';
    try {
      const curlArgs = ['-fsSL', '--max-time', '30'];
      if (loopback) curlArgs.push('--noproxy', '*');
      body = execFileSync('curl', [...curlArgs, url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e2) {
      via = 'powershell';
      try {
        body = execFileSync('powershell', ['-NoProfile', '-Command', `(Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 30).Content`], { encoding: 'utf8' });
      } catch (e3) {
        throw new Error(`远程拉取失败（node/curl/powershell 均失败，via=${via}）: ${e.message}`);
      }
    }
  }
  const data = (() => {
    try { return JSON.parse(body); } catch (e) {
      // 曾直接抛 JSON.parse 原始错误（"Unexpected token ..."），看不出是 URL 内容问题
      throw new Error(`远程返回内容不是合法 JSON（期望 marketplace.json 格式）: ${String(e.message).split('\n')[0]}`);
    }
  })();
  fs.writeFileSync(outFile, body, 'utf8');
  const count = Array.isArray(data.skills) ? data.skills.length : (Array.isArray(data) ? data.length : '未知');
  return { file: outFile, count, name };
}

/* ---------- 加载远程同步的源 ---------- */
function loadSynced() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const skills = raw.skills || (Array.isArray(raw) ? raw : []);
      skills.forEach((s, i) => {
        if (s && s.name) out.push({
          name: s.name,
          version: s.version || '',
          description: s.description_zh || s.description || s.description_en || '',
          examples: s.examples_zh || s.examples || [],
          tags: s.tags_zh || s.tags || [],
          source: `synced:${f.replace(/\.json$/, '')}`,
          indexOrder: i,
          market: `远程同步(${f.replace(/\.json$/, '')})`,
        });
      });
    } catch { /* skip */ }
  }
  return out;
}

module.exports = {
  collectSources,
  loadOfficialIndex,
  loadBuiltinIndex,
  loadTeamsIndex,
  loadOfficialPluginsIndex,
  scanCacheMirrors,
  usageCount,
  versionTimestamp,
  readSkillMarkdown,
  syncRemote,
  loadSynced,
  httpGet,
  PATHS,
  DATA_DIR,
};
