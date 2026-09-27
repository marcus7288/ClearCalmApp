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
    if (r.type === "inbound-rtp" && r.kind === "audio") {
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
  return { rttMs, bufferMs, viaRelay, counters: next };
};

export const unlockAudio = () => {
  try {
    getAudioCtx();
  } catch {
    // ignore
  }
  if (!audioHost) return;
  audioHost.querySelectorAll("audio").forEach((a) => {
    if (a.paused && a.srcObject) a.play().catch(() => {});
  });
};

// Microphone level (0-1) for the audio check in Settings.
export const createLevelMeter = (stream) => {
  const ctx = getAudioCtx();
  const clone = stream.clone();
  clone.getAudioTracks().forEach((t) => (t.enabled = true));
  const source = ctx.createMediaStreamSource(clone);
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
    stop: () => {
      source.disconnect();
      clone.getTracks().forEach((t) => t.stop());
    },
  };
};

export default function useComm() {
  const [status, setStatus] = useState("offline"); // offline | connecting | online
  const [peers, setPeers] = useState({}); // peerId -> { name, channel, talking, to }
  const [messages, setMessages] = useState([]);
  const [micState, setMicState] = useState("off"); // off | ready | denied
  const [transmitting, setTransmitting] = useState(false);
  const [wakeLock, setWakeLock] = useState("off"); // on | off | unsupported
  const wakeLockRef = useRef(null);

  const roomRef = useRef(null);
  const actionsRef = useRef(null);
  const streamRef = useRef(null); // the microphone (never sent directly)
  // Each teammate gets their own copy of the mic track. Only the copies for
  // the people who should hear you are switched on while you talk, so channel
  // and direct conversations never reach anyone else's device.
  const peerMicsRef = useRef({}); // peerId -> MediaStream
  const audiosRef = useRef({}); // peerId -> HTMLAudioElement
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

  // Play audio from peers on our channel, or anyone talking to us directly.
  const applyAudio = useCallback(() => {
    const { volume, muted } = outputRef.current;
    const myChannel = selfRef.current.channel;
    Object.entries(audiosRef.current).forEach(([peerId, audio]) => {
      const peer = peersRef.current[peerId];
      const forMe =
        peer &&
        (peer.to === selfId || (!peer.to && peer.channel === myChannel));
      audio.volume = volume;
      audio.muted = muted || !forMe;
    });
  }, []);

  // Give a teammate their own (switched-off) copy of our microphone.
  const sendMicTo = useCallback((room, peerId) => {
    const mic = streamRef.current;
    if (!mic || peerMicsRef.current[peerId]) return;
    const copy = mic.clone();
    copy.getAudioTracks().forEach((t) => (t.enabled = false));
    peerMicsRef.current[peerId] = copy;
    room.addStream(copy, { target: peerId });
  }, []);

  const dropMicFor = useCallback((peerId) => {
    peerMicsRef.current[peerId]?.getTracks().forEach((t) => t.stop());
    delete peerMicsRef.current[peerId];
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
  const lastJoinRef = useRef(null); // { team, passcode } for reconnect()
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
    Object.keys(peerMicsRef.current).forEach(dropMicFor);
    Object.values(audiosRef.current).forEach((a) => {
      a.pause();
      a.srcObject = null;
      a.remove();
    });
    audiosRef.current = {};
    selfRef.current.talking = false;
    selfRef.current.to = null;
    setPeers({});
    setTransmitting(false);
    setMicState("off");
    setStatus("offline");
  }, [dropMicFor]);

  const connect = useCallback(
    async ({ team, passcode, name, channel }) => {
      if (roomRef.current) return;
      selfRef.current = { team, name, channel, talking: false, to: null };
      lastJoinRef.current = { team, passcode };
      failuresRef.current = { count: 0, last: "" };
      setStatus("connecting");
      setMessages(loadHistory(team));
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
      const turnServers = [...(TURN_CONFIG || []), ...turn.iceServers];
      if (turnServers.length) config.turnConfig = turnServers;
      turnSourceRef.current = turn.provider
        ? turn.provider
        : TURN_CONFIG
          ? "build settings"
          : null;
      if (passcode) config.password = passcode;

      const room = joinRoom(config, team, {
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
      actionsRef.current = {
        presence: presenceAction,
        chat: chatAction,
        history: historyAction,
      };

      room.onPeerJoin = (peerId) => {
        presenceAction.send(
          presenceOf(selfRef.current, linksOf(peersRef.current)),
          {
            target: peerId,
          },
        );
        const history = messagesRef.current.filter((m) => m.type !== "system");
        if (history.length) historyAction.send(history, { target: peerId });
        // A join is always a fresh connection - even for a peer ID we've
        // seen before (their tab reconnected before we noticed them leave) -
        // so replace any mic copy tied to the old connection.
        dropMicFor(peerId);
        sendMicTo(room, peerId);
      };

      room.onPeerLeave = (peerId) => {
        const peer = peersRef.current[peerId];
        if (peer) addSystem(`${peer.name} left`);
        dropMicFor(peerId);
        const audio = audiosRef.current[peerId];
        if (audio) {
          audio.pause();
          audio.srcObject = null;
          audio.remove();
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
        setMessages((prev) =>
          mergeMessages(prev, [{ ...msg, text: msg.text.slice(0, 1000) }]),
        );
      };

      historyAction.onMessage = (list) => {
        if (!Array.isArray(list)) return;
        setMessages((prev) =>
          mergeMessages(
            prev,
            list.filter((m) => m && typeof m.text === "string"),
          ),
        );
      };

      room.onPeerStream = (stream, peerId) => {
        let audio = audiosRef.current[peerId];
        if (!audio) {
          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.playsInline = true;
          audio.setAttribute("playsinline", "");
          getAudioHost().appendChild(audio);
          audiosRef.current[peerId] = audio;
        }
        audio.srcObject = stream;
        applyAudio();
        audio.play().catch(() => {});
        tuneForLowLatency(room.getPeers()[peerId]);
      };

      setStatus("online");
      addSystem(`Joined team "${team}" - waiting for teammates`);

      // Ask for the microphone. Text still works if the user says no.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        if (roomRef.current !== room) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        streamRef.current = stream;
        Object.keys(room.getPeers()).forEach((id) => sendMicTo(room, id));
        setMicState("ready");
      } catch {
        setMicState("denied");
        addSystem(
          "Microphone unavailable - you can still listen and send text. Allow mic access in your browser settings to talk.",
        );
      }
    },
    [addSystem, applyAudio, sendMicTo, dropMicFor, warnOnce],
  );

  useEffect(() => disconnect, [disconnect]);

  // Persist chat history per team so it survives a page reload.
  useEffect(() => {
    if (selfRef.current.team && status === "online") {
      saveHistory(selfRef.current.team, messages);
    }
  }, [messages, status]);

  // Talk to everyone on our channel, or only to `targetId` if given.
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
      recipients.forEach((id) =>
        peerMicsRef.current[id]
          ?.getAudioTracks()
          .forEach((t) => (t.enabled = true)),
      );
      setTransmitting(true);
      chirp(1200);
    },
    [broadcastPresence],
  );

  const stopTalking = useCallback(() => {
    if (!selfRef.current.talking) return;
    Object.values(peerMicsRef.current).forEach((s) =>
      s.getAudioTracks().forEach((t) => (t.enabled = false)),
    );
    selfRef.current.talking = false;
    selfRef.current.to = null;
    setTransmitting(false);
    chirp(700);
    broadcastPresence();
  }, [broadcastPresence]);

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

  const clearHistory = useCallback(() => {
    setMessages([]);
    try {
      localStorage.removeItem(storageKey(selfRef.current.team));
    } catch {
      // ignore
    }
  }, []);

  // Snapshot of connection health for the diagnostics panel.
  const getDiagnostics = useCallback(() => {
    const sockets = roomRef.current ? getRelaySockets() : {};
    const relays = RELAY_URLS.map((url) => {
      const ws = sockets[url];
      const state = ws
        ? ["connecting", "connected", "closing", "closed"][ws.readyState]
        : "not started";
      return { url: url.replace("wss://", ""), state };
    });
    const connections = roomRef.current ? roomRef.current.getPeers() : {};
    const peerRows = Object.entries(connections).map(([peerId, pc]) => {
      const audio = audiosRef.current[peerId];
      return {
        peerId,
        name: peersRef.current[peerId]?.name || "(unknown)",
        connection: pc?.connectionState || "unknown",
        audio: !audio
          ? "no audio yet"
          : audio.paused
            ? "blocked - tap to enable"
            : audio.muted
              ? "muted (other channel)"
              : "playing",
      };
    });
    return {
      relays,
      peers: peerRows,
      failures: failuresRef.current,
      wakeLock,
      micState,
      turn: turnSourceRef.current,
      secure: window.isSecureContext,
    };
  }, [micState, wakeLock]);

  // Leave and rejoin with the same name, team, and channel.
  const reconnect = useCallback(async () => {
    const last = lastJoinRef.current;
    if (!last) return;
    const { name, channel } = selfRef.current;
    disconnect();
    await connect({ ...last, name, channel });
  }, [connect, disconnect]);

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

  const getMicStream = useCallback(() => streamRef.current, []);

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
    getMicStream,
    getLatency,
    reconnect,
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
