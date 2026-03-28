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
      const res = await fetch('https://api.buffer.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${env.BUFFER_API_TOKEN}`,
        },
        body: JSON.stringify({ query: '{ channels { id service username } }' }),
      });
      const data = await res.text();
      return json({ http_status: res.status, body: data });
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

      // Step 1: find the Instagram channel ID via Buffer GraphQL API
      const channelsRes = await fetch('https://api.buffer.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${env.BUFFER_API_TOKEN}`,
        },
        body: JSON.stringify({ query: '{ channels { id service username } }' }),
      });
      if (!channelsRes.ok) {
        const errText = await channelsRes.text();
        return json({ error: 'Failed to fetch Buffer channels', http_status: channelsRes.status, detail: errText }, 500);
      }
      const channelsData = await channelsRes.json();
      if (channelsData.errors) {
        return json({ error: 'Buffer channels query error', detail: channelsData.errors }, 500);
      }
      const channels = channelsData.data?.channels || [];
      const igChannel = channels.find(c => c.service && c.service.toLowerCase().includes('instagram'));
      if (!igChannel) {
        return json({ error: 'No Instagram channel found in Buffer account', channels: channels.map(c => ({ service: c.service, username: c.username })) }, 400);
      }

      // Step 2: schedule the post via GraphQL createPost mutation
      const dueAt = scheduled_at
        ? new Date(scheduled_at * 1000).toISOString()
        : new Date(Date.now() + 3600000).toISOString(); // default: 1 hour from now

      const assets = media_urls.map(url => ({ url }));

      const mutation = `
        mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            ... on PostActionSuccess { post { id scheduledAt } }
            ... on MutationError { message type }
          }
        }
      `;
      const variables = {
        input: {
          channelId:      igChannel.id,
          text,
          schedulingType: 'scheduled',
          mode:           'customSchedule',
          dueAt,
          assets,
        },
      };

      const postRes = await fetch('https://api.buffer.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${env.BUFFER_API_TOKEN}`,
        },
        body: JSON.stringify({ query: mutation, variables }),
      });
      const postData = await postRes.json();

      if (!postRes.ok || postData.errors) {
        return json({ error: 'Buffer createPost failed', http_status: postRes.status, detail: postData }, 500);
      }

      const result = postData.data?.createPost;
      if (result?.message) {
        // MutationError
        return json({ error: 'Buffer createPost mutation error', detail: result }, 500);
      }

      // Step 3: update Notion status to Scheduled
      if (post_id) {
        await updateNotionStatus(post_id, 'Scheduled', env);
      }

      return json({
        success: true,
        buffer_post_id:  result?.post?.id,
        instagram_channel: igChannel.username,
        scheduled_at:    result?.post?.scheduledAt || dueAt,
        message:         `Post scheduled to @${igChannel.username} via Buffer`,
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
