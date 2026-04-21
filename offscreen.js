/* global chrome */

const BRIDGE = 'http://127.0.0.1:9230';
const POLL_MS = 700;

async function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function pollBridge() {
  try {
    const response = await fetch(`${BRIDGE}/next-command`);
    if (!response.ok) return;

    const task = await response.json();
    if (!task || !task.id) return;

    let result;
    try {
      result = await sendRuntimeMessage({ cmd: '__bridge_task__', task });
    } catch (error) {
      result = { ok: false, error: error.message };
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

setInterval(pollBridge, POLL_MS);
pollBridge();
