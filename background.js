/* global browser */

const BRIDGE = 'http://127.0.0.1:9230';

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function evalInTab(tabId, code) {
  const result = await browser.tabs.executeScript(tabId, { code });
  return Array.isArray(result) ? result[0] : result;
}

async function api(cmd, params = {}) {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'no active tab' };

  if (cmd === 'status') {
    return { ok: true, tabId: tab.id, title: tab.title, url: tab.url };
  }

  if (cmd === 'content') {
    const data = await evalInTab(
      tab.id,
      `(() => ({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 20000),
        html: (document.documentElement?.outerHTML || '').slice(0, 100000)
      }))();`
    );
    return { ok: true, ...data };
  }

  if (cmd === 'open') {
    if (!params.url) return { ok: false, error: 'missing url' };
    await browser.tabs.update(tab.id, { url: params.url });
    return { ok: true };
  }

  if (cmd === 'click') {
    if (!params.selector) return { ok: false, error: 'missing selector' };
    const r = await evalInTab(
      tab.id,
      `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return {ok:false,error:'not found'};
        el.click();
        return {ok:true};
      })();`
    );
    return r;
  }

  if (cmd === 'eval') {
    if (!params.script) return { ok: false, error: 'missing script' };
    const r = await evalInTab(tab.id, params.script);
    return { ok: true, result: r };
  }

  return { ok: false, error: `unknown cmd: ${cmd}` };
}

browser.runtime.onMessage.addListener(async (msg) => {
  try {
    return await api(msg?.cmd, msg?.params || {});
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function pollBridge() {
  try {
    const r = await fetch(`${BRIDGE}/next-command`);
    if (!r.ok) return;
    const task = await r.json();
    if (!task || !task.id) return;

    let result;
    try {
      result = await api(task.cmd, task.params || {});
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    await fetch(`${BRIDGE}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, result })
    });
  } catch (_) {
    // bridge not up; ignore
  }
}

setInterval(pollBridge, 700);
console.log('[Page Control Bridge] polling', BRIDGE);
