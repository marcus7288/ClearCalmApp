import { useCallback, useEffect, useRef, useState } from "react";
import { joinRoom, selfId } from "trystero";

// Everyone using the same team code joins one peer-to-peer room. Peers find
// each other through public Nostr relays (signaling only); voice and text then
// flow directly between browsers over encrypted WebRTC connections, so no
// server of our own is needed and the app can be hosted as a static site.
const APP_ID = "clearcalm-comm-v1";
const HISTORY_LIMIT = 100;

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
      JSON.stringify(messages.filter((m) => m.type !== "system"))
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

// A short radio "chirp" so people know when a transmission starts and ends.
let audioCtx;
export const chirp = (freq) => {
  try {
    audioCtx =
      audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // Web Audio unavailable - silently skip the chirp.
  }
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
      ])
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

      const config = { appId: APP_ID };
      if (passcode) config.password = passcode;

      const room = joinRoom(config, team, {
        onJoinError: ({ error }) => {
          const reason = String(error?.message || error || "");
          addSystem(
            /password|decrypt/i.test(reason)
              ? "A teammate could not connect: passcodes do not match."
              : "A teammate could not connect (their network may block direct connections)."
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
          mergeMessages(prev, [{ ...msg, text: msg.text.slice(0, 1000) }])
        );
      };

      historyAction.onMessage = (list) => {
        if (!Array.isArray(list)) return;
        setMessages((prev) =>
          mergeMessages(
            prev,
            list.filter((m) => m && typeof m.text === "string")
          )
        );
      };

      room.onPeerStream = (stream, peerId) => {
        let audio = audiosRef.current[peerId];
        if (!audio) {
          audio = new Audio();
          audio.autoplay = true;
          audio.playsInline = true;
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
          "Microphone unavailable - you can still listen and send text. Allow mic access in your browser settings to talk."
        );
      }
    },
    [addSystem, applyAudio]
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
    [applyAudio, broadcastPresence]
  );

  const setName = useCallback(
    (name) => {
      selfRef.current.name = name;
      broadcastPresence();
    },
    [broadcastPresence]
  );

  const setOutput = useCallback(
    ({ volume, muted }) => {
      outputRef.current = { volume, muted };
      applyAudio();
    },
    [applyAudio]
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    try {
      localStorage.removeItem(storageKey(selfRef.current.team));
    } catch {
      // ignore
    }
  }, []);

  return {
    selfId,
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
