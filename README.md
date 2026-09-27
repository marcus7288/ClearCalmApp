# Clear Calm

Push-to-talk voice and text communication for teams: church security, parking,
ushers, event volunteers, and similar groups. It runs in any modern browser on
phones and laptops.

## How it works

- **Team code.** Everyone who enters the same team code joins the same team.
  A **passcode** (recommended) encrypts the connection handshake. Only people
  with the matching passcode can connect.
- **Channels 1-3 + Emergency.** Voice plays only for people on your channel.
  Text posted to **Emergency** appears for everyone, whatever channel they are
  on.
- **Push to talk.** Hold the big button, or hold the Space bar on a computer.
  A short chirp marks the start and end of each transmission.
- **Invite link.** Open Settings and choose "Copy invite link". The link fills
  in the team code and passcode.
- **Message history** is kept on each device and shared with teammates who
  join later.

Voice and text travel **directly between devices** over encrypted WebRTC.
Public [Nostr](https://nostr.com) relays are used only to introduce devices to
each other (via [Trystero](https://github.com/dmotz/trystero)). There is no
server or database to run, so the app deploys as a static Netlify site.

### Limits to know

- Each device connects to every other device (a mesh). This works well for
  about 10-15 people on one team code. For larger groups, split them across
  several team codes.
- Some strict networks (certain cellular carriers, corporate firewalls) block
  direct connections. If a device can't connect, add a TURN server (for
  example, Cloudflare's free tier) via `turnConfig` in `src/useComm.js`.
- Browsers only allow microphone access over HTTPS. Netlify provides HTTPS
  automatically.

## Develop

```bash
npm install
npm start          # http://localhost:3000
npm run build      # production build in /build
```

## Deploy to Netlify

1. In Netlify, choose **Add new site -> Import an existing project -> GitHub**
   and pick this repository.
2. The build settings come from `netlify.toml`. The build command is
   `npm run build`, the publish directory is `build`, and Node is version 20.
   Accept the defaults and deploy.
