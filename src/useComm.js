import { useCallback, useEffect, useRef, useState } from "react";
import { getRelaySockets, joinRoom, selfId } from "trystero";

// Everyone using the same team code joins one peer-to-peer room. Peers find
// each other through public Nostr relays (signaling only); voice and text then
// flow directly between browsers over encrypted WebRTC connections, so no
// server of our own is needed and the app can be hosted as a static site.
const APP_ID = "clearcalm-comm-v1";
const HISTORY_LIMIT = 100;

const envList = (value) =>
  (value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

// Large, well-run public Nostr relays that accept the short-lived (ephemeral)
// events used for signaling. Every device must share at least one relay to
// find each other, so we pin this list instead of relying on the library's
// default pick. Override with REACT_APP_NOSTR_RELAYS (comma separated).
const RELAY_URLS = envList(process.env.REACT_APP_NOSTR_RELAYS).length
  ? envList(process.env.REACT_APP_NOSTR_RELAYS)
  : [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.primal.net",
      "wss://nostr.mom",
      "wss://relay.nostr.net",
      "wss://offchain.pub",
    ];

// Optional: use Supabase (a managed service with a free tier) to introduce
// phones to each other instead of the public Nostr relays above, which are
// run by volunteers and aren't always reliable. Set both in Netlify.
// The anon key is designed to be public.
const SUPABASE_URL = (process.env.REACT_APP_SUPABASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const SUPABASE_KEY = (process.env.REACT_APP_SUPABASE_ANON_KEY || "").trim();
export const SIGNALING = SUPABASE_URL && SUPABASE_KEY ? "supabase" : "nostr";

// Is the Supabase project up? (Free projects pause after a week unused.)
const probeSupabase = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_KEY },
      signal: ctrl.signal,
    });
    return res.ok ? "reachable" : `unreachable (HTTP ${res.status})`;
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
};

// Ask Supabase Realtime directly whether it will let us use a broadcast
// channel, and report its own answer (e.g. a refusal when the project only
// allows private channels).
const probeRealtime = async () => {
  let client;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("no answer (timed out)"), 8000);
      client.channel("clearcalm-probe").subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve("OK");
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          clearTimeout(timer);
          resolve(
            `refused - ${status}${err?.message ? `: ${err.message}` : ""}`,
          );
        }
      });
    });
  } catch (err) {
    return `error - ${err?.message || err}`;
  } finally {
    try {
      client?.removeAllChannels();
      client?.realtime.disconnect();
    } catch {
      // ignore
    }
  }
};

// Optional TURN relay for networks that block direct connections (common on
// cellular data). Set these as environment variables in Netlify.
const TURN_URLS = envList(process.env.REACT_APP_TURN_URLS);
const TURN_CONFIG = TURN_URLS.length
  ? [
      {
        urls: TURN_URLS,
        username: process.env.REACT_APP_TURN_USERNAME || "",
        credential: process.env.REACT_APP_TURN_CREDENTIAL || "",
      },
    ]
  : undefined;

const now = () => Date.now();

// `to` is the peer ID someone is talking to directly, or null for the channel.
// `links` maps the peer IDs we're connected to onto their names, so teammates
// can tell when someone is on the team but has no direct link to them.
const presenceOf = ({ name, channel, talking, to }, links = {}) => ({
  name,
  channel,
  talking,
  to: to || null,
  links,
});

const linksOf = (peers) =>
  Object.fromEntries(Object.entries(peers).map(([id, p]) => [id, p.name]));

const cleanLinks = (links) => {
  if (!links || typeof links !== "object") return {};
  return Object.fromEntries(
    Object.entries(links)
      .filter(([id, n]) => typeof n === "string" && id.length <= 64)
      .slice(0, 50)
      .map(([id, n]) => [id, n.slice(0, 40)]),
  );
};

// Ask our Netlify Function for short-lived TURN relay credentials (see
// netlify/functions/turn.mjs). Falls back to direct-only if it isn't set up
// or can't be reached, e.g. when running locally.
const fetchTurnServers = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch("/.netlify/functions/turn", {
      method: "POST",
      signal: ctrl.signal,
    });
    if (!res.ok) return { provider: null, iceServers: [] };
    const data = await res.json();
    const iceServers = Array.isArray(data.iceServers)
      ? data.iceServers.filter((s) => s && s.urls)
      : [];
    return { provider: iceServers.length ? data.provider : null, iceServers };
  } catch {
    return { provider: null, iceServers: [] };
  } finally {
    clearTimeout(timer);
  }
};

const makeId = () =>
  `${selfId}-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const storageKey = (team) => `clearcalm:history:${team}`;

const loadHistory = (team) => {
  try {
    return JSON.parse(localStorage.getItem(storageKey(team))) || [];
  } catch {
    return [];
  }
};

const saveHistory = (team, messages) => {
  try {
    localStorage.setItem(
      storageKey(team),
      JSON.stringify(messages.filter((m) => m.type !== "system")),
    );
  } catch {
    // Storage full or blocked (private mode) - history just won't persist.
  }
};

// When messages were cleared. "mine" = cleared on this phone only; "team" =
// someone cleared them for everyone (shared with teammates, including ones
// who were offline, so old copies can't come back from their phones).
// Anything sent at or before the later of the two stays hidden.
const clearedKey = (team) => `clearcalm:cleared:${team}`;
const loadCleared = (team) => {
  try {
    const v = JSON.parse(localStorage.getItem(clearedKey(team)));
    return { mine: Number(v?.mine) || 0, team: Number(v?.team) || 0 };
  } catch {
    return { mine: 0, team: 0 };
  }
};
const saveCleared = (team, cleared) => {
  try {
    localStorage.setItem(clearedKey(team), JSON.stringify(cleared));
  } catch {
    // ignore
  }
};
const cutoffOf = (cleared) => Math.max(cleared.mine, cleared.team);

// Merge incoming messages into the list, dropping duplicates and keeping
// chronological order.
const mergeMessages = (current, incoming) => {
  const seen = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => m && m.id && !seen.has(m.id));
  if (!added.length) return current;
  return [...current, ...added]
    .sort((a, b) => a.ts - b.ts)
    .slice(-HISTORY_LIMIT);
};

let audioCtx;
const getAudioCtx = () => {
  audioCtx =
    audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
};

// A short radio "chirp" so people know when a transmission starts and ends.
export const chirp = (freq, seconds = 0.12, level = 0.08) => {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(level, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + seconds);
  } catch {
    // Web Audio unavailable - silently skip the chirp.
  }
};

// Incoming voice plays through <audio> elements kept in the page. Phones
// (especially iPhones) only start playback inside a tap, so every tap calls
// unlockAudio() to start any element the browser held back.
let audioHost;
const getAudioHost = () => {
  if (!audioHost) {
    audioHost = document.createElement("div");
    audioHost.setAttribute("aria-hidden", "true");
    audioHost.style.display = "none";
    document.body.appendChild(audioHost);
  }
  return audioHost;
};

// WebRTC normally buffers incoming audio to smooth out network hiccups, and
// that buffer can grow to half a second or more. For push-to-talk we'd rather
// hear people immediately, so ask each audio receiver to keep its buffer as
// small as the network allows. (Supported in Chrome, Edge, and recent Safari;
// other browsers ignore it.)
const tuneForLowLatency = (pc) => {
  if (!pc?.getReceivers) return;
  pc.getReceivers().forEach((receiver) => {
    if (receiver.track?.kind !== "audio") return;
    try {
      if ("jitterBufferTarget" in receiver && receiver.jitterBufferTarget !== 0)
        receiver.jitterBufferTarget = 0;
    } catch {
      // not supported
    }
    try {
      if (receiver.playoutDelayHint !== 0) receiver.playoutDelayHint = 0;
    } catch {
      // not supported
    }
  });
};

// Measure round-trip time and receive-buffer delay for one connection.
// `prev` holds the last counters so the buffer figure reflects the last
// second rather than the whole call.
const measureLatency = async (pc, prev = {}) => {
  const stats = await pc.getStats();
  let rttMs = null;
  let viaRelay = false;
  let bufferMs = prev.bufferMs ?? null;
  const next = { ...prev };
  const byId = new Map();
  stats.forEach((r) => byId.set(r.id, r));
  stats.forEach((r) => {
    if (
      r.type === "candidate-pair" &&
      r.state === "succeeded" &&
      (r.nominated || r.selected) &&
      r.currentRoundTripTime != null
    ) {
      rttMs = Math.round(r.currentRoundTripTime * 1000);
      viaRelay = byId.get(r.localCandidateId)?.candidateType === "relay";
    }
    if (r.type === "outbound-rtp" && r.kind === "audio") {
      if (prev.outTs != null && r.timestamp > prev.outTs) {
        next.outKbps = Math.round(
          ((r.bytesSent - prev.outBytes) * 8) / (r.timestamp - prev.outTs),
        );
      }
      next.outBytes = r.bytesSent;
      next.outTs = r.timestamp;
    }
    if (r.type === "inbound-rtp" && r.kind === "audio") {
      if (prev.inTs != null && r.timestamp > prev.inTs) {
        next.inKbps = Math.round(
          ((r.bytesReceived - prev.inBytes) * 8) / (r.timestamp - prev.inTs),
        );
      }
      next.inBytes = r.bytesReceived;
      next.inTs = r.timestamp;
      if (typeof r.audioLevel === "number") {
        next.inLevel = Math.round(r.audioLevel * 100);
      }
      const delay = r.jitterBufferDelay || 0;
      const count = r.jitterBufferEmittedCount || 0;
      if (prev.count != null && count > prev.count) {
        bufferMs = Math.round(
          ((delay - prev.delay) / (count - prev.count)) * 1000,
        );
      }
      next.delay = delay;
      next.count = count;
    }
  });
  next.bufferMs = bufferMs;
  return {
    rttMs,
    bufferMs,
    viaRelay,
    inKbps: next.inKbps ?? null,
    inLevel: next.inLevel ?? null,
    outKbps: next.outKbps ?? null,
    counters: next,
  };
};

// Each teammate's voice plays through its own <audio> element; muting it
// handles channel filtering. (This is the playback path that worked on
// iPhones. Note iOS ignores element volume: the phone's volume buttons
// control loudness there.)
const createPlayer = () => {
  const el = document.createElement("audio");
  el.autoplay = true;
  el.playsInline = true;
  el.muted = true;
  el.setAttribute("playsinline", "");
  getAudioHost().appendChild(el);
  return { el };
};

const attachStream = (player, stream) => {
  player.el.srcObject = stream;
  player.el.play().catch(() => {});
};

// level: 0 (silent) to 1 (full volume).
const setPlayerLevel = (player, level) => {
  player.el.muted = level === 0;
  if (level > 0) player.el.volume = level;
  player.el.dataset.audible = level > 0 ? "1" : "0";
};

const destroyPlayer = (player) => {
  player.el.pause();
  player.el.srcObject = null;
  player.el.remove();
};

const playerStatus = (player) => {
  if (!player) return "no audio yet";
  if (player.el.paused) return "blocked - tap to enable";
  return player.el.dataset.audible === "1"
    ? "playing"
    : "muted (other channel)";
};

// True until the browser lets this page play sound (it needs a tap first).
export const isAudioBlocked = () =>
  (!!audioCtx && audioCtx.state !== "running") ||
  (!!audioHost &&
    [...audioHost.querySelectorAll("audio")].some(
      (a) => a.paused && a.srcObject,
    ));

export const unlockAudio = () => {
  try {
    const ctx = getAudioCtx();
    // iOS can leave the context "interrupted" after the mic starts.
    if (ctx.state !== "running") ctx.resume().catch(() => {});
  } catch {
    // ignore
  }
  if (!audioHost) return;
  audioHost.querySelectorAll("audio").forEach((a) => {
    if (a.paused && a.srcObject) a.play().catch(() => {});
  });
};

// Fully restart every teammate's player: detach and re-attach its stream,
// then play. When the iPhone's audio route changes (for example to Bluetooth
// headphones) while a player is running, it can keep reporting "playing"
// with its output cut off, and incoming audio just piles up in the buffer.
// Re-attaching reconnects it to the current output.
export const restartSound = () => {
  unlockAudio();
  audioHost?.querySelectorAll("audio").forEach((a) => {
    const stream = a.srcObject;
    if (!stream) return;
    a.srcObject = null;
    a.srcObject = stream;
    a.play().catch(() => {});
  });
};

// Every microphone track we create. Leaving stops all of them, so the
// phone's "mic in use" indicator turns off.
const micTracks = new Set();
const trackMic = (stream) => {
  stream.getTracks().forEach((t) => micTracks.add(t));
  return stream;
};
const stopAllMicTracks = () => {
  micTracks.forEach((t) => t.stop());
  micTracks.clear();
};

// Microphone / headset choice. On iPhones, while a page is using the mic,
// sound comes out wherever the *mic* is: the phone's own mic means the phone
// speaker. Picking the Bluetooth headphones' mic sends sound to the
// headphones too. "auto" picks connected headphones when there are any.
// v2: the default changed to "system" (never switch mics automatically),
// so older saved "auto" choices start from the new default.
const MIC_PREF_KEY = "clearcalm:mic2";
const HEADSET_RE =
  /airpods|bluetooth|headset|headphone|earbud|buds|beats|hands-?free|jabra|bose|wh-|wf-/i;

export const loadMicChoice = () => {
  try {
    return localStorage.getItem(MIC_PREF_KEY) || "system";
  } catch {
    return "system";
  }
};

const saveMicChoice = (choice) => {
  try {
    localStorage.setItem(MIC_PREF_KEY, choice);
  } catch {
    // ignore
  }
};

const micConstraints = (deviceId) => ({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  },
  video: false,
});

const listMicDevices = async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput" && d.deviceId)
      .filter(
        (d) => d.deviceId !== "default" && d.deviceId !== "communications",
      )
      .map((d) => ({ deviceId: d.deviceId, label: d.label || "Microphone" }));
  } catch {
    return [];
  }
};

// Which device a choice means right now (undefined = the system default).
const resolveMic = (choice, devices) => {
  if (!choice || choice === "system") return undefined;
  if (choice !== "auto") {
    return devices.some((d) => d.deviceId === choice) ? choice : undefined;
  }
  return devices.find((d) => HEADSET_RE.test(d.label))?.deviceId;
};

// Open the chosen mic, falling back to the default if that device fails.
const openMic = async (deviceId) => {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (err) {
    if (!deviceId) throw err;
    return navigator.mediaDevices.getUserMedia(micConstraints());
  }
};

// Microphone level (0-1) for the audio check in Settings.
const createLevelMeter = (stream) => {
  const ctx = getAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  return {
    read: () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      data.forEach((v) => (peak = Math.max(peak, Math.abs(v - 128))));
      return Math.min(1, peak / 64);
    },
    stop: () => source.disconnect(),
  };
};

export default function useComm() {
  const [status, setStatus] = useState("offline"); // offline | connecting | online
  const [peers, setPeers] = useState({}); // peerId -> { name, channel, talking, to }
  const [messages, setMessages] = useState([]);
  const [micState, setMicState] = useState("off"); // off | ready | denied
  const [transmitting, setTransmitting] = useState(false);
  const [wakeLock, setWakeLock] = useState("off"); // on | off | unsupported
  const [signalStatus, setSignalStatus] = useState(""); // Supabase reachability
  const [mics, setMics] = useState([]); // available microphones / headsets
  const [micChoice, setMicChoice] = useState(loadMicChoice); // "auto" | deviceId
  const [activeMic, setActiveMic] = useState(""); // label of the mic in use
  const [micSwitches, setMicSwitches] = useState(0); // times the mic changed
  const [micNote, setMicNote] = useState(""); // e.g. auto-switching paused
  const wakeLockRef = useRef(null);

  const roomRef = useRef(null);
  const actionsRef = useRef(null);
  const streamRef = useRef(null); // the microphone
  // One microphone track is added to every teammate's connection, but each
  // connection's sender only carries it while that person should hear us;
  // otherwise it sends nothing. So channel and direct conversations never
  // reach anyone else's device. (Earlier versions gave each teammate a
  // separate *copy* of the mic, switched on and off; iPhones went silent
  // with that.)
  const sendersRef = useRef({}); // peerId -> RTCRtpSender | "pending"
  const recipientsRef = useRef(new Set()); // peer IDs hearing us right now
  const micTestRef = useRef(false); // Settings mic test running
  const audiosRef = useRef({}); // peerId -> player (see createPlayer)
  const selfRef = useRef({
    name: "",
    channel: 1,
    talking: false,
    to: null,
    team: "",
  });
  const peersRef = useRef({});
  const outputRef = useRef({ volume: 0.75, muted: false });

  const messagesRef = useRef([]);

  peersRef.current = peers;
  messagesRef.current = messages;

  const addSystem = useCallback((text) => {
    setMessages((prev) =>
      mergeMessages(prev, [
        { id: makeId(), type: "system", text, ts: now(), channel: null },
      ]),
    );
  }, []);

  const clearedRef = useRef({ mine: 0, team: 0 });

  // A teammate cleared messages for everyone at time `before`. Returns true
  // if that's newer than what we had.
  const applyTeamClear = useCallback((before) => {
    if (!before || !Number.isFinite(before)) return false;
    // Never accept a time in the future (it would hide new messages).
    const cutoff = Math.min(before, now());
    if (cutoff <= clearedRef.current.team) return false;
    clearedRef.current.team = cutoff;
    saveCleared(selfRef.current.team, clearedRef.current);
    setMessages((prev) =>
      prev.filter((m) => m.type === "system" || m.ts > cutoff),
    );
    return true;
  }, []);

  // Play audio from peers on our channel, or anyone talking to us directly.
  const applyAudio = useCallback(() => {
    const { volume, muted } = outputRef.current;
    const myChannel = selfRef.current.channel;
    Object.entries(audiosRef.current).forEach(([peerId, player]) => {
      const peer = peersRef.current[peerId];
      const forMe =
        peer &&
        (peer.to === selfId || (!peer.to && peer.channel === myChannel));
      setPlayerLevel(player, muted || !forMe ? 0 : volume);
    });
  }, []);

  // Point a teammate's sender at the mic (they hear us) or at nothing.
  const routeTo = useCallback((peerId, on) => {
    const sender = sendersRef.current[peerId];
    if (!sender || sender === "pending") return;
    const track = on ? streamRef.current?.getAudioTracks()[0] || null : null;
    if (sender.track !== track) sender.replaceTrack(track).catch(() => {});
  }, []);

  // Add our microphone to a teammate's connection, silent until we talk to them.
  const sendMicTo = useCallback(
    (room, peerId) => {
      const mic = streamRef.current;
      const track = mic?.getAudioTracks()[0];
      if (!track || sendersRef.current[peerId]) return;
      sendersRef.current[peerId] = "pending";
      // A per-teammate stream *wrapper* around the one mic track (not a copy
      // of the track): the library tracks streams per object, and sharing a
      // single stream object between connections could stall one of them.
      room.addStream(new MediaStream([track]), { target: peerId });
      // The library creates the connection's audio sender shortly after
      // addStream; look for it for a few seconds rather than assuming it's
      // there yet (it often isn't when two people join at the same moment).
      let tries = 0;
      const find = () => {
        if (sendersRef.current[peerId] !== "pending") return;
        const sender = room
          .getPeers()
          [peerId]?.getSenders()
          .find((sn) => sn.track === track);
        if (sender) {
          sendersRef.current[peerId] = sender;
          routeTo(peerId, recipientsRef.current.has(peerId));
        } else if (++tries < 50) {
          setTimeout(find, 100);
        } else {
          delete sendersRef.current[peerId];
        }
      };
      find();
    },
    [routeTo],
  );

  const dropMicFor = useCallback((peerId) => {
    delete sendersRef.current[peerId];
    recipientsRef.current.delete(peerId);
  }, []);

  useEffect(applyAudio, [peers, applyAudio]);

  const broadcastPresence = useCallback(() => {
    actionsRef.current?.presence.send(
      presenceOf(selfRef.current, linksOf(peersRef.current)),
    );
  }, []);

  // Tell everyone whenever our set of connections changes.
  const linkKey = Object.entries(peers)
    .map(([id, p]) => `${id}:${p.name}`)
    .sort()
    .join("|");
  useEffect(() => {
    if (linkKey) broadcastPresence();
  }, [linkKey, broadcastPresence]);

  const turnSourceRef = useRef(null); // which TURN relay is in use, if any
  const leavingRef = useRef(null); // pending room.leave(), awaited on rejoin
  const failuresRef = useRef({ count: 0, last: "" });
  const lastWarningRef = useRef({});

  // Post a system notice at most once a minute per kind, so a flaky
  // connection doesn't flood the message feed.
  const warnOnce = useCallback(
    (kind, text) => {
      const t = now();
      if (t - (lastWarningRef.current[kind] || 0) < 60000) return;
      lastWarningRef.current[kind] = t;
      addSystem(text);
    },
    [addSystem],
  );

  const disconnect = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    actionsRef.current = null;
    if (room) leavingRef.current = room.leave().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    stopAllMicTracks();
    sendersRef.current = {};
    recipientsRef.current = new Set();
    Object.values(audiosRef.current).forEach(destroyPlayer);
    audiosRef.current = {};
    selfRef.current.talking = false;
    selfRef.current.to = null;
    setPeers({});
    setTransmitting(false);
    setMicState("off");
    setStatus("offline");
  }, []);

  const connect = useCallback(
    async ({ team, passcode, name, channel }) => {
      if (roomRef.current) return;
      selfRef.current = { team, name, channel, talking: false, to: null };
      failuresRef.current = { count: 0, last: "" };
      setStatus("connecting");
      clearedRef.current = loadCleared(team);
      setMessages(
        loadHistory(team).filter((m) => m.ts > cutoffOf(clearedRef.current)),
      );
      // Finish leaving any previous session first; joining the same room
      // while it is still closing would hand back the closing instance.
      if (leavingRef.current) await leavingRef.current;
      if (roomRef.current) return;
      const turn = await fetchTurnServers();
      if (roomRef.current) return;

      const config = {
        appId: APP_ID,
        relayConfig: { urls: RELAY_URLS },
      };
      // Introductions via Supabase when configured; the Supabase code is only
      // downloaded in that case.
      let join = joinRoom;
      if (SIGNALING === "supabase") {
        config.appId = SUPABASE_URL;
        config.relayConfig = { supabaseKey: SUPABASE_KEY };
        setSignalStatus("checking");
        Promise.all([probeSupabase(), probeRealtime()]).then(
          ([health, realtime]) =>
            setSignalStatus(`${health} · realtime ${realtime}`),
        );
        ({ joinRoom: join } = await import("@trystero-p2p/supabase"));
        if (roomRef.current) return;
      }
      const turnServers = [...(TURN_CONFIG || []), ...turn.iceServers];
      if (turnServers.length) config.turnConfig = turnServers;
      turnSourceRef.current = turn.provider
        ? turn.provider
        : TURN_CONFIG
          ? "build settings"
          : null;
      if (passcode) config.password = passcode;

      const room = join(config, team, {
        // Individual connection attempts fail routinely (a phone going to
        // sleep mid-handshake, an old tab left open, a network switch) and
        // the library retries on its own. Only warn when it matters: a
        // passcode mismatch, or when we can't reach anyone at all.
        onJoinError: ({ error, peerId }) => {
          const reason = String(error?.message || error || "unknown error");
          failuresRef.current = {
            count: failuresRef.current.count + 1,
            last: reason,
          };
          if (/password/i.test(reason)) {
            warnOnce(
              "passcode",
              "Someone using this team code has a different passcode, so they can't connect. Check that everyone uses the same passcode.",
            );
            return;
          }
          setTimeout(() => {
            if (roomRef.current !== room) return;
            const connected = Object.keys(room.getPeers());
            if (connected.includes(peerId) || connected.length > 0) return;
            warnOnce(
              "network",
              "Can't reach your teammates right now - a network may be blocking direct connections. The app keeps retrying. See Settings > Connection for details.",
            );
          }, 8000);
        },
      });
      roomRef.current = room;

      const presenceAction = room.makeAction("pres");
      const chatAction = room.makeAction("chat");
      const historyAction = room.makeAction("hist");
      const clearAction = room.makeAction("clr");
      actionsRef.current = {
        presence: presenceAction,
        chat: chatAction,
        history: historyAction,
        clear: clearAction,
      };

      room.onPeerJoin = (peerId) => {
        if (window.__ccDebug)
          window.__ccDebug.log.push(["join", peerId, Date.now()]);
        presenceAction.send(
          presenceOf(selfRef.current, linksOf(peersRef.current)),
          {
            target: peerId,
          },
        );
        // Catch the newcomer up: our messages, plus when the team last
        // cleared them (so their own older copies disappear too).
        const history = messagesRef.current.filter((m) => m.type !== "system");
        const clearedBefore = clearedRef.current.team;
        if (history.length || clearedBefore) {
          historyAction.send(
            { messages: history, clearedBefore },
            { target: peerId },
          );
        }
        // A join is always a fresh connection - even for a peer ID we've
        // seen before (their tab reconnected before we noticed them leave) -
        // so replace any mic copy tied to the old connection.
        dropMicFor(peerId);
        sendMicTo(room, peerId);
      };

      room.onPeerLeave = (peerId) => {
        if (window.__ccDebug)
          window.__ccDebug.log.push(["leave", peerId, Date.now()]);
        const peer = peersRef.current[peerId];
        if (peer) addSystem(`${peer.name} left`);
        dropMicFor(peerId);
        const player = audiosRef.current[peerId];
        if (player) {
          destroyPlayer(player);
          delete audiosRef.current[peerId];
        }
        setPeers((prev) => {
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
      };

      presenceAction.onMessage = (data, { peerId }) => {
        if (!data || typeof data.name !== "string") return;
        const info = {
          name: data.name.slice(0, 40) || "Unknown",
          channel: Number(data.channel) || 1,
          talking: !!data.talking,
          to: typeof data.to === "string" ? data.to : null,
          links: cleanLinks(data.links),
        };
        const previous = peersRef.current[peerId];
        if (!previous) addSystem(`${info.name} joined`);
        if (info.talking && !previous?.talking && !outputRef.current.muted) {
          if (info.to === selfId) {
            // Two-tone chirp for a direct call.
            chirp(990);
            setTimeout(() => chirp(1320), 140);
          } else if (!info.to && info.channel === selfRef.current.channel) {
            chirp(880);
          }
        }
        setPeers((prev) => ({ ...prev, [peerId]: info }));
      };

      chatAction.onMessage = (msg) => {
        if (!msg || typeof msg.text !== "string") return;
        if (!(msg.ts > cutoffOf(clearedRef.current))) return;
        setMessages((prev) =>
          mergeMessages(prev, [{ ...msg, text: msg.text.slice(0, 1000) }]),
        );
      };

      // Older versions send a plain array; newer ones send
      // { messages, clearedBefore }.
      historyAction.onMessage = (data) => {
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.messages)
            ? data.messages
            : [];
        if (!Array.isArray(data) && data?.clearedBefore) {
          applyTeamClear(Number(data.clearedBefore));
        }
        const cutoff = cutoffOf(clearedRef.current);
        setMessages((prev) =>
          mergeMessages(
            prev,
            list.filter(
              (m) => m && typeof m.text === "string" && m.ts > cutoff,
            ),
          ),
        );
      };

      clearAction.onMessage = (data, { peerId }) => {
        const name = peersRef.current[peerId]?.name || "A teammate";
        if (applyTeamClear(Number(data?.before))) {
          addSystem(`${name} cleared the messages for everyone`);
        }
      };

      room.onPeerStream = (stream, peerId) => {
        let player = audiosRef.current[peerId];
        if (!player) {
          player = createPlayer();
          audiosRef.current[peerId] = player;
        }
        attachStream(player, stream);
        applyAudio();
        tuneForLowLatency(room.getPeers()[peerId]);
      };

      setStatus("online");
      addSystem(`Joined team "${team}" - waiting for teammates`);

      // Ask for the microphone. Text still works if the user says no.
      try {
        // Device names are only visible after mic permission, so open the
        // saved/default mic first, then switch to headphones if "auto" finds
        // some (see useMicSwitching below).
        const saved = loadMicChoice();
        const stream = await openMic(
          saved === "auto" || saved === "system" ? undefined : saved,
        );
        if (roomRef.current !== room) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        trackMic(stream);
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        streamRef.current = stream;
        Object.keys(room.getPeers()).forEach((id) => sendMicTo(room, id));
        setActiveMic(stream.getAudioTracks()[0]?.label || "");
        setMicState("ready");
      } catch {
        setMicState("denied");
        addSystem(
          "Microphone unavailable - you can still listen and send text. Allow mic access in your browser settings to talk.",
        );
      }
    },
    [addSystem, applyAudio, sendMicTo, dropMicFor, warnOnce, applyTeamClear],
  );

  useEffect(() => disconnect, [disconnect]);

  // Closing the tab or swiping the home-screen app away: leave the team right
  // away so teammates don't keep seeing us until the connection times out.
  useEffect(() => {
    const onPageHide = (e) => {
      if (!e.persisted) disconnect();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [disconnect]);

  // Persist chat history per team so it survives a page reload.
  useEffect(() => {
    if (selfRef.current.team && status === "online") {
      saveHistory(selfRef.current.team, messages);
    }
  }, [messages, status]);

  // Talk to everyone on our channel, or only to `targetId` if given.
  if (typeof window !== "undefined" && window.__ccDebug) {
    window.__ccDebug.senders = sendersRef;
    window.__ccDebug.peers = peersRef;
    window.__ccDebug.room = roomRef;
    window.__ccDebug.players = audiosRef;
  }

  const startTalking = useCallback(
    (targetId = null) => {
      if (!streamRef.current || selfRef.current.talking) return;
      const me = selfRef.current;
      const recipients = targetId
        ? [targetId]
        : Object.keys(peersRef.current).filter(
            (id) => peersRef.current[id].channel === me.channel,
          );
      me.talking = true;
      me.to = targetId || null;
      // Announce first so listeners unmute before the audio arrives.
      broadcastPresence();
      recipientsRef.current = new Set(recipients);
      streamRef.current.getAudioTracks().forEach((t) => (t.enabled = true));
      recipients.forEach((id) => routeTo(id, true));
      setTransmitting(true);
      chirp(1200);
    },
    [broadcastPresence, routeTo],
  );

  const stopTalking = useCallback(() => {
    if (!selfRef.current.talking) return;
    streamRef.current
      ?.getAudioTracks()
      .forEach((t) => (t.enabled = micTestRef.current));
    recipientsRef.current = new Set();
    Object.keys(sendersRef.current).forEach((id) => routeTo(id, false));
    selfRef.current.talking = false;
    selfRef.current.to = null;
    setTransmitting(false);
    chirp(700);
    broadcastPresence();
  }, [broadcastPresence, routeTo]);

  const sendText = useCallback((text) => {
    const clean = text.trim().slice(0, 1000);
    if (!clean || !actionsRef.current) return;
    const msg = {
      id: makeId(),
      type: "chat",
      from: selfId,
      name: selfRef.current.name,
      channel: selfRef.current.channel,
      text: clean,
      ts: now(),
    };
    setMessages((prev) => mergeMessages(prev, [msg]));
    actionsRef.current.chat.send(msg);
  }, []);

  const setChannel = useCallback(
    (channel) => {
      selfRef.current.channel = channel;
      applyAudio();
      broadcastPresence();
    },
    [applyAudio, broadcastPresence],
  );

  const setName = useCallback(
    (name) => {
      selfRef.current.name = name;
      broadcastPresence();
    },
    [broadcastPresence],
  );

  const setOutput = useCallback(
    ({ volume, muted }) => {
      outputRef.current = { volume, muted };
      applyAudio();
    },
    [applyAudio],
  );

  // Clear messages on this phone ("me") or for the whole team ("team").
  const clearHistory = useCallback((scope = "me") => {
    const team = selfRef.current.team;
    const t = now();
    if (scope === "team") {
      clearedRef.current.team = t;
      actionsRef.current?.clear.send({ before: t });
    } else {
      clearedRef.current.mine = t;
    }
    saveCleared(team, clearedRef.current);
    setMessages([]);
    try {
      localStorage.removeItem(storageKey(team));
    } catch {
      // ignore
    }
  }, []);

  // Snapshot of connection health for the diagnostics panel.
  const getDiagnostics = useCallback(() => {
    const sockets =
      roomRef.current && SIGNALING === "nostr" ? getRelaySockets() : {};
    const relays = (SIGNALING === "nostr" ? RELAY_URLS : []).map((url) => {
      const ws = sockets[url];
      const state = ws
        ? ["connecting", "connected", "closing", "closed"][ws.readyState]
        : "not started";
      return { url: url.replace("wss://", ""), state };
    });
    const connections = roomRef.current ? roomRef.current.getPeers() : {};
    const peerRows = Object.entries(connections).map(([peerId, pc]) => {
      return {
        peerId,
        name: peersRef.current[peerId]?.name || "(unknown)",
        connection: pc?.connectionState || "unknown",
        audio: playerStatus(audiosRef.current[peerId]),
      };
    });
    return {
      relays,
      signaling: SIGNALING,
      signalStatus,
      peers: peerRows,
      failures: failuresRef.current,
      mic: activeMic,
      micSwitches,
      wakeLock,
      micState,
      turn: turnSourceRef.current,
      secure: window.isSecureContext,
    };
  }, [micState, wakeLock, activeMic, micSwitches, signalStatus]);

  // Keep the screen on while connected. A sleeping phone drops off the team
  // (and makes teammates' reconnection attempts fail), which defeats the
  // point of a push-to-talk radio.
  const ensureWakeLock = useCallback(async () => {
    if (!roomRef.current || document.visibilityState !== "visible") return;
    if (!("wakeLock" in navigator)) {
      setWakeLock("unsupported");
      return;
    }
    if (wakeLockRef.current && !wakeLockRef.current.released) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      wakeLockRef.current = lock;
      setWakeLock("on");
      lock.addEventListener("release", () => setWakeLock("off"));
    } catch {
      setWakeLock("off");
    }
  }, []);

  useEffect(() => {
    if (status !== "online") {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      return undefined;
    }
    ensureWakeLock();
    // Coming back to the app (or back online): re-take the wake lock and
    // re-announce ourselves so teammates refresh our status right away.
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      ensureWakeLock();
      broadcastPresence();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    // Some browsers only grant the wake lock during a tap.
    window.addEventListener("pointerdown", ensureWakeLock, true);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pointerdown", ensureWakeLock, true);
    };
  }, [status, ensureWakeLock, broadcastPresence]);

  // Switch microphone / headset without dropping the call. iPhones allow one
  // capture at a time, so the old mic is stopped before the new one opens.
  const switchingRef = useRef(false);
  const switchTimesRef = useRef([]);
  const autoSwitchPausedRef = useRef(false);
  const switchMic = useCallback(
    async (
      choice = loadMicChoice(),
      { force = false, manual = false } = {},
    ) => {
      if (manual) {
        autoSwitchPausedRef.current = false;
        switchTimesRef.current = [];
        setMicNote("");
      } else if (autoSwitchPausedRef.current && !force) {
        return;
      }
      saveMicChoice(choice);
      setMicChoice(choice);
      const devices = await listMicDevices();
      setMics(devices);
      // "Phone default": never reopen the mic on our own. (Reopening the mic
      // mid-call is what broke iPhone sound.) Only an explicit pick, or the
      // mic disappearing, reopens it.
      if (choice === "system" && !manual && !force) return;
      const old = streamRef.current;
      if (!old || !roomRef.current || switchingRef.current) return;
      const oldTrack = old.getAudioTracks()[0];
      const wanted = resolveMic(choice, devices);
      const live = oldTrack?.readyState === "live";
      // Which listed device is the mic in use? Match by ID or by name:
      // iPhones don't always report the same ID for the track as in the list.
      const currentId = oldTrack?.getSettings?.().deviceId;
      const current =
        devices.find((d) => d.deviceId === currentId) ||
        devices.find((d) => d.label === oldTrack?.label);
      // Already on the right mic? (With no headphones in "auto", that's
      // anything except a headset that has just gone away.)
      const onRightMic = wanted
        ? current?.deviceId === wanted ||
          (!current && !!currentId && currentId === wanted)
        : !(choice === "auto" && HEADSET_RE.test(oldTrack?.label || ""));
      if (!force && live && onRightMic) return;
      // Safety valve: if automatic switching keeps flipping the mic (each
      // switch can itself look like a device change on iPhones), stop
      // switching automatically. A manual choice still works.
      if (!manual) {
        const t = now();
        switchTimesRef.current = switchTimesRef.current.filter(
          (x) => t - x < 30000,
        );
        if (switchTimesRef.current.length >= 3) {
          if (!autoSwitchPausedRef.current) {
            autoSwitchPausedRef.current = true;
            setMicNote(
              "Automatic headphone switching paused because the mic kept changing. Pick a mic above if needed.",
            );
          }
          return;
        }
        switchTimesRef.current.push(t);
      }
      switchingRef.current = true;
      try {
        old.getTracks().forEach((t) => {
          t.stop();
          micTracks.delete(t);
        });
        const stream = trackMic(await openMic(wanted));
        const track = stream.getAudioTracks()[0];
        track.enabled = selfRef.current.talking || micTestRef.current;
        streamRef.current = stream;
        // Re-point every teammate who should be hearing us at the new mic.
        Object.keys(sendersRef.current).forEach((id) =>
          routeTo(id, recipientsRef.current.has(id)),
        );
        setActiveMic(track.label || "");
        setMicSwitches((n) => n + 1);
        // The audio route just changed (e.g. to Bluetooth headphones);
        // reconnect teammates' players to the new output. Again shortly after,
        // since iOS finishes moving the route asynchronously.
        restartSound();
        setTimeout(restartSound, 800);
        setMics(await listMicDevices());
      } catch {
        setMicState("denied");
      } finally {
        switchingRef.current = false;
      }
    },
    [routeTo],
  );

  // Once connected, and whenever headphones connect or disconnect, follow the
  // chosen mic - in "auto", that means headphones whenever they're present.
  useEffect(() => {
    if (micState !== "ready") return undefined;
    switchMic();
    const onChange = () => switchMic();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () =>
      navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
  }, [micState, switchMic]);

  // If the mic in use disappears (headphones switched off), reopen one.
  useEffect(() => {
    if (micState !== "ready") return undefined;
    const track = streamRef.current?.getAudioTracks()[0];
    const onEnded = () => switchMic(undefined, { force: true });
    track?.addEventListener("ended", onEnded);
    return () => track?.removeEventListener("ended", onEnded);
  }, [micState, activeMic, switchMic]);

  // Mic level meter for Settings. The mic track is switched on while testing,
  // which is safe: no teammate's sender carries it unless we're talking.
  const startMicTest = useCallback(() => {
    const mic = streamRef.current;
    if (!mic) return null;
    micTestRef.current = true;
    mic.getAudioTracks().forEach((t) => (t.enabled = true));
    const meter = createLevelMeter(mic);
    return {
      read: meter.read,
      stop: () => {
        meter.stop();
        micTestRef.current = false;
        mic
          .getAudioTracks()
          .forEach((t) => (t.enabled = selfRef.current.talking));
      },
    };
  }, []);

  // Keep every connection's audio buffer small (new receivers can appear when
  // peers renegotiate, so re-apply every couple of seconds).
  useEffect(() => {
    if (status !== "online") return undefined;
    const id = setInterval(() => {
      const room = roomRef.current;
      if (room) Object.values(room.getPeers()).forEach(tuneForLowLatency);
    }, 2000);
    return () => clearInterval(id);
  }, [status]);

  // Per-teammate latency figures for the diagnostics panel.
  const latencyCountersRef = useRef({});
  const getLatency = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return {};
    const result = {};
    await Promise.all(
      Object.entries(room.getPeers()).map(async ([peerId, pc]) => {
        try {
          const m = await measureLatency(
            pc,
            latencyCountersRef.current[peerId],
          );
          latencyCountersRef.current[peerId] = m.counters;
          result[peerId] = m;
        } catch {
          // connection closing
        }
      }),
    );
    return result;
  }, []);

  return {
    selfId,
    getDiagnostics,
    startMicTest,
    mics,
    micChoice,
    activeMic,
    switchMic,
    micNote,
    getLatency,
    status,
    peers,
    messages,
    micState,
    transmitting,
    connect,
    disconnect,
    startTalking,
    stopTalking,
    sendText,
    setChannel,
    setName,
    setOutput,
    clearHistory,
  };
}
