'use strict';
/*
 * run-tests.js — CLI 集成测试（含安全层专项 + 契约层）
 * 运行: node cli/test/run-tests.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SG = path.join(__dirname, '..', 'sg.js');
const NODE = process.execPath;

function run(args, expectFail = false, expectOut = null) {
  try {
    const out = execFileSync(NODE, [SG, ...args], { encoding: 'utf8' });
    return { ok: !expectFail && (expectOut === null || out.includes(expectOut)), out };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    return { ok: expectFail || (expectOut !== null && out.includes(expectOut)), out };
  }
}

const cases = [
  ['selftest 安全层自检', ['selftest']],
  ['latest 最新上架', ['latest', '--limit', '5']],
  ['hot 最热', ['hot', '--limit', '5']],
  ['search 搜索', ['search', '表格']],
  ['preview 预览(索引)', ['preview', '腾讯文档']],
  ['preview 预览(镜像)', ['preview', 'sheetagent']],
  ['fetch 正文(镜像,清洗)', ['fetch', 'sheetagent']],
  ['fetch-body help', ['fetch-body', '--help'], false, 'USAGE:'],
  ['fetch-body schema', ['schema', 'fetch-body'], false, '"name": "fetch-body"'],
  ['sources 数据源', ['sources']],
  ['search 团队市场', ['search', 'deep-research', '--limit', '3']],
  ['search 官方插件市场', ['search', 'find-skills', '--limit', '3']],
  ['json 输出', ['search', '文档', '--json']],
  ['rank 加权排行', ['search', '文档', '--rank', 'mixed', '--limit', '5']],
  ['rank 自定义权重', ['search', '表格', '--rank', 'mixed', '--weights', 'match=0.5,usage=0.3,recency=0.2', '--limit', '3']],
  ['rank 非法权重报错', ['search', '表格', '--rank', 'mixed', '--weights', 'match=abc'], true],
  // 契约层（v0.9.0）
  ['help 顶层索引', ['help'], false, '命令索引'],
  ['help 子命令 --help', ['search', '--help'], false, 'NEXT:'],
  ['help help <命令>', ['help', 'fetch'], false, 'USAGE:'],
  ['schema 全部(JSON)', ['schema'], false, '"type": "schema"'],
  ['schema 单命令(JSON)', ['schema', 'search'], false, '"name": "search"'],
  ['schema 单命令(text)', ['schema', 'fetch', '--text'], false, '## fetch'],
];

// 边界输入组：把"过去靠人手动敲一遍"的非法/异常输入固化为自动回归
// （下沉自自迭代 #06：曾静默输出 Top0/Top-5 空榜、空参数无提示）
const edgeCases = [
  ['边界:limit 0 报错', ['latest', '--limit', '0'], true],
  ['边界:limit 负数报错', ['latest', '--limit', '-5'], true],
  ['边界:limit 非数字报错', ['hot', '--limit', 'abc'], true],
  ['边界:search 空关键词报错', ['search'], true],
  ['边界:未知命令报错', ['foo-command'], true],
  ['边界:preview 不存在名', ['preview', 'zzz-不存在-skill-zzz'], true],
  ['边界:fetch 不存在名', ['fetch', 'zzz-不存在-skill-zzz'], true],
  ['边界:fetch --skill 不存在', ['fetch', 'sheetagent', '--skill', 'zzz-不存在-skill-zzz'], true],
  ['边界:查询含控制字符拒绝', ['search', 'a\tb'], true],
  ['边界:查询超长拒绝', ['search', 'x'.repeat(105)], true],
  ['边界:--output-path 裸 flag 报错', ['fetch', 'sheetagent', '--output-path'], true],
  ['边界:fetch-body 空参数报错', ['fetch-body'], true],
  ['边界:fetch-body 未知名报错', ['fetch-body', 'zzz-不存在-skill-zzz'], true],
  ['边界:fetch-body --github-token 裸 flag 报错', ['fetch-body', 'zzz-skill', '--github-token'], true],
  ['边界:schema 未知命令报错', ['schema', 'zzz-no-such'], true],
];

// 多关键词（| 分隔，分别检索后合并 v0.11.0）：共享切词逻辑，本地 search 离线可测
cases.push(
  ['search 多关键词|合并', ['search', '文档|表格', '--limit', '20'], false, '腾讯文档'],
  ['search 多关键词带空格', ['search', '  表格  |  文档  ', '--limit', '20'], false, '腾讯文档'],
  ['search 多关键词 JSON matched', ['search', '文档|表格', '--limit', '20', '--json'], false, 'matched'],
  ['边界:search 仅|空词拒绝', ['search', '|'], true],
  ['边界:web 仅|空词拒绝', ['web', '||'], true],
);

// web 多关键词（仅在有深拉缓存时跑，无缓存=全新环境自动跳过，不依赖网络）
try {
  const skillshCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'web-cache', 'skillssh.json'), 'utf8'));
  if (skillshCache.mode === 'deep' && Date.now() - skillshCache.fetchedAt < 6 * 3600 * 1000) {
    cases.push(
      ['web 多关键词|合并(缓存)', ['web', 'transcript|youtube', '--limit', '12'], false, 'youtube-transcript'],
      ['web 多关键词命中标注(缓存)', ['web', 'transcript|youtube', '--limit', '12'], false, '命中: transcript | youtube'],
    );
  }
} catch { /* 无 web 深拉缓存，跳过 web 多关键词用例 */ }
cases.push(...edgeCases);

// fetch --output-path 落盘冒烟（临时文件，跑完清理）
const OUT_TMP = path.join(os.tmpdir(), `sg-run-${Date.now()}.md`);
cases.push(['fetch --output-path 落盘', ['fetch', 'sheetagent', '--output-path', OUT_TMP]]);

let pass = 0, fail = 0;
for (const [name, args, expectFail] of cases) {
  const r = run(args, expectFail);
  if (r.ok) {
    console.log(`PASS  ${name}`);
    pass++;
  } else {
    console.log(`FAIL  ${name}`);
    console.log(r.out.split('\n').slice(0, 5).join('\n'));
    fail++;
  }
}

try { fs.unlinkSync(OUT_TMP); } catch { /* noop */ }

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${cases.length} 总用例`);
process.exit(fail ? 1 : 0);
