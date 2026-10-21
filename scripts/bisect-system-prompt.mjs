#!/usr/bin/env node
/**
 * 二分定位：在你实际发出的 system 提示词里，找出触发上游 `11128` 的段落。
 *
 * 用法：
 *   node scripts/bisect-system-prompt.mjs                 # 从 DSH 会话日志取最近的 system
 *   node scripts/bisect-system-prompt.mjs prompt.txt      # 或指定一个文本文件
 *
 * 原理：
 *   把 system 按空行切段，对"前 N 段"做二分探测；
 *   HTTP 200 = 放行，400 + 11128 = 被拦，据此缩小范围。
 *
 * 说明：只读本机凭据与会话日志，不打印 token；请求均为 max_tokens=16 / stream=true。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const URL = 'https://copilot.tencent.com/v2/chat/completions';
const MODEL = process.env.PROBE_MODEL || 'hy3';

/** fzstd：DSH 的会话日志是 zstd 压缩。没装就用 npm i fzstd。 */
function loadZstd() {
  try {
    const require = createRequire(import.meta.url);
    return require('fzstd');
  } catch {
    return null;
  }
}

function readCredential() {
  const raw = readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8');
  const k = raw.indexOf('BUDDY_ACCOUNT_');
  if (k < 0) throw new Error('找不到 BUDDY_ACCOUNT_* 凭据');
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
  return JSON.parse(raw.slice(start, end + 1).replace(/[\r\n]+/g, ' '));
}

/** 取最近一个会话里最长的 system 消息 */
function latestSystemFromSessions() {
  const zstd = loadZstd();
  if (!zstd) throw new Error('缺少 fzstd：请先 npm i fzstd');
  const root = join(DSH_HOME, 'sessions');
  const files = [];
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws);
    if (!statSync(wsDir).isDirectory()) continue;
    for (const s of readdirSync(wsDir)) {
      const f = join(wsDir, s, 'session.v4.jsonl.zstd');
      try { files.push({ f, m: statSync(f).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.m - a.m);
  for (const { f } of files.slice(0, 5)) {
    const recs = Buffer.from(zstd.decompress(readFileSync(f))).toString('utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((r) => r.type === 'system/message');
    for (let i = recs.length - 1; i >= 0; i--) {
      const c = recs[i].data?.message?.content;
      const t = Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : String(c || '');
      if (t.length > 500) return { text: t, file: f };
    }
  }
  throw new Error('会话里没找到足够长的 system 消息');
}

const cred = readCredential();
const headers = {
  Authorization: 'Bearer ' + cred.access_token,
  'Content-Type': 'application/json',
  'X-Domain': cred.domain || 'copilot.tencent.com',
  'X-Product-Code': 'codebuddy',
  'User-Agent': 'CodeBuddyIDE/1.106.1',
};

let calls = 0;
async function probe(systemText) {
  calls++;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: '只回答两个字：收到' },
    ],
    max_tokens: 16,
    stream: true,
  };
  try {
    const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    if (res.status === 200) {
      const r = res.body.getReader();
      try { await r.read(); } catch {}
      try { await r.cancel(); } catch {}
      return 'ok';
    }
    const t = await res.text();
    if (t.includes('11128')) return 'blocked';
    return 'other:' + res.status;
  } catch (e) {
    return 'other:' + String(e?.message ?? e).slice(0, 40);
  } finally {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const argFile = process.argv[2];
let SYS, source;
if (argFile) {
  SYS = readFileSync(argFile, 'utf8');
  source = argFile;
} else {
  const r = latestSystemFromSessions();
  SYS = r.text;
  source = r.file;
}
console.log('system 来源: ' + source);
console.log('system 长度: ' + SYS.length);

const blocks = SYS.split(/\n{2,}/).filter((b) => b.trim());
console.log('段落数: ' + blocks.length);

const baseline = await probe(SYS);
console.log('基线（整段）: ' + baseline);
if (baseline !== 'blocked') {
  console.log('整段未被拦，无需二分。');
  process.exit(0);
}

let lo = 0, hi = blocks.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const text = blocks.slice(0, mid).join('\n\n');
  if (!text.trim()) { lo = mid + 1; continue; }
  const r = await probe(text);
  console.log('  前 ' + mid + ' 段 (' + text.length + ' 字符) -> ' + r);
  if (r === 'blocked') hi = mid; else lo = mid + 1;
}
const idx = Math.max(0, lo - 1);
console.log('\n=== 触发段落 #' + idx + ' ===');
console.log((blocks[idx] || '').slice(0, 1500));
console.log('\n总请求数: ' + calls);
