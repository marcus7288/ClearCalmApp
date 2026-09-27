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
- **Direct (private) talk.** Tap a teammate's name under the channel buttons.
  The talk button turns purple ("Hold to talk to Sarah"), and only that person
  hears you, even if they're on a different channel. They hear a two-tone
  chirp and see "(to you)". Tap "Back to channel" to return to group talk.
  Your microphone is connected only to the people meant to hear you, so
  neither direct nor channel audio is ever sent to anyone else's device.
- **Headphones.** Settings -> Microphone / headphones. "Automatic" switches to
  Bluetooth headphones whenever they're connected, and back when they aren't.
  On iPhone, sound plays through the same device as the microphone, so this is
  how you hear through AirPods or other headphones.
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
  direct connections. If a device can't connect, set up the TURN relay (see below).
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

### TURN relay (needed when some phones can't reach each other)

Each phone links directly to every other phone. Some network pairs can't
open that link, for example two phones on cellular data, or two phones on the
same Wi-Fi whose router doesn't let them reach each other. The app then shows
**"Name · no link"**. A TURN relay carries the audio for those pairs; pairs
that can connect directly keep doing so.

**Recommended: Cloudflare (free tier, 1,000 GB/month)**

1. Sign in at dash.cloudflare.com (a free account is fine) and go to
   **Realtime -> TURN Server -> Create**. Copy the **Turn Token ID** and the
   **API Token** it shows.
2. In Netlify, open **Site configuration -> Environment variables** and add:
   - `CLOUDFLARE_TURN_KEY_ID` = the Turn Token ID
   - `CLOUDFLARE_TURN_API_TOKEN` = the API Token
3. Choose **Deploys -> Trigger deploy -> Deploy site**.
4. Open the app, then go to **Settings -> Connection**. It should say
   **"TURN relay: on (Cloudflare)"**. Have everyone tap **Reconnect** (or
   reload the page).

These secrets stay on Netlify. The small function in
`netlify/functions/turn.mjs` gives each phone short-lived (12-hour)
credentials, and only to pages served from your own site.

**Alternative: Metered.ca.** Set `METERED_DOMAIN` (for example
`yourapp.metered.live`) and `METERED_API_KEY` instead.

**Alternative: fixed credentials.** Set `REACT_APP_TURN_URLS`,
`REACT_APP_TURN_USERNAME` and `REACT_APP_TURN_CREDENTIAL`. These are built
into the page where anyone can read them, so the function above is safer.

## Troubleshooting (Settings -> Connection)

| What you see | What it means / what to do |
| --- | --- |
| Relays: 0 connected | This network blocks the introduction servers. Try other Wi-Fi or cellular data. |
| Relays OK, Teammates connected: 0 | Team code or passcode doesn't match, or the other device isn't open. |
| Teammate shows `failed` / `connecting` | The networks can't connect directly. Add a TURN relay (above). |
| "Name · no link" in the roster | Others are connected to that person, but you aren't. Add a TURN relay (above). |
| Teammate `connected` but audio `blocked`, or an orange "Tap here to turn on sound" bar | Tap the bar (or anywhere). Phones only allow sound after a tap. |
| Audio `muted (other channel)` | You're on different channels. Switch to the same one. |
| No beep from "Test speaker" | Phone is on silent/vibrate (iPhone side switch) or volume is down. |
| iPhone plays through its speaker, not your headphones | Settings -> Microphone / headphones: choose the headphones (or "Automatic"). Check "In use" shows them. |
| Mic test bar doesn't move | Mic permission is blocked. Allow it for the site, then leave and rejoin. |
| Voice arrives late | Check "Delay from ..." (see below). |
| "Can't reach your teammates right now" | You have no working connection to anyone. If "Failed connection attempts" keeps rising, one of the networks blocks direct connections: switch networks or add a TURN relay (above). |
| "Someone ... has a different passcode" | A device with this team code has the wrong passcode (often an old tab or saved invite). Rejoin it with the right one. |
| Someone dropped off | Tap **Reconnect** in Settings (the page reloads and rejoins on the same channel). The app keeps the screen awake while it's open ("Screen awake: on"), because a sleeping phone drops off the team. |

### Reducing lag

The app already tells each phone to keep its incoming-audio buffer as small as
possible. Settings -> Connection shows the delay from each teammate, split into
**network** (travel time) and **buffer** (time the phone holds audio to smooth
out hiccups):

- **High network delay, or "(via TURN relay)":** the audio takes a long route.
  Put both phones on the same Wi-Fi, or choose a TURN provider with a server
  near you.
- **High buffer delay:** the connection is jittery (weak Wi-Fi or cellular
  signal). Move closer to the router or switch networks. The buffer shrinks
  automatically once the connection steadies.
- **Both numbers low but it still sounds late:** the delay is in the phone's
  own audio output. Bluetooth earbuds and speakers commonly add 150-300 ms;
  use the phone speaker or wired earphones. Android phones also add some
  output delay of their own.

Around 150-300 ms end to end is normal for internet voice, including
commercial push-to-talk apps.

Tip: when testing, use two separate devices. Two tabs on one computer can
cancel each other's audio through echo cancellation.
