'use strict';
/*
 * errors.js — 统一错误契约（agent-first CLI 最佳实践）
 *
 * 退出码是 agent 最便宜的二分信号；错误信息必须能直接驱动下一步，
 * 而不是只有 "failed" 让模型盲试（反模式 #4）。
 *
 * 退出码契约（固定映射，sg schema 中公开，改动须同步 schema 与 README）：
 *   0   成功
 *   1   内部/未知错误
 *   2   用法或输入错误（修订参数，不盲目重试）
 *   4   可重试瞬时错误（网络/外部服务，遵守退避重试）
 *   5   资源不存在（检查名称/ID 后重试）
 *   10  危险操作未确认（预留，当前无此类命令）
 */

const EXIT = { OK: 0, INTERNAL: 1, USAGE: 2, TRANSIENT: 4, NOT_FOUND: 5, CONFIRM: 10 };
const CODE_NAME = {
  0: 'ok',
  1: 'internal',
  2: 'usage',
  4: 'transient',
  5: 'not_found',
  10: 'confirmation_required',
};

/**
 * 统一失败出口：
 *   - json 模式：结构化错误封套输出到 stdout（agent 可直接解析），非零退出码；
 *   - 人类模式：可读错误 + next_actions 输出到 stderr（stdout 保持可消费），非零退出码。
 * 错误对象至少含 code / retryable / message，可选 context 与 next_actions ——
 * 对齐"错误应说明状态、原因、下一步"的三段式约定。
 *
 * @param {number} code  退出码（EXIT.*）
 * @param {string} message 人类可读的错误原因
 * @param {object} [opts]
 * @param {boolean} [opts.json] 结构化错误封套（stdout）
 * @param {boolean} [opts.retryable] 是否可凭原请求重试
 * @param {Array<{command:string, description:string}>} [opts.next_actions] 可直接复制执行的下一步
 * @param {object} [opts.context] 错误上下文（如非法输入值）
 * @param {object} [opts.meta] 附加 meta（如命令版本）
 */
function fail(code, message, opts = {}) {
  const { json = false, retryable = false, next_actions = [], context, meta } = opts;
  const codeName = CODE_NAME[code] || 'internal';
  const error = { code: codeName, retryable, message };
  if (context) error.context = context;
  if (next_actions.length) error.next_actions = next_actions;
  if (json) {
    console.log(JSON.stringify({
      schemaVersion: '1',
      type: 'error',
      ok: false,
      data: null,
      errors: [error],
      ...(meta ? { meta } : {}),
    }, null, 2));
  } else {
    console.error(`[错误:${codeName}] ${message}`);
    for (const na of next_actions) console.error(`  下一步: ${na.command}  — ${na.description}`);
  }
  process.exit(code);
}

module.exports = { EXIT, CODE_NAME, fail };
