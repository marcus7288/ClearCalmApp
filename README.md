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
  direct connections. If a device can't connect, add a TURN server (see below).
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
   `npm run build` (with the commit number passed in), the publish directory is `build`, and Node is version 20.
   Accept the defaults and deploy.

The build number at the bottom of the join screen and in Settings (for example
`v2 · a1b2c3d`) matches the Git commit Netlify deployed. If you don't see it,
Netlify is still serving the old version.

### Optional: TURN relay for cellular and strict networks

1. Create a free TURN account (for example Metered.ca "Open Relay" or
   Cloudflare Realtime TURN) and copy its URLs, username and credential.
2. In Netlify, open **Site configuration -> Environment variables** and add:
   - `REACT_APP_TURN_URLS`, for example
     `turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp`
   - `REACT_APP_TURN_USERNAME`
   - `REACT_APP_TURN_CREDENTIAL`
3. Choose **Deploys -> Trigger deploy**. Settings -> Connection then shows
   "TURN relay: configured".

These values end up inside the page and anyone can read them, so use
credentials from a TURN account meant for public web apps.

## Troubleshooting (Settings -> Connection)

| What you see | What it means / what to do |
| --- | --- |
| Relays: 0 connected | This network blocks the introduction servers. Try other Wi-Fi or cellular data. |
| Relays OK, Teammates connected: 0 | Team code or passcode doesn't match, or the other device isn't open. |
| Teammate shows `failed` / `connecting` | The networks can't connect directly. Add a TURN relay (above). |
| Teammate `connected` but audio `blocked` | Tap anywhere on the screen, which lets the phone start audio. |
| Audio `muted (other channel)` | You're on different channels. Switch to the same one. |
| No beep from "Test speaker" | Phone is on silent/vibrate (iPhone side switch) or volume is down. |
| Mic test bar doesn't move | Mic permission is blocked. Allow it for the site, then leave and rejoin. |

Tip: when testing, use two separate devices. Two tabs on one computer can
cancel each other's audio through echo cancellation.
