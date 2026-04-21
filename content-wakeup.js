/* global chrome */

const BUTTON_ID = '__we51job_capture_btn__';
const BUTTON_NEXT_ID = '__we51job_capture_next_btn__';
const BUTTON_BATCH_ID = '__we51job_capture_50_btn__';

function requestButtonInjection() {
  chrome.runtime.sendMessage({ cmd: '__ensure_buttons__' }, () => {
    // Ignore errors while the service worker is starting or the tab is closing.
    void chrome.runtime.lastError;
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function applyBaseStyle(button, left, background, borderColor) {
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
}

function setBusy(button, text) {
  button.dataset.loading = '1';
  button.disabled = true;
  button.style.opacity = '0.85';
  if (text) button.textContent = text;
}

function resetLater(button, originalText, delay = 1500) {
  window.setTimeout(() => {
    button.dataset.loading = '0';
    button.disabled = false;
    button.style.opacity = '1';
    button.textContent = originalText;
  }, delay);
}

function isDisabled(node) {
  const className = String(node.className || '').toLowerCase();
  return node.getAttribute('disabled') !== null ||
    node.getAttribute('aria-disabled') === 'true' ||
    className.includes('disabled');
}

function getActivePageNo() {
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
    const matched = cleanText(node.textContent).match(/\d+/);
    if (matched) return Number.parseInt(matched[0], 10);
  }
  return null;
}

function findPageNodeByNumber(targetPageNo) {
  const nodes = Array.from(document.querySelectorAll(
    '.el-pager li, .el-pagination .el-pager li, .pagination li, [class*="pager"] li, [class*="pagination"] li'
  ));
  for (const node of nodes) {
    if (!node || isDisabled(node)) continue;
    const matched = cleanText(node.textContent).match(/^\d+$/);
    if (matched && Number.parseInt(matched[0], 10) === targetPageNo) return node;
  }
  return null;
}

function findNextButton() {
  const nodes = Array.from(document.querySelectorAll('.btn-next, .el-pagination .btn-next, [class*="next"]'));
  for (const node of nodes) {
    if (!node || isDisabled(node)) continue;
    const className = String(node.className || '').toLowerCase();
    const text = cleanText(node.textContent || node.getAttribute('aria-label') || '');
    if (text.includes('下一页') || className.includes('next')) return node;
  }
  return null;
}

function getListMarker() {
  const node = document.querySelector('.joblist-item [sensorsdata], .joblist-item .jname');
  if (!node) return '';
  return cleanText(node.getAttribute?.('sensorsdata') || node.textContent || '');
}

function clickNode(node) {
  if (!node) return false;
  node.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window
  }));
  if (typeof node.click === 'function') node.click();
  return true;
}

async function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForNextPageLoaded(oldPageNo, timeoutMs = 12000) {
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
}

async function gotoNextPage() {
  const currentPageNo = getActivePageNo();
  const targetPageNo = Number.isFinite(currentPageNo) ? currentPageNo + 1 : 2;
  const targetNode = findPageNodeByNumber(targetPageNo) || findNextButton();
  if (!targetNode) return { ok: false, error: 'next page node not found' };
  clickNode(targetNode);
  const changed = await waitForNextPageLoaded(currentPageNo);
  if (!changed) await sleep(1800);
  return { ok: true };
}

async function runCapture(button) {
  try {
    const result = await sendRuntimeMessage({ cmd: 'capture' });
    if (result && result.ok) {
      const count = typeof result.total === 'number' ? result.total : '-';
      const added = typeof result.inserted === 'number' ? result.inserted : '-';
      button.textContent = '已抓取 +' + added + ' / 总' + count;
      return { ok: true, result };
    }
    button.textContent = '抓取失败';
    return { ok: false, error: result?.error || 'capture failed' };
  } catch (error) {
    button.textContent = '抓取异常';
    return { ok: false, error: error?.message || 'capture error' };
  }
}

async function performNextPageCapture(button) {
  button.textContent = '翻页中...';
  const moved = await gotoNextPage();
  if (!moved.ok) {
    button.textContent = '未找到下一页';
    return { ok: false, stage: 'next', error: moved.error || 'next page not found' };
  }
  button.textContent = '抓取中...';
  const captured = await runCapture(button);
  if (!captured.ok) return { ok: false, stage: 'capture', error: captured.error || 'capture failed' };
  return { ok: true, result: captured.result };
}

function ensureButtons() {
  if (!document.body) return;

  document.getElementById(BUTTON_ID)?.remove();
  document.getElementById(BUTTON_NEXT_ID)?.remove();
  document.getElementById(BUTTON_BATCH_ID)?.remove();

  const captureBtn = document.createElement('button');
  captureBtn.id = BUTTON_ID;
  captureBtn.textContent = '抓取';
  captureBtn.title = '抓取当前页职位';
  applyBaseStyle(captureBtn, '12px', '#1677ff', '#1677ff');

  const nextBtn = document.createElement('button');
  nextBtn.id = BUTTON_NEXT_ID;
  nextBtn.textContent = '抓取下一页';
  nextBtn.title = '翻到下一页后抓取';
  applyBaseStyle(nextBtn, '92px', '#2f9e44', '#2f9e44');

  const batchBtn = document.createElement('button');
  batchBtn.id = BUTTON_BATCH_ID;
  batchBtn.textContent = '抓取前50页';
  batchBtn.title = '持续抓取下一页，最多50页';
  applyBaseStyle(batchBtn, '206px', '#c77d00', '#c77d00');

  captureBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (captureBtn.dataset.loading === '1') return;
    const originalText = captureBtn.textContent;
    setBusy(captureBtn, '抓取中...');
    await runCapture(captureBtn);
    resetLater(captureBtn, originalText);
  });

  nextBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (nextBtn.dataset.loading === '1') return;
    const originalText = nextBtn.textContent;
    setBusy(nextBtn, '翻页中...');
    const step = await performNextPageCapture(nextBtn);
    resetLater(nextBtn, originalText, step.ok ? 1500 : 2200);
  });

  batchBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (batchBtn.dataset.loading === '1') return;
    const originalText = batchBtn.textContent;
    setBusy(batchBtn, '准备中...');

    let successCount = 0;
    let stopReason = 'no-next';
    try {
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
        await sleep(280);
      }

      if (successCount >= 50) batchBtn.textContent = '已抓取50页';
      else if (stopReason === 'no-next') batchBtn.textContent = '已抓取' + successCount + '页(到最后一页)';
      else batchBtn.textContent = '抓取中断(' + successCount + ')';
    } finally {
      resetLater(batchBtn, originalText, 1700);
    }
  });

  document.body.appendChild(captureBtn);
  document.body.appendChild(nextBtn);
  document.body.appendChild(batchBtn);
}

ensureButtons();
requestButtonInjection();
setTimeout(requestButtonInjection, 1200);
setTimeout(ensureButtons, 1200);
