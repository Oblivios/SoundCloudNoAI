// A minimal Chrome/Edge driver over the DevTools protocol (Node >= 22), with a
// throwaway profile. Shared by tools/e2e.mjs and tools/screenshots.mjs.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageSocket(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('browser did not start');
}

/**
 * @returns {Promise<{ send: Function, evaluate: Function, on: Function, close: Function }>}
 *   send(method, params) calls a DevTools method; evaluate(js) returns the
 *   expression's value; on(fn) receives protocol events.
 */
export async function launch({ browserPath, headed = false, args = [] } = {}) {
  const exe = browserPath || CANDIDATES.find(existsSync);
  if (!exe) throw new Error('no Chrome/Edge found, pass --browser <path>');
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'scnoai-'));
  const proc = spawn(exe, [
    ...(headed ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...args,
    'about:blank',
  ]);

  const ws = new WebSocket(await pageSocket(port));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };

  async function close() {
    ws.close();
    proc.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold files on Windows */
    }
  }

  await send('Page.enable');
  await send('Runtime.enable');
  return { send, evaluate, on: (fn) => listeners.push(fn), close };
}
