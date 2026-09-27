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
export const TURN_CONFIGURED = TURN_URLS.length > 0;
const TURN_CONFIG = TURN_CONFIGURED
  ? [
      {
        urls: TURN_URLS,
        username: process.env.REACT_APP_TURN_USERNAME || "",
        credential: process.env.REACT_APP_TURN_CREDENTIAL || "",
      },
    ]
  : undefined;

const now = () => Date.now();

const presenceOf = ({ name, channel, talking }) => ({ name, channel, talking });

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
  const [peers, setPeers] = useState({}); // peerId -> { name, channel, talking }
  const [messages, setMessages] = useState([]);
  const [micState, setMicState] = useState("off"); // off | ready | denied
  const [transmitting, setTransmitting] = useState(false);

  const roomRef = useRef(null);
  const actionsRef = useRef(null);
  const streamRef = useRef(null);
  const audiosRef = useRef({}); // peerId -> HTMLAudioElement
  const selfRef = useRef({ name: "", channel: 1, talking: false, team: "" });
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

  // Only play audio from peers who are on the same channel as us.
  const applyAudio = useCallback(() => {
    const { volume, muted } = outputRef.current;
    const myChannel = selfRef.current.channel;
    Object.entries(audiosRef.current).forEach(([peerId, audio]) => {
      const peer = peersRef.current[peerId];
      audio.volume = volume;
      audio.muted = muted || !peer || peer.channel !== myChannel;
    });
  }, []);

  useEffect(applyAudio, [peers, applyAudio]);

  const broadcastPresence = useCallback(() => {
    actionsRef.current?.presence.send(presenceOf(selfRef.current));
  }, []);

  const disconnect = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    actionsRef.current = null;
    if (room) room.leave();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    Object.values(audiosRef.current).forEach((a) => {
      a.pause();
      a.srcObject = null;
      a.remove();
    });
    audiosRef.current = {};
    selfRef.current.talking = false;
    setPeers({});
    setTransmitting(false);
    setMicState("off");
    setStatus("offline");
  }, []);

  const connect = useCallback(
    async ({ team, passcode, name, channel }) => {
      if (roomRef.current) return;
      selfRef.current = { team, name, channel, talking: false };
      setStatus("connecting");
      setMessages(loadHistory(team));

      const config = {
        appId: APP_ID,
        relayConfig: { urls: RELAY_URLS },
      };
      if (TURN_CONFIG) config.turnConfig = TURN_CONFIG;
      if (passcode) config.password = passcode;

      const room = joinRoom(config, team, {
        onJoinError: ({ error }) => {
          const reason = String(error?.message || error || "");
          addSystem(
            /password|decrypt/i.test(reason)
              ? "A teammate could not connect: passcodes do not match."
              : "A teammate could not connect (their network may block direct connections).",
          );
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
        presenceAction.send(presenceOf(selfRef.current), { target: peerId });
        const history = messagesRef.current.filter((m) => m.type !== "system");
        if (history.length) historyAction.send(history, { target: peerId });
        if (streamRef.current) {
          room.addStream(streamRef.current, { target: peerId });
        }
      };

      room.onPeerLeave = (peerId) => {
        const peer = peersRef.current[peerId];
        if (peer) addSystem(`${peer.name} left`);
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
        };
        const previous = peersRef.current[peerId];
        if (!previous) addSystem(`${info.name} joined`);
        if (
          info.talking &&
          !previous?.talking &&
          info.channel === selfRef.current.channel &&
          !outputRef.current.muted
        ) {
          chirp(880);
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
        room.addStream(stream);
        setMicState("ready");
      } catch {
        setMicState("denied");
        addSystem(
          "Microphone unavailable - you can still listen and send text. Allow mic access in your browser settings to talk.",
        );
      }
    },
    [addSystem, applyAudio],
  );

  useEffect(() => disconnect, [disconnect]);

  // Persist chat history per team so it survives a page reload.
  useEffect(() => {
    if (selfRef.current.team && status === "online") {
      saveHistory(selfRef.current.team, messages);
    }
  }, [messages, status]);

  const startTalking = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || selfRef.current.talking) return;
    stream.getAudioTracks().forEach((t) => (t.enabled = true));
    selfRef.current.talking = true;
    setTransmitting(true);
    chirp(1200);
    broadcastPresence();
  }, [broadcastPresence]);

  const stopTalking = useCallback(() => {
    const stream = streamRef.current;
    if (!selfRef.current.talking) return;
    stream?.getAudioTracks().forEach((t) => (t.enabled = false));
    selfRef.current.talking = false;
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
      micState,
      turn: TURN_CONFIGURED,
      secure: window.isSecureContext,
    };
  }, [micState]);

  const getMicStream = useCallback(() => streamRef.current, []);

  return {
    selfId,
    getDiagnostics,
    getMicStream,
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
