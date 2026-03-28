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

    // ── SCHEDULE TO BUFFER ───────────────────────────────────────────────────
    if (action === 'schedule_buffer') {
      const { text, media_urls, scheduled_at } = body;
      if (!text || !media_urls || !Array.isArray(media_urls) || media_urls.length === 0) {
        return json({ error: 'Missing text or media_urls' }, 400);
      }
      if (!env.BUFFER_API_TOKEN) {
        return json({ error: 'BUFFER_API_TOKEN not configured in Worker environment' }, 500);
      }

      // Step 1: find the Instagram profile ID
      const profilesRes = await fetch(
        `https://api.bufferapp.com/1/profiles.json?access_token=${env.BUFFER_API_TOKEN}`
      );
      if (!profilesRes.ok) {
        const errText = await profilesRes.text();
        return json({ error: 'Failed to fetch Buffer profiles', http_status: profilesRes.status, detail: errText }, 500);
      }
      const profiles = await profilesRes.json();
      const igProfile = profiles.find(p => p.service && p.service.toLowerCase().includes('instagram'));
      if (!igProfile) {
        return json({ error: 'No Instagram profile found in Buffer account', profiles: profiles.map(p => p.service) }, 400);
      }

      // Step 2: build the Buffer update payload
      const params = new URLSearchParams();
      params.append('access_token', env.BUFFER_API_TOKEN);
      params.append('profile_ids[]', igProfile.id);
      params.append('text', text);
      if (scheduled_at) params.append('scheduled_at', String(scheduled_at));
      // First image as main photo, all images as carousel thumbnails
      params.append('media[photo]', media_urls[0]);
      media_urls.forEach((url, i) => params.append(`media[thumbnails][${i}]`, url));

      // Step 3: create the Buffer update
      const bufferRes = await fetch('https://api.bufferapp.com/1/updates/create.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const bufferData = await bufferRes.json();

      if (!bufferRes.ok || bufferData.error) {
        return json({ error: 'Buffer scheduling failed', detail: bufferData }, 500);
      }

      // Step 4: update Notion status to Scheduled
      if (post_id) {
        await updateNotionStatus(post_id, 'Scheduled', env);
      }

      return json({
        success: true,
        buffer_update_id: bufferData.updates?.[0]?.id || bufferData.id,
        instagram_profile: igProfile.service_username,
        scheduled_at: bufferData.updates?.[0]?.scheduled_at || scheduled_at,
        message: `Post scheduled to @${igProfile.service_username} via Buffer`,
      });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  }
};

// ── Notion helpers ────────────────────────────────────────────────────────────
async function updateNotionStatus(pageId, status, env) {
  return fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization':  `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: JSON.stringify({
      properties: {
        Status: { status: { name: status } }
      }
    })
  });
}

// ── Response helper ───────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}
