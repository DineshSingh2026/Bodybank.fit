'use strict';

/**
 * notifyAgent(eventName, data)
 *
 * Fire-and-forget outbound telemetry for the external monitoring agent.
 * - Never throws
 * - Never blocks request/response paths
 * - When AGENT_WEBHOOK_URL is unset, this is a complete no-op (no network calls)
 */
function notifyAgent(eventName, data) {
  try {
    const url = process.env.AGENT_WEBHOOK_URL;
    if (!url) return; // strict no-op

    const payload = {
      event: eventName,
      occurred_at: new Date().toISOString(),
      data: data && typeof data === 'object' ? data : {}
    };

    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.AGENT_WEBHOOK_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') return;

    // Non-blocking: do not await; swallow and log errors.
    fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })
      .then((res) => {
        // Drain body best-effort; avoid unhandled promise rejections.
        try {
          if (res && typeof res.text === 'function') res.text().catch(() => {});
        } catch (_) {}
      })
      .catch((err) => {
        console.error('[agentWebhook] POST failed:', err && err.message ? err.message : err);
      });
  } catch (err) {
    console.error('[agentWebhook] notifyAgent error:', err && err.message ? err.message : err);
  }
}

module.exports = { notifyAgent };

