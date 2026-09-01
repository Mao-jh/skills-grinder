'use strict';
/*
 * coverage.js — 功能覆盖盲区清单（单一事实源）
 *
 * 背景：release-check 的门禁断言永远落后于真实功能面（"门禁全绿但漏测"已翻车 4 次）。
 *       盲区清单必须"可见、可执行、单一事实源"：
 *         - release-check 末尾输出 WARN 提示（谁没被断言覆盖）
 *         - sg report 输出同一份清单（迭代素材包里带上，下轮补断言有依据）
 *       补了断言就把对应条目从这里删除——删除即宣告覆盖。
 *
 * 条目格式：[功能面, 为什么没有断言]
 *
 * 当前状态：空 — 全部功能面已有断言（v0.7.0 起 sync 远程拉取改用本地 http server
 * 端到端断言，最后一条盲区消灭）。若未来新增功能面暂无断言，回到这里登记。
 */
const COVERAGE_GAPS = [];

module.exports = { COVERAGE_GAPS };
