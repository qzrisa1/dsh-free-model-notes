#!/usr/bin/env node
/**
 * 指纹矩阵：向 CodeBuddy 端点发送若干 system 变体，观察哪些被判 `11128`。
 *
 * 用法：node scripts/fingerprint-matrix.mjs
 *
 * 说明：
 *  - 从 $DSH_HOME/.credentials.yaml（默认 ~/.dsh）读取已登录账号的 access_token；
 *  - 只打印 HTTP 状态与判定结果，**不打印 token**；
 *  - 每个请求 max_tokens=16、stream=true（该端点不支持非流式）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const CRED_FILE = join(DSH_HOME, '.credentials.yaml');
const URL = 'https://copilot.tencent.com/v2/chat/completions';
const MODEL = process.env.PROBE_MODEL || 'hy3';

/** 从 .credentials.yaml 里取出 BUDDY_ACCOUNT_* 的 JSON（花括号配平，容忍字符串内换行） */
function readCredential() {
  const raw = readFileSync(CRED_FILE, 'utf8');
  const k = raw.indexOf('BUDDY_ACCOUNT_');
  if (k < 0) throw new Error('找不到 BUDDY_ACCOUNT_* 凭据，请先在插件里登录 CodeBuddy 账号');
  const start = raw.indexOf('{', k);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('凭据 JSON 结构不完整');
  return JSON.parse(raw.slice(start, end + 1).replace(/[\r\n]+/g, ' '));
}

async function probe(headers, system) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: '只回答两个字：收到' },
    ],
    max_tokens: 16,
    stream: true,
  };
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (res.status === 200) {
      const reader = res.body.getReader();
      try { await reader.read(); } catch {}
      try { await reader.cancel(); } catch {}
      return 'ALLOW 200';
    }
    const text = await res.text();
    if (text.includes('11128')) return 'BLOCK 11128';
    if (text.includes('11101')) return 'HTTP 11101 (需 stream:true)';
    return 'HTTP ' + res.status;
  } catch (e) {
    return 'ERR ' + String(e?.message ?? e).slice(0, 40);
  } finally {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const cred = readCredential();
const headers = {
  Authorization: 'Bearer ' + cred.access_token,
  'Content-Type': 'application/json',
  'X-Domain': cred.domain || 'copilot.tencent.com',
  'X-Product-Code': 'codebuddy',
  'User-Agent': 'CodeBuddyIDE/1.106.1',
};

console.log('model = ' + MODEL + '   domain = ' + (cred.domain || 'copilot.tencent.com'));

const CASES = [
  ['原句（DSH 身份行）', 'You are an AI agent powered by DeepSeek Harness.'],
  ['原句无句号', 'You are an AI agent powered by DeepSeek Harness'],
  ['全小写', 'you are an ai agent powered by deepseek harness.'],
  ['换动词', 'You are an AI agent running on DeepSeek Harness.'],
  ['换产品名', 'You are an AI agent powered by Acme Harness.'],
  ['只留产品名', 'powered by DeepSeek Harness'],
  ['中文改写', '你是一个由 DeepSeek Harness 驱动的 AI 代理。'],
  ['中性对照', 'You are a helpful assistant.'],
];

for (const [label, text] of CASES) {
  const r = await probe(headers, text);
  console.log('  ' + r.padEnd(12) + ' | ' + label.padEnd(18) + ' :: ' + text);
}
