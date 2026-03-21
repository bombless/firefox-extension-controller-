/* global browser */

const BRIDGE = 'http://127.0.0.1:9230';
const TARGET_PREFIX = 'https://we.51job.com/pc/search?';
const BUTTON_ID = '__we51job_capture_btn__';

const CAPTURE_SCRIPT = `(() => {
  const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

  const salaryPatterns = [
    /\\d+(?:\\.\\d+)?\\s*[-~]\\s*\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元)\\s*\\/?\\s*(?:月|年|天)?/,
    /\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元)\\s*\\/?\\s*(?:月|年|天)?/,
    /面议/
  ];

  const isSalaryText = (text) => {
    const s = cleanText(text);
    return salaryPatterns.some((pattern) => pattern.test(s));
  };

  const pickSalary = (container) => {
    if (!container) return '';
    const text = cleanText(container.innerText || container.textContent || '');
    for (const pattern of salaryPatterns) {
      const match = text.match(pattern);
      if (match) return cleanText(match[0]);
    }
    return '';
  };

  const pickCompanyFromClass = (container) => {
    if (!container) return '';
    const classKeywords = ['company', 'corp', 'firm', 'enterprise', 'employer'];
    const nodes = Array.from(container.querySelectorAll('[class]'));
    for (const node of nodes) {
      const className = String(node.className || '').toLowerCase();
      if (!className) continue;
      if (!classKeywords.some((keyword) => className.includes(keyword))) continue;
      const text = cleanText(node.innerText || node.textContent || '');
      if (text && text.length <= 60) return text;
    }
    return '';
  };

  const pickCompany = (container, jobName, salaryRange) => {
    if (!container) return '';

    const byClass = pickCompanyFromClass(container);
    if (byClass && byClass !== jobName && byClass !== salaryRange) return byClass;

    const companyHint = /(公司|集团|科技|有限|股份|企业|银行|研究院|工作室|事务所)/;
    const lines = String(container.innerText || container.textContent || '')
      .split(/\\n+/)
      .map(cleanText)
      .filter(Boolean);

    for (const line of lines) {
      if (!line || line === jobName || line === salaryRange) continue;
      if (line.length > 60) continue;
      if (isSalaryText(line)) continue;
      if (companyHint.test(line)) return line;
    }

    for (const line of lines) {
      if (!line || line === jobName || line === salaryRange) continue;
      if (line.length > 40) continue;
      if (isSalaryText(line)) continue;
      return line;
    }

    return '';
  };

  const normalizeUrl = (rawHref) => {
    if (!rawHref) return '';
    try {
      const url = new URL(rawHref, location.href);
      if (!/^https?:$/.test(url.protocol)) return '';
      url.search = '';
      url.hash = '';
      return url.origin + url.pathname;
    } catch (_) {
      return '';
    }
  };

  const looksLikeJobLink = (rawHref, normalizedUrl) => {
    const text = String(rawHref || '').toLowerCase();
    const normalized = String(normalizedUrl || '').toLowerCase();
    return /job|position|post|detail/.test(text) ||
      /job|position|post|detail/.test(normalized) ||
      /jobid|positionid|postid/.test(text);
  };

  const links = Array.from(document.querySelectorAll('a[href]'));
  const recordMap = new Map();

  for (const linkEl of links) {
    const rawHref = linkEl.getAttribute('href') || '';
    const url = normalizeUrl(rawHref);
    if (!url) continue;
    const strictJobLink = looksLikeJobLink(rawHref, url);

    let jobName = cleanText(
      linkEl.getAttribute('title') ||
      linkEl.getAttribute('aria-label') ||
      linkEl.innerText ||
      linkEl.textContent
    );

    if (!jobName) {
      const nameNode = linkEl.querySelector('h1,h2,h3,h4,[class*="title"],[class*="name"]');
      jobName = cleanText(nameNode ? (nameNode.innerText || nameNode.textContent) : '');
    }

    if (!jobName || jobName.length < 2) continue;

    const container = linkEl.closest('article,li,tr,section,div');
    const salaryRange = pickSalary(container);
    if (!strictJobLink && !salaryRange) continue;
    const companyName = pickCompany(container, jobName, salaryRange);

    const nextRecord = {
      companyName,
      jobName,
      salaryRange,
      url
    };

    const previous = recordMap.get(url);
    if (!previous) {
      recordMap.set(url, nextRecord);
      continue;
    }

    const previousScore = (previous.companyName ? 1 : 0) + (previous.salaryRange ? 1 : 0) + (previous.jobName ? 1 : 0);
    const nextScore = (nextRecord.companyName ? 1 : 0) + (nextRecord.salaryRange ? 1 : 0) + (nextRecord.jobName ? 1 : 0);
    if (nextScore > previousScore) {
      recordMap.set(url, nextRecord);
    }
  }

  return {
    pageUrl: location.href,
    title: document.title,
    records: Array.from(recordMap.values())
  };
})();`;

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function evalInTab(tabId, code) {
  const result = await browser.tabs.executeScript(tabId, { code });
  return Array.isArray(result) ? result[0] : result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntClamped(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function waitForDomStable(tabId, params = {}) {
  const waitMs = parseIntClamped(params.waitMs, 1500, 0, 8000);
  const stableMs = parseIntClamped(params.stableMs, 1200, 200, 5000);
  const timeoutMs = parseIntClamped(params.timeoutMs, 10000, 1000, 12000);
  const pollMs = 180;
  const startedAt = Date.now();
  let timedOut = false;

  while (true) {
    let state;
    try {
      state = await evalInTab(
        tabId,
        `(() => {
          const key = '__pcBridgeDomState__';
          const root = document.documentElement || document.body;
          const now = Date.now();

          if (!window[key]) {
            window[key] = { lastMutationAt: now };
          }

          const st = window[key];
          if (!st.observer && root) {
            const observer = new MutationObserver(() => {
              st.lastMutationAt = Date.now();
            });
            observer.observe(root, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true
            });
            st.observer = observer;
            st.lastMutationAt = now;
          }

          return {
            readyState: document.readyState,
            now,
            lastMutationAt: st.lastMutationAt || now
          };
        })();`
      );
    } catch (_) {
      state = null;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      timedOut = true;
      break;
    }

    if (state) {
      const stableFor = state.now - state.lastMutationAt;
      const ready = state.readyState === 'complete';
      if (elapsed >= waitMs && ready && stableFor >= stableMs) {
        break;
      }
    }

    await sleep(pollMs);
  }

  return {
    waitMs,
    stableMs,
    timeoutMs,
    waitedMs: Date.now() - startedAt,
    timedOut
  };
}

async function getTargetTab(context = {}) {
  if (context && typeof context.tabId === 'number') {
    try {
      return await browser.tabs.get(context.tabId);
    } catch (_) {
      // fall back to active tab
    }
  }
  return getActiveTab();
}

function isTargetPage(url) {
  return typeof url === 'string' && url.startsWith(TARGET_PREFIX);
}

async function injectCaptureButton(tabId) {
  const script = `(() => {
    const id = ${JSON.stringify(BUTTON_ID)};
    if (document.getElementById(id)) return;

    const btn = document.createElement('button');
    btn.id = id;
    btn.textContent = '抓取';
    btn.type = 'button';
    btn.title = '抓取功能开发中';
    btn.style.position = 'fixed';
    btn.style.top = '12px';
    btn.style.left = '12px';
    btn.style.zIndex = '2147483647';
    btn.style.padding = '8px 14px';
    btn.style.border = '1px solid #1677ff';
    btn.style.borderRadius = '6px';
    btn.style.background = '#1677ff';
    btn.style.color = '#fff';
    btn.style.fontSize = '14px';
    btn.style.lineHeight = '1';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
    btn.style.fontFamily = 'sans-serif';

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const runtime = (typeof browser !== 'undefined' && browser.runtime)
        || (typeof chrome !== 'undefined' && chrome.runtime)
        || null;
      if (!runtime || !runtime.sendMessage) return;
      if (btn.dataset.loading === '1') return;

      const originalText = btn.textContent;
      btn.dataset.loading = '1';
      btn.disabled = true;
      btn.style.opacity = '0.85';
      btn.textContent = '抓取中...';

      try {
        const result = await runtime.sendMessage({ cmd: 'capture' });
        if (result && result.ok) {
          const count = typeof result.total === 'number' ? result.total : '-';
          const added = typeof result.inserted === 'number' ? result.inserted : '-';
          btn.textContent = '已抓取 +' + added + ' / 总' + count;
        } else {
          btn.textContent = '抓取失败';
          console.error('[Page Control Bridge] capture failed', result);
        }
      } catch (error) {
        btn.textContent = '抓取异常';
        console.error('[Page Control Bridge] capture error', error);
      } finally {
        window.setTimeout(() => {
          btn.dataset.loading = '0';
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.textContent = originalText;
        }, 1500);
      }
    });

    document.body.appendChild(btn);
  })();`;

  try {
    await evalInTab(tabId, script);
  } catch (_) {
    // Ignore transient execution errors (for example during navigation).
  }
}

async function syncButtonForTab(tabId, url) {
  if (!isTargetPage(url)) return;
  await injectCaptureButton(tabId);
}

async function api(cmd, params = {}, context = {}) {
  const tab = await getTargetTab(context);
  if (!tab) return { ok: false, error: 'no active tab' };

  if (cmd === 'status') {
    return { ok: true, tabId: tab.id, title: tab.title, url: tab.url };
  }

  if (cmd === 'content') {
    const data = await evalInTab(
      tab.id,
      `(() => {
        const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

        const decodeHtmlEntities = (raw) => {
          if (!raw || typeof raw !== 'string') return '';
          const text = raw;
          if (!/[&][a-z#0-9]+;/i.test(text)) return text;
          const el = document.createElement('textarea');
          el.innerHTML = text;
          return el.value;
        };

        const parseSensorsData = (rawValue) => {
          if (!rawValue) return null;
          const candidates = [
            String(rawValue),
            decodeHtmlEntities(String(rawValue))
          ];

          for (const candidate of candidates) {
            try {
              const parsed = JSON.parse(candidate);
              if (parsed && typeof parsed === 'object') return parsed;
            } catch (_) {
              // try next form
            }
          }
          return null;
        };

        const jobItems = Array.from(document.querySelectorAll('.joblist-item'));
        const records = [];
        const seen = new Set();

        for (const item of jobItems) {
          const sensorNode = item.querySelector('[sensorsdata]');
          const parsed = parseSensorsData(sensorNode ? sensorNode.getAttribute('sensorsdata') : '');
          const jobId = cleanText(parsed?.jobId || '');
          if (!jobId) continue;

          const companyNode = item.querySelector('.joblist-item-right .cname');
          const areaNode = item.querySelector('.joblist-item-jobinfo .area');
          const salaryNode = item.querySelector('.joblist-item-jobinfo .sal');
          const jobNameNode = item.querySelector('.joblist-item-left .jname');

          const companyName = cleanText(
            (companyNode && (companyNode.getAttribute('title') || companyNode.textContent)) ||
            ''
          );
          const area = cleanText(parsed?.jobArea || (areaNode ? areaNode.textContent : ''));
          const salaryRange = cleanText(parsed?.jobSalary || (salaryNode ? salaryNode.textContent : ''));
          const jobName = cleanText(parsed?.jobTitle || (jobNameNode ? jobNameNode.textContent : ''));
          const jobUrl = 'https://jobs.51job.com/guangzhou-thq/' + jobId + '.html';

          if (seen.has(jobUrl)) continue;
          seen.add(jobUrl);

          records.push({
            url: jobUrl,
            companyName,
            area,
            salaryRange
          });
        }

        if (records.length > 0) {
          return {
            mode: 'joblist',
            title: document.title,
            url: location.href,
            count: records.length,
            records
          };
        }

        return {
          mode: 'fallback',
          title: document.title,
          url: location.href,
          text: (document.body?.innerText || '').slice(0, 20000),
          html: (document.documentElement?.outerHTML || '').slice(0, 100000)
        };
      })();`
    );
    return { ok: true, ...data };
  }

  if (cmd === 'html') {
    const waitMeta = await waitForDomStable(tab.id, params);

    const data = await evalInTab(
      tab.id,
      `(() => {
        const docType = document.doctype
          ? '<!DOCTYPE ' + document.doctype.name
            + (document.doctype.publicId ? ' PUBLIC "' + document.doctype.publicId + '"' : '')
            + (!document.doctype.publicId && document.doctype.systemId ? ' SYSTEM' : '')
            + (document.doctype.systemId ? ' "' + document.doctype.systemId + '"' : '')
            + '>'
          : '';

        const root = document.documentElement;
        const clone = root ? root.cloneNode(true) : null;

        if (root && clone) {
          const srcFields = root.querySelectorAll('input,textarea,select,option');
          const dstFields = clone.querySelectorAll('input,textarea,select,option');
          const len = Math.min(srcFields.length, dstFields.length);

          for (let i = 0; i < len; i += 1) {
            const src = srcFields[i];
            const dst = dstFields[i];
            const tag = src.tagName;

            if (tag === 'INPUT') {
              if (src.type !== 'password') {
                dst.setAttribute('value', src.value || '');
              }
              if (src.checked) dst.setAttribute('checked', '');
              else dst.removeAttribute('checked');
            } else if (tag === 'TEXTAREA') {
              dst.textContent = src.value || '';
            } else if (tag === 'SELECT') {
              const srcOptions = src.options || [];
              const dstOptions = dst.options || [];
              const olen = Math.min(srcOptions.length, dstOptions.length);
              for (let j = 0; j < olen; j += 1) {
                if (srcOptions[j].selected) dstOptions[j].setAttribute('selected', '');
                else dstOptions[j].removeAttribute('selected');
              }
            } else if (tag === 'OPTION') {
              if (src.selected) dst.setAttribute('selected', '');
              else dst.removeAttribute('selected');
            }
          }
        }

        const serializer = new XMLSerializer();
        const htmlBody = clone ? serializer.serializeToString(clone) : '';
        const html = docType ? (docType + '\\n' + htmlBody) : htmlBody;

        return {
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          elementCount: document.getElementsByTagName('*').length,
          html
        };
      })();`
    );

    return {
      ok: true,
      mode: 'rendered-dom',
      ...waitMeta,
      ...data
    };
  }

  if (cmd === 'dom') {
    const waitMeta = await waitForDomStable(tab.id, params);
    const maxNodes = parseIntClamped(params.maxNodes, 3000, 100, 15000);
    const maxDepth = parseIntClamped(params.maxDepth, 20, 1, 80);
    const maxTextLen = parseIntClamped(params.maxTextLen, 200, 20, 2000);

    const data = await evalInTab(
      tab.id,
      `(() => {
        const maxNodes = ${JSON.stringify(maxNodes)};
        const maxDepth = ${JSON.stringify(maxDepth)};
        const maxTextLen = ${JSON.stringify(maxTextLen)};
        let nodeCount = 0;
        let truncated = false;

        const cleanText = (value) =>
          String(value || '').replace(/\\s+/g, ' ').trim().slice(0, maxTextLen);

        const serializeNode = (node, depth) => {
          if (!node || depth > maxDepth) return null;
          if (nodeCount >= maxNodes) {
            truncated = true;
            return null;
          }

          nodeCount += 1;

          if (node.nodeType === Node.TEXT_NODE) {
            const text = cleanText(node.nodeValue);
            if (!text) return null;
            return { type: 'text', text };
          }

          if (node.nodeType !== Node.ELEMENT_NODE) return null;

          const out = {
            type: 'element',
            tag: node.tagName.toLowerCase()
          };

          if (node.id) out.id = node.id;
          if (typeof node.className === 'string' && node.className.trim()) {
            out.class = node.className.trim();
          }

          const attrs = {};
          let attrCount = 0;
          for (const attr of Array.from(node.attributes || [])) {
            if (attrCount >= 20) break;
            if (attr.name === 'id' || attr.name === 'class') continue;
            attrs[attr.name] = String(attr.value || '').slice(0, 300);
            attrCount += 1;
          }
          if (attrCount > 0) out.attrs = attrs;

          const children = [];
          for (const child of Array.from(node.childNodes || [])) {
            const next = serializeNode(child, depth + 1);
            if (next) children.push(next);
            if (nodeCount >= maxNodes) {
              truncated = true;
              break;
            }
          }
          if (children.length > 0) out.children = children;

          return out;
        };

        const dom = serializeNode(document.documentElement, 0);
        return {
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          elementCount: document.getElementsByTagName('*').length,
          serializedNodes: nodeCount,
          truncated,
          dom
        };
      })();`
    );

    return {
      ok: true,
      mode: 'dom-tree',
      maxNodes,
      maxDepth,
      maxTextLen,
      ...waitMeta,
      ...data
    };
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

  if (cmd === 'capture') {
    const contentResult = await api('content', {}, context);
    let records = Array.isArray(contentResult?.records) ? contentResult.records : [];
    let sourcePage = contentResult?.url || tab.url || '';
    let sourceTitle = contentResult?.title || tab.title || '';

    if (records.length === 0) {
      // Fallback for pages that do not match the /content structured extractor.
      const data = await evalInTab(tab.id, CAPTURE_SCRIPT);
      if (!data || !Array.isArray(data.records)) {
        return { ok: false, error: 'capture parse failed' };
      }
      records = data.records.map((item) => ({
        url: item?.url || '',
        companyName: item?.companyName || '',
        area: item?.area || '',
        salaryRange: item?.salaryRange || ''
      }));
      sourcePage = data.pageUrl || sourcePage;
      sourceTitle = data.title || sourceTitle;
    }

    let bridgeResult;
    try {
      const resp = await fetch(`${BRIDGE}/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePage,
          title: sourceTitle,
          records
        })
      });
      bridgeResult = await resp.json();
      if (!resp.ok || !bridgeResult?.ok) {
        return { ok: false, error: bridgeResult?.error || `bridge status ${resp.status}` };
      }
    } catch (e) {
      return { ok: false, error: `bridge unreachable: ${e.message}` };
    }

    return {
      ok: true,
      captured: records.length,
      inserted: bridgeResult.inserted,
      updated: bridgeResult.updated,
      skipped: bridgeResult.skipped,
      total: bridgeResult.total
    };
  }

  return { ok: false, error: `unknown cmd: ${cmd}` };
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  try {
    return await api(msg?.cmd, msg?.params || {}, { tabId: sender?.tab?.id });
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

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    await syncButtonForTab(tabId, tab?.url);
  }
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    await syncButtonForTab(tabId, tab?.url);
  } catch (_) {
    // tab may no longer exist
  }
});

async function injectButtonsForExistingTabs() {
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      await syncButtonForTab(tab.id, tab.url);
    }
  } catch (_) {
    // ignore startup race conditions
  }
}

injectButtonsForExistingTabs();
