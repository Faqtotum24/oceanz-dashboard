/**
 * Oceanz Vital — Dashboard Cloudflare Worker
 *
 * Handles button actions from the dashboard:
 *   POST /  { post_id, action: "approve" }
 *   POST /  { post_id, action: "schedule_buffer", text, media_urls: [...], scheduled_at: unixTimestamp }
 *
 * Set these as Worker Environment Variables (not in code):
 *   NOTION_TOKEN      — your Notion integration token
 *   NOTION_DB_ID      — 32fc3481637480608075fe78ee7f3787
 *   GITHUB_TOKEN      — your GitHub PAT (for triggering data.json refresh)
 *   GITHUB_REPO       — e.g. "yourusername/oceanz-dashboard"
 *   BUFFER_API_TOKEN  — your Buffer access token
 *
 * Deploy: https://developers.cloudflare.com/workers/
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400); }

    const { post_id, action } = body;
    if (!post_id || !action) return json({ error: 'Missing post_id or action' }, 400);

    // ── APPROVE ──────────────────────────────────────────────────────────────
    if (action === 'approve') {
      const notionRes = await updateNotionStatus(post_id, 'Approved', env);
      if (!notionRes.ok) {
        const err = await notionRes.text();
        return json({ error: 'Notion update failed', detail: err }, 500);
      }
      return json({ success: true, message: `Post ${post_id} marked as Approved` });
    }

    // ── PROBE BUFFER (diagnostic) ─────────────────────────────────────────────
    if (action === 'probe_buffer') {
      if (!env.BUFFER_API_TOKEN) {
        return json({ error: 'BUFFER_API_TOKEN not configured' }, 500);
      }
      const ORG_ID = '69bc2792c60bc814483d0897';
      // Step A: introspect Channel type to find available fields
      const introspectRes = await fetch('https://api.buffer.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.BUFFER_API_TOKEN}` },
        body: JSON.stringify({ query: '{ __type(name: "Channel") { fields { name type { name kind } } } }' }),
      });
      const introspectData = await introspectRes.json();
      const channelFields = introspectData.data?.__type?.fields?.map(f => f.name) || [];

      // Step B: query channels with known-safe fields
      const safeFields = channelFields.filter(f => ['id','service','name','locked'].includes(f));
      const channelQuery = `{ channels(input: { organizationId: "${ORG_ID}" }) { ${safeFields.join(' ')} } }`;
      const channelsRes = await fetch('https://api.buffer.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.BUFFER_API_TOKEN}` },
        body: JSON.stringify({ query: channelQuery }),
      });
      const channelsData = await channelsRes.json();
      return json({ channel_fields: channelFields, channels: channelsData });
    }
