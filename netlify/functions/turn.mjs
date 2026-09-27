// Hands out short-lived TURN relay credentials so phones that can't connect
// directly (common on cellular data, or two phones behind the same router)
// can still reach each other. The long-lived provider secret stays here on
// Netlify and never ships in the web page.
//
// Configure ONE provider in Netlify -> Site configuration -> Environment
// variables, then redeploy:
//   Cloudflare (free tier): CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
//   Metered.ca:             METERED_DOMAIN (e.g. yourapp.metered.live),
//                           METERED_API_KEY
//
// With neither set, it returns an empty list and the app connects directly
// only.

const TTL_SECONDS = 12 * 60 * 60;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

// Only hand credentials to pages served from this site, so other websites
// can't borrow your relay bandwidth.
const sameSite = (req) => {
  if (req.headers.get("sec-fetch-site") === "same-origin") return true;
  const host = new URL(req.url).host;
  const from = req.headers.get("origin") || req.headers.get("referer");
  if (!from) return false;
  try {
    return new URL(from).host === host;
  } catch {
    return false;
  }
};

const asList = (servers) => (Array.isArray(servers) ? servers : [servers]);

const fromCloudflare = async (keyId, token) => {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const data = await res.json();
  return asList(data.iceServers);
};

const fromMetered = async (domain, apiKey) => {
  const res = await fetch(
    `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) throw new Error(`Metered TURN responded ${res.status}`);
  return asList(await res.json());
};

export default async (req) => {
  if (!sameSite(req)) return json({ error: "forbidden" }, 403);

  const env = process.env;
  try {
    if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
      const iceServers = await fromCloudflare(
        env.CLOUDFLARE_TURN_KEY_ID,
        env.CLOUDFLARE_TURN_API_TOKEN,
      );
      return json({ provider: "Cloudflare", iceServers });
    }
    if (env.METERED_DOMAIN && env.METERED_API_KEY) {
      const iceServers = await fromMetered(
        env.METERED_DOMAIN,
        env.METERED_API_KEY,
      );
      return json({ provider: "Metered", iceServers });
    }
    return json({ provider: null, iceServers: [] });
  } catch (err) {
    console.error(err);
    return json({ provider: null, iceServers: [], error: "turn-unavailable" });
  }
};
