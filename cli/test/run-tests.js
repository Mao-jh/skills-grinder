'use strict';
/*
 * run-tests.js — CLI 集成测试（含安全层专项）
 * 运行: node cli/test/run-tests.js
 */
const { execFileSync } = require('child_process');
const path = require('path');

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
  ['sources 数据源', ['sources']],
  ['search 团队市场', ['search', 'deep-research', '--limit', '3']],
  ['search 官方插件市场', ['search', 'find-skills', '--limit', '3']],
  ['json 输出', ['search', '文档', '--json']],
  ['rank 加权排行', ['search', '文档', '--rank', 'mixed', '--limit', '5']],
  ['rank 自定义权重', ['search', '表格', '--rank', 'mixed', '--weights', 'match=0.5,usage=0.3,recency=0.2', '--limit', '3']],
  ['rank 非法权重报错', ['search', '表格', '--rank', 'mixed', '--weights', 'match=abc'], true],
];

// 边界输入组：把"过去靠人手动敲一遍"的非法/异常输入固化为自动回归
// （下沉自自迭代 #06：曾静默输出 Top0/Top-5 空榜、空参数无提示）
const edgeCases = [
  ['边界:limit 0 报错', ['latest', '--limit', '0'], true],
  ['边界:limit 负数报错', ['latest', '--limit', '-5'], true],
  ['边界:limit 非数字报错', ['hot', '--limit', 'abc'], true],
  ['边界:search 空关键词报错', ['search'], true],
  ['边界:未知命令报错', ['foo-command'], true],
  ['边界:preview 不存在名', ['preview', 'zzz-不存在-skill-zzz'], false, '未找到'],
  ['边界:fetch 不存在名', ['fetch', 'zzz-不存在-skill-zzz'], false, '未找到'],
  ['边界:fetch --skill 不存在', ['fetch', 'sheetagent', '--skill', 'zzz-不存在-skill-zzz'], false, '未找到 skill'],
];
cases.push(...edgeCases);

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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${cases.length} 总用例`);
process.exit(fail ? 1 : 0);
