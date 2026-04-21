/* global chrome */

const BRIDGE = 'http://127.0.0.1:9230';
const TARGET_HOST = 'we.51job.com';
const TARGET_PATH = '/pc/search';
const BUTTON_ID = '__we51job_capture_btn__';
const BUTTON_NEXT_ID = '__we51job_capture_next_btn__';
const BUTTON_BATCH_ID = '__we51job_capture_50_btn__';
const OFFSCREEN_URL = 'offscreen.html';

function chromeCall(namespace, method, ...args) {
  return new Promise((resolve, reject) => {
    namespace[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function queryTabs(queryInfo) {
  return chromeCall(chrome.tabs, 'query', queryInfo);
}

async function getTab(tabId) {
  return chromeCall(chrome.tabs, 'get', tabId);
}

async function updateTab(tabId, updateProperties) {
  return chromeCall(chrome.tabs, 'update', tabId, updateProperties);
}

async function createOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return;

  const offscreenPath = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenPath]
    });
    if (contexts.length > 0) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_SCRAPING'],
      justification: 'Poll the local Page Control Bridge while the MV3 service worker is idle.'
    });
  } catch (error) {
    if (!String(error?.message || '').includes('Only a single offscreen')) {
      throw error;
    }
  }
}

function evaluateSource(source) {
  try {
    return (0, eval)(source);
  } catch (error) {
    if (error instanceof SyntaxError && /^\s*return\b/.test(String(source || ''))) {
      return Function(source)();
    }
    throw error;
  }
}

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
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function evalInTab(tabId, code) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: evaluateSource,
    args: [code],
    world: 'ISOLATED'
  });
  return Array.isArray(result) && result[0] ? result[0].result : undefined;
}

async function executeFunctionInTab(tabId, func, ...args) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: 'ISOLATED'
  });
  return Array.isArray(result) && result[0] ? result[0].result : undefined;
}

function getDomStableState() {
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
}

function collectRenderedHtml() {
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
  const html = docType ? (docType + '\n' + htmlBody) : htmlBody;

  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    elementCount: document.getElementsByTagName('*').length,
    html
  };
}

function collectPageContent() {
  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

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
      jobName,
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
      state = await executeFunctionInTab(tabId, getDomStableState);
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
      return await getTab(context.tabId);
    } catch (_) {
      // fall back to active tab
    }
  }
  return getActiveTab();
}

function isTargetPage(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === TARGET_HOST &&
      parsed.pathname === TARGET_PATH;
  } catch (_) {
    return false;
  }
}

async function injectCaptureButton(tabId) {
  const script = `(() => {
    const captureId = ${JSON.stringify(BUTTON_ID)};
    const nextId = ${JSON.stringify(BUTTON_NEXT_ID)};
    const batchId = ${JSON.stringify(BUTTON_BATCH_ID)};
    const runtime = (typeof browser !== 'undefined' && browser.runtime)
      || (typeof chrome !== 'undefined' && chrome.runtime)
      || null;
    if (!runtime || !runtime.sendMessage) return;

    const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
      runtime.sendMessage(message, (response) => {
        const chromeError = (typeof chrome !== 'undefined' && chrome.runtime)
          ? chrome.runtime.lastError
          : null;
        if (chromeError) reject(new Error(chromeError.message));
        else resolve(response);
      });
    });

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();

    const applyBaseStyle = (button, left, background, borderColor) => {
      button.type = 'button';
      button.style.position = 'fixed';
      button.style.top = '12px';
      button.style.left = left;
      button.style.zIndex = '2147483647';
      button.style.padding = '8px 14px';
      button.style.border = '1px solid ' + borderColor;
      button.style.borderRadius = '6px';
      button.style.background = background;
      button.style.color = '#fff';
      button.style.fontSize = '14px';
      button.style.lineHeight = '1';
      button.style.cursor = 'pointer';
      button.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
      button.style.fontFamily = 'sans-serif';
    };

    const setBusy = (button, text) => {
      button.dataset.loading = '1';
      button.disabled = true;
      button.style.opacity = '0.85';
      if (text) button.textContent = text;
    };

    const resetLater = (button, originalText, delay = 1500) => {
      window.setTimeout(() => {
        button.dataset.loading = '0';
        button.disabled = false;
        button.style.opacity = '1';
        button.textContent = originalText;
      }, delay);
    };

    const setLocked = (button, locked) => {
      if (!button) return;
      if (locked) {
        button.dataset.batchLocked = '1';
        button.disabled = true;
        button.style.opacity = button.dataset.loading === '1' ? '0.85' : '0.6';
        return;
      }
      button.dataset.batchLocked = '0';
      if (button.dataset.loading === '1') {
        button.disabled = true;
        button.style.opacity = '0.85';
      } else {
        button.disabled = false;
        button.style.opacity = '1';
      }
    };

    const runCapture = async (button) => {
      try {
        const result = await sendRuntimeMessage({ cmd: 'capture' });
        if (result && result.ok) {
          const count = typeof result.total === 'number' ? result.total : '-';
          const added = typeof result.inserted === 'number' ? result.inserted : '-';
          button.textContent = '已抓取 +' + added + ' / 总' + count;
          return { ok: true, result };
        } else {
          button.textContent = '抓取失败';
          console.error('[Page Control Bridge] capture failed', result);
          return { ok: false, error: result?.error || 'capture failed' };
        }
      } catch (error) {
        button.textContent = '抓取异常';
        console.error('[Page Control Bridge] capture error', error);
        return { ok: false, error: error?.message || 'capture error' };
      }
    };

    const getActivePageNo = () => {
      const candidates = [
        '.el-pager li.active',
        '.el-pagination .el-pager li.active',
        '.pagination .active',
        '[aria-current="page"]',
        '[class*="pager"] .active'
      ];
      for (const selector of candidates) {
        const node = document.querySelector(selector);
        if (!node) continue;
        const text = cleanText(node.textContent);
        const matched = text.match(/\\d+/);
        if (matched) return Number.parseInt(matched[0], 10);
      }
      return null;
    };

    const getListMarker = () => {
      const node = document.querySelector('.joblist-item [sensorsdata], .joblist-item .jname');
      if (!node) return '';
      return cleanText(node.getAttribute?.('sensorsdata') || node.textContent || '');
    };

    const getPageNumberNodes = () => {
      return Array.from(document.querySelectorAll(
        '.el-pager li, .el-pagination .el-pager li, .pagination li, [class*="pager"] li, [class*="pagination"] li'
      ));
    };

    const isDisabled = (node) => {
      const className = String(node.className || '').toLowerCase();
      return node.getAttribute('disabled') !== null ||
        node.getAttribute('aria-disabled') === 'true' ||
        className.includes('disabled');
    };

    const findPageNodeByNumber = (targetPageNo) => {
      const nodes = getPageNumberNodes();
      for (const node of nodes) {
        if (!node || isDisabled(node)) continue;
        const text = cleanText(node.textContent);
        const matched = text.match(/^\\d+$/);
        if (!matched) continue;
        if (Number.parseInt(matched[0], 10) === targetPageNo) {
          return node;
        }
      }
      return null;
    };

    const findNextButton = () => {
      const selector = '.btn-next, .el-pagination .btn-next, [class*="next"]';
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (!node || isDisabled(node)) continue;
        const className = String(node.className || '').toLowerCase();
        const text = cleanText(node.textContent || node.getAttribute('aria-label') || '');
        if (text.includes('下一页') || className.includes('next')) return node;
      }
      return null;
    };

    const clickNode = (node) => {
      if (!node) return false;
      node.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      }));
      if (typeof node.click === 'function') node.click();
      return true;
    };

    const waitForNextPageLoaded = async (oldPageNo, timeoutMs = 12000) => {
      const started = Date.now();
      const markerBefore = getListMarker();
      while (Date.now() - started < timeoutMs) {
        await sleep(240);
        const currentPageNo = getActivePageNo();
        if (Number.isFinite(oldPageNo) && Number.isFinite(currentPageNo) && currentPageNo > oldPageNo) {
          return true;
        }
        const markerNow = getListMarker();
        if (markerBefore && markerNow && markerNow !== markerBefore) {
          return true;
        }
      }
      return false;
    };

    const gotoNextPage = async () => {
      const currentPageNo = getActivePageNo();
      const targetPageNo = Number.isFinite(currentPageNo) ? (currentPageNo + 1) : 2;

      let targetNode = findPageNodeByNumber(targetPageNo);
      if (!targetNode && !Number.isFinite(currentPageNo)) {
        targetNode = findPageNodeByNumber(2);
      }
      if (!targetNode) {
        targetNode = findNextButton();
      }
      if (!targetNode) return { ok: false, error: 'next page node not found' };

      clickNode(targetNode);
      const changed = await waitForNextPageLoaded(currentPageNo);
      if (!changed) {
        await sleep(1800);
      }
      return { ok: true };
    };

    const performNextPageCapture = async (button) => {
      button.textContent = '翻页中...';
      const moved = await gotoNextPage();
      if (!moved.ok) {
        button.textContent = '未找到下一页';
        console.warn('[Page Control Bridge] next page not found', moved.error);
        return { ok: false, stage: 'next', error: moved.error || 'next page not found' };
      }

      button.textContent = '抓取中...';
      const captured = await runCapture(button);
      if (!captured.ok) {
        return { ok: false, stage: 'capture', error: captured.error || 'capture failed' };
      }
      return { ok: true, result: captured.result };
    };

    const oldCapture = document.getElementById(captureId);
    const oldNext = document.getElementById(nextId);
    const oldBatch = document.getElementById(batchId);
    if (oldCapture) oldCapture.remove();
    if (oldNext) oldNext.remove();
    if (oldBatch) oldBatch.remove();

    const captureBtn = document.createElement('button');
    captureBtn.id = captureId;
    captureBtn.textContent = '抓取';
    captureBtn.title = '抓取当前页职位';
    applyBaseStyle(captureBtn, '12px', '#1677ff', '#1677ff');

    const nextBtn = document.createElement('button');
    nextBtn.id = nextId;
    nextBtn.textContent = '抓取下一页';
    nextBtn.title = '翻到下一页后抓取';
    applyBaseStyle(nextBtn, '92px', '#2f9e44', '#2f9e44');

    const batchBtn = document.createElement('button');
    batchBtn.id = batchId;
    batchBtn.textContent = '抓取前50页';
    batchBtn.title = '持续抓取下一页，最多50页';
    applyBaseStyle(batchBtn, '206px', '#c77d00', '#c77d00');

    captureBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (captureBtn.dataset.loading === '1' || captureBtn.dataset.batchLocked === '1') return;
      const originalText = captureBtn.textContent;
      setBusy(captureBtn, '抓取中...');
      await runCapture(captureBtn);
      resetLater(captureBtn, originalText);
    });

    nextBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (nextBtn.dataset.loading === '1' || nextBtn.dataset.batchLocked === '1') return;
      const originalText = nextBtn.textContent;
      setBusy(nextBtn, '翻页中...');
      const step = await performNextPageCapture(nextBtn);
      resetLater(nextBtn, originalText, step.ok ? 1500 : 2200);
    });

    batchBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (batchBtn.dataset.loading === '1' || batchBtn.dataset.batchLocked === '1') return;

      const originalText = batchBtn.textContent;
      setBusy(batchBtn, '准备中...');
      setLocked(captureBtn, true);
      setLocked(nextBtn, true);

      let successCount = 0;
      let stopReason = 'no-next';
      try {
        // 先抓取当前页，再继续抓后续页。
        batchBtn.textContent = '第1/50页';
        const firstCapture = await runCapture(batchBtn);
        if (!firstCapture.ok) {
          stopReason = 'capture-failed';
        } else {
          successCount = 1;
        }

        for (let i = 1; i < 50 && stopReason !== 'capture-failed'; i += 1) {
          batchBtn.textContent = '第' + (i + 1) + '/50页';
          const step = await performNextPageCapture(batchBtn);
          if (!step.ok) {
            stopReason = step.stage === 'next' ? 'no-next' : 'capture-failed';
            break;
          }
          successCount += 1;
          stopReason = successCount >= 50 ? 'limit' : stopReason;
          await sleep(280);
        }

        if (successCount >= 50) {
          batchBtn.textContent = '已抓取50页';
        } else if (stopReason === 'no-next') {
          batchBtn.textContent = '已抓取' + successCount + '页(到最后一页)';
        } else {
          batchBtn.textContent = '抓取中断(' + successCount + ')';
        }
      } finally {
        batchBtn.dataset.loading = '0';
        batchBtn.disabled = false;
        batchBtn.style.opacity = '1';
        setLocked(captureBtn, false);
        setLocked(nextBtn, false);
        window.setTimeout(() => {
          if (batchBtn.dataset.loading !== '1') {
            batchBtn.textContent = originalText;
          }
        }, 1700);
      }
    });

    document.body.appendChild(captureBtn);
    document.body.appendChild(nextBtn);
    document.body.appendChild(batchBtn);
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
    const data = await executeFunctionInTab(tab.id, collectPageContent);
    return { ok: true, ...data };
  }

  if (cmd === 'html') {
    const waitMeta = await waitForDomStable(tab.id, params);
    const data = await executeFunctionInTab(tab.id, collectRenderedHtml);

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
    await updateTab(tab.id, { url: params.url });
    return { ok: true };
  }

  if (cmd === 'click') {
    if (!params.selector) return { ok: false, error: 'missing selector' };
    const r = await executeFunctionInTab(tab.id, (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { ok: false, error: 'not found' };
      el.click();
      return { ok: true };
    }, params.selector);
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
        jobName: item?.jobName || item?.jobTitle || '',
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

  if (cmd === 'storeCompanies') {
    const companies = Array.isArray(params.companies) ? params.companies : [];
    let bridgeResult;
    try {
      const resp = await fetch(`${BRIDGE}/companies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePage: params.sourcePage || tab.url || '',
          companies
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
      captured: companies.length,
      inserted: bridgeResult.inserted,
      updated: bridgeResult.updated,
      skipped: bridgeResult.skipped,
      total: bridgeResult.total
    };
  }

  if (cmd === 'getCompanies') {
    try {
      const resp = await fetch(`${BRIDGE}/companies`);
      const bridgeResult = await resp.json();
      if (!resp.ok || !bridgeResult?.ok) {
        return { ok: false, error: bridgeResult?.error || `bridge status ${resp.status}` };
      }
      return {
        ok: true,
        count: bridgeResult.count || 0,
        companies: Array.isArray(bridgeResult.companies) ? bridgeResult.companies : []
      };
    } catch (e) {
      return { ok: false, error: `bridge unreachable: ${e.message}` };
    }
  }

  return { ok: false, error: `unknown cmd: ${cmd}` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      await createOffscreenDocument();
      if (msg?.cmd === '__ensure_buttons__') {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number') {
          return { ok: false, error: 'missing sender tab' };
        }
        await syncButtonForTab(tabId, sender.tab.url);
        return { ok: true };
      }
      if (msg?.cmd === '__bridge_task__') {
        const task = msg.task || {};
        return await api(task.cmd, task.params || {});
      }
      return await api(msg?.cmd, msg?.params || {}, { tabId: sender?.tab?.id });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  })().then(sendResponse);
  return true;
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'page-control-bridge-keepalive') {
    createOffscreenDocument().catch(() => {});
    pollBridge();
  }
});

chrome.alarms.create('page-control-bridge-keepalive', { periodInMinutes: 0.5 });
createOffscreenDocument().catch(() => {});
setInterval(pollBridge, 700);
console.log('[Page Control Bridge] service worker ready', BRIDGE);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    await syncButtonForTab(tabId, tab?.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await getTab(tabId);
    await syncButtonForTab(tabId, tab?.url);
  } catch (_) {
    // tab may no longer exist
  }
});

async function injectButtonsForExistingTabs() {
  try {
    const tabs = await queryTabs({});
    for (const tab of tabs) {
      await syncButtonForTab(tab.id, tab.url);
    }
  } catch (_) {
    // ignore startup race conditions
  }
}

injectButtonsForExistingTabs();
