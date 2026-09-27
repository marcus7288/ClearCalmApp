import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  LogOut,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Send,
  Settings,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import useComm, { chirp, isAudioBlocked, unlockAudio } from "./useComm";

// Netlify sets COMMIT_REF during the build (see netlify.toml), so the app can
// show exactly which version is deployed.
const BUILD = `v2 · ${(process.env.REACT_APP_COMMIT_REF || "dev").slice(0, 7)}`;

// Only mention the Space-bar shortcut on devices with a mouse/trackpad.
const hasKeyboard =
  typeof window !== "undefined" &&
  window.matchMedia?.("(pointer: fine)").matches;

const AUTOJOIN_KEY = "clearcalm:autojoin";

const CHANNELS = [
  { id: 1, name: "Channel 1" },
  { id: 2, name: "Channel 2" },
  { id: 3, name: "Channel 3" },
  { id: 4, name: "Emergency", emergency: true },
];
const EMERGENCY_ID = 4;

const formatTime = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

// Team codes become the room name, so keep them simple and case-insensitive.
const normalizeTeam = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const readInvite = () => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return { team: params.get("team") || "", passcode: params.get("key") || "" };
};

const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem("clearcalm:prefs")) || {};
  } catch {
    return {};
  }
};

const savePrefs = (prefs) => {
  try {
    localStorage.setItem("clearcalm:prefs", JSON.stringify(prefs));
  } catch {
    // ignore
  }
};

const inviteLink = (team, passcode) => {
  const params = new URLSearchParams({ team });
  if (passcode) params.set("key", passcode);
  return `${window.location.origin}${window.location.pathname}#${params}`;
};

const JoinScreen = ({ onJoin }) => {
  const prefs = useMemo(loadPrefs, []);
  const invite = useMemo(readInvite, []);
  const [name, setName] = useState(prefs.name || "");
  const [team, setTeam] = useState(invite.team || prefs.team || "");
  const [passcode, setPasscode] = useState(
    invite.passcode || prefs.passcode || "",
  );
  const teamCode = normalizeTeam(team);
  const canJoin = name.trim() && teamCode.length >= 3;

  const submit = (e) => {
    e.preventDefault();
    if (!canJoin) return;
    onJoin({ name: name.trim().slice(0, 40), team: teamCode, passcode });
  };

  return (
    <div className="max-w-md mx-auto bg-slate-900 text-white min-h-screen flex flex-col justify-center p-6">
      <div className="text-center mb-8">
        <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center mx-auto mb-4">
          <Mic className="w-8 h-8" />
        </div>
        <h1 className="text-2xl font-semibold">Clear Calm</h1>
        <p className="text-slate-400 text-sm mt-1">
          Push-to-talk and text for your team
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm text-slate-300">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sarah - Parking Lot"
            maxLength={40}
            autoComplete="name"
            className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 focus:outline-none focus:border-blue-500"
          />
        </label>

        <label className="block">
          <span className="text-sm text-slate-300">Team code</span>
          <input
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            placeholder="e.g. firstchurch-security"
            maxLength={40}
            autoCapitalize="none"
            autoCorrect="off"
            className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 focus:outline-none focus:border-blue-500"
          />
          <span className="text-xs text-slate-500">
            Everyone with the same code joins the same team (3+ letters).
          </span>
        </label>

        <label className="block">
          <span className="text-sm text-slate-300">
            Passcode <span className="text-slate-500">(recommended)</span>
          </span>
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Shared secret for your team"
            autoComplete="off"
            className="mt-1 w-full rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 focus:outline-none focus:border-blue-500"
          />
          <span className="text-xs text-slate-500">
            Only people with the same passcode can connect to your team.
          </span>
        </label>

        <button
          type="submit"
          disabled={!canJoin}
          className="w-full flex items-center justify-center gap-2 rounded-lg py-3 font-medium bg-green-600 hover:bg-green-700 disabled:bg-slate-700 disabled:text-slate-400"
        >
          <Phone className="w-5 h-5" /> Connect
        </button>
      </form>

      <p className="text-xs text-slate-500 mt-6 text-center">
        Voice and messages travel directly between devices over encrypted
        connections. Your browser will ask for microphone access.
      </p>
      <p className="text-xs text-slate-600 mt-2 text-center">{BUILD}</p>
    </div>
  );
};

const stateColor = (state) =>
  ["connected", "playing"].includes(state)
    ? "text-green-400"
    : ["connecting", "new", "checking", "muted (other channel)"].includes(state)
      ? "text-yellow-400"
      : "text-red-400";

const AudioCheck = ({ comm }) => {
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);

  const { startMicTest, activeMic } = comm;
  useEffect(() => {
    if (!testing) return undefined;
    const meter = startMicTest();
    if (!meter) return undefined;
    let frame;
    const tick = () => {
      setLevel(meter.read());
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      meter.stop();
      setLevel(0);
    };
    // activeMic: restart the meter when the microphone changes.
  }, [testing, startMicTest, activeMic]);

  return (
    <div>
      <p className="text-sm text-slate-300 mb-2">Microphone / headphones</p>
      <select
        value={comm.micChoice}
        onChange={(e) => comm.switchMic(e.target.value)}
        disabled={comm.micState !== "ready"}
        className="w-full mb-1 rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm"
      >
        <option value="auto">Automatic - use headphones when connected</option>
        {comm.mics.map((m) => (
          <option key={m.deviceId} value={m.deviceId}>
            {m.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-slate-500 mb-4">
        In use: {comm.activeMic || "none"}. On iPhone, sound plays through the
        same device as the microphone, so choose your Bluetooth headphones here
        to hear through them.
      </p>

      <p className="text-sm text-slate-300 mb-2">Audio check</p>
      <div className="flex gap-2">
        <button
          onClick={() => {
            unlockAudio();
            chirp(660, 0.6, 0.3);
          }}
          className="flex-1 rounded-lg py-2 bg-slate-700 hover:bg-slate-600 text-sm"
        >
          Test speaker (beep)
        </button>
        <button
          onClick={() => setTesting((t) => !t)}
          disabled={comm.micState !== "ready"}
          className="flex-1 rounded-lg py-2 bg-slate-700 hover:bg-slate-600 text-sm disabled:text-slate-500"
        >
          {testing ? "Stop mic test" : "Test microphone"}
        </button>
      </div>
      {testing && (
        <div className="mt-2">
          <div className="h-3 rounded bg-slate-900 overflow-hidden">
            <div
              className="h-full bg-green-500 transition-[width] duration-75"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Speak - the bar should move. This only tests your mic; nothing is
            sent to the team.
          </p>
        </div>
      )}
      {comm.micState === "denied" && (
        <p className="text-xs text-red-400 mt-2">
          Microphone blocked. Allow it for this site in your browser settings,
          then leave and rejoin the team.
        </p>
      )}
    </div>
  );
};

const Diagnostics = ({ comm, onReconnect }) => {
  const [diag, setDiag] = useState(comm.getDiagnostics);
  const [reconnecting, setReconnecting] = useState(false);
  const [latency, setLatency] = useState({});

  useEffect(() => {
    let alive = true;
    const id = setInterval(() => {
      setDiag(comm.getDiagnostics());
      comm.getLatency().then((l) => alive && setLatency(l));
    }, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [comm]);

  const relaysUp = diag.relays.filter((r) => r.state === "connected").length;

  return (
    <div>
      <p className="text-sm text-slate-300 mb-2">Connection</p>
      <div className="rounded-lg bg-slate-900 p-3 text-xs space-y-2">
        <div>
          <span className={relaysUp ? "text-green-400" : "text-red-400"}>
            Relays: {relaysUp} of {diag.relays.length} connected
          </span>
          {!relaysUp && (
            <p className="text-slate-400">
              Can't reach any relay - this network may block them. Try another
              Wi-Fi network or cellular data.
            </p>
          )}
        </div>
        <div>
          <span className="text-slate-300">
            Teammates connected: {diag.peers.length}
          </span>
          {diag.peers.map((p) => (
            <div key={p.peerId} className="flex justify-between gap-2">
              <span className="truncate">{p.name}</span>
              <span className={stateColor(p.connection)}>{p.connection}</span>
              <span className={stateColor(p.audio)}>{p.audio}</span>
            </div>
          ))}
          {diag.peers.map((p) => {
            const l = latency[p.peerId];
            if (!l || (l.rttMs == null && l.bufferMs == null)) return null;
            const oneWay =
              l.rttMs != null
                ? Math.round(l.rttMs / 2) + (l.bufferMs || 0)
                : null;
            return (
              <div key={`${p.peerId}-lat`} className="text-slate-400">
                Delay from {p.name}: network{" "}
                {l.rttMs != null ? `${Math.round(l.rttMs / 2)} ms` : "?"}
                {" + "}buffer {l.bufferMs != null ? `${l.bufferMs} ms` : "?"}
                {oneWay != null && (
                  <span
                    className={
                      oneWay > 300 ? "text-yellow-400" : "text-green-400"
                    }
                  >
                    {" "}
                    ≈ {oneWay} ms
                  </span>
                )}
                {l.viaRelay && " (via TURN relay)"}
              </div>
            );
          })}
          {!diag.peers.length && relaysUp > 0 && (
            <p className="text-slate-400">
              Waiting for teammates. Check they use the same team code and
              passcode.
            </p>
          )}
        </div>
        <div className="text-slate-400">
          Mic: {diag.micState}
          {diag.mic ? ` (${diag.mic})` : ""} · TURN relay:{" "}
          {diag.turn ? `on (${diag.turn})` : "not set up"} · HTTPS:{" "}
          {diag.secure ? "yes" : "no (mic will not work)"} · Screen awake:{" "}
          {diag.wakeLock === "unsupported" ? "not supported" : diag.wakeLock}
        </div>
        {diag.failures.count > 0 && (
          <div className="text-slate-400">
            Failed connection attempts: {diag.failures.count}
            <div className="text-slate-500 break-words">
              Last: {diag.failures.last}
            </div>
            <div className="text-slate-500">
              A few are normal (a phone sleeping, a network switch). Many, with
              no teammates connected, usually means a TURN relay is needed.
            </div>
          </div>
        )}
      </div>
      <button
        onClick={async () => {
          setReconnecting(true);
          onReconnect();
        }}
        disabled={reconnecting}
        className="mt-2 w-full rounded-lg py-2 bg-slate-700 hover:bg-slate-600 text-sm disabled:text-slate-500"
      >
        {reconnecting ? "Reconnecting..." : "Reconnect"}
      </button>
    </div>
  );
};

const SettingsPanel = ({
  session,
  comm,
  volume,
  onVolume,
  onRename,
  onLeave,
  onReconnect,
  onClose,
}) => {
  const [name, setName] = useState(session.name);
  const [copied, setCopied] = useState(false);
  const link = inviteLink(session.team, session.passcode);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this invite link:", link);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-10">
      <div className="bg-slate-800 w-full max-w-md max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">Settings</h2>
          <button onClick={onClose} aria-label="Close settings">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onRename(name.trim().slice(0, 40));
          }}
          className="flex gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            className="flex-1 rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 focus:outline-none focus:border-blue-500"
          />
          <button className="px-4 rounded-lg bg-blue-600 hover:bg-blue-700">
            Rename
          </button>
        </form>

        <div>
          <p className="text-sm text-slate-300 mb-2">
            Invite teammates to <b>{session.team}</b>
          </p>
          <button
            onClick={copy}
            className="w-full flex items-center justify-center gap-2 rounded-lg py-2 bg-slate-700 hover:bg-slate-600"
          >
            {copied ? (
              <Check className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
            {copied ? "Link copied" : "Copy invite link"}
          </button>
          {session.passcode && (
            <p className="text-xs text-slate-500 mt-2">
              The link includes your passcode - share it only with your team.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={comm.clearHistory}
            className="flex-1 rounded-lg py-2 bg-slate-700 hover:bg-slate-600 text-sm"
          >
            Clear my message history
          </button>
          <button
            onClick={onLeave}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg py-2 bg-red-600 hover:bg-red-700 text-sm"
          >
            <LogOut className="w-4 h-4" /> Leave team
          </button>
        </div>

        <div>
          <p className="text-sm text-slate-300 mb-2">Volume: {volume}%</p>
          <div className="flex items-center space-x-3">
            <VolumeX className="w-5 h-5 text-slate-400" />
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
              aria-label="Volume"
              className="flex-1 h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer"
            />
            <Volume2 className="w-5 h-5 text-slate-400" />
          </div>
        </div>

        <AudioCheck comm={comm} />
        <Diagnostics comm={comm} onReconnect={onReconnect} />

        <p className="text-xs text-slate-500 text-center">Clear Calm {BUILD}</p>
      </div>
    </div>
  );
};

const ClearCalmCommApp = () => {
  const comm = useComm();
  const {
    status,
    peers,
    messages,
    micState,
    transmitting,
    startTalking,
    stopTalking,
    setOutput,
  } = comm;

  const [session, setSession] = useState(null);
  const [selectedChannel, setSelectedChannel] = useState(1);
  const [volume, setVolume] = useState(75);
  const [isMuted, setIsMuted] = useState(false);
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [directTo, setDirectTo] = useState(null); // peer ID for private talk
  const feedRef = useRef(null);

  const isConnected = status === "online";
  const canTalk = isConnected && micState === "ready";

  useEffect(() => {
    setOutput({ volume: volume / 100, muted: isMuted });
  }, [volume, isMuted, setOutput]);

  const peerList = Object.entries(peers).map(([id, p]) => ({ id, ...p }));
  const channelCounts = CHANNELS.reduce((acc, c) => {
    acc[c.id] =
      peerList.filter((p) => p.channel === c.id).length +
      (session && selectedChannel === c.id ? 1 : 0);
    return acc;
  }, {});
  const onChannel = peerList.filter((p) => p.channel === selectedChannel);
  const elsewhere = peerList.filter((p) => p.channel !== selectedChannel);
  // People we can hear right now: channel talk on our channel, or anyone
  // talking to us directly.
  const talkers = peerList.filter(
    (p) =>
      p.talking &&
      (p.to === comm.selfId || (!p.to && p.channel === selectedChannel)),
  );
  const directPeer = directTo ? peers[directTo] : null;

  // Teammates that others are connected to but we aren't: a network between
  // us is blocking a direct link (a TURN relay fixes this).
  const unlinked = [];
  const seenIds = new Set([comm.selfId, ...Object.keys(peers)]);
  peerList.forEach((p) =>
    Object.entries(p.links || {}).forEach(([id, name]) => {
      if (seenIds.has(id)) return;
      seenIds.add(id);
      unlinked.push({ id, name });
    }),
  );

  // Drop the direct target if that person leaves.
  useEffect(() => {
    if (directTo && !peers[directTo]) setDirectTo(null);
  }, [directTo, peers]);

  // Show this channel's messages, system notices, and anything sent to
  // Emergency (which everyone sees, whatever channel they're on).
  const visibleMessages = messages.filter(
    (m) =>
      m.type === "system" ||
      m.channel === selectedChannel ||
      m.channel === EMERGENCY_ID,
  );

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleMessages.length]);

  // Hold the space bar to talk (when not typing in a text box).
  useEffect(() => {
    if (!canTalk) return undefined;
    const typing = (e) =>
      ["INPUT", "TEXTAREA"].includes(e.target.tagName) ||
      e.target.isContentEditable;
    const down = (e) => {
      if (e.code !== "Space" || e.repeat || typing(e)) return;
      e.preventDefault();
      startTalking(directTo);
    };
    const up = (e) => {
      if (e.code !== "Space" || typing(e)) return;
      e.preventDefault();
      stopTalking();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stopTalking);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stopTalking);
    };
  }, [canTalk, startTalking, stopTalking, directTo]);

  const join = ({ name, team, passcode, channel = selectedChannel }) => {
    unlockAudio();
    savePrefs({ name, team, passcode });
    setSelectedChannel(channel);
    setSession({ name, team, passcode });
    comm.connect({ name, team, passcode, channel });
  };

  // Leaving and reconnecting reload the page. That gives this device a fresh
  // identity and fresh connections, so teammates can't hand back a stale
  // connection from before (which left a reconnected person without audio).
  const reloadSoon = () => {
    comm.disconnect();
    setTimeout(() => window.location.reload(), 300);
  };

  const leave = () => {
    setShowSettings(false);
    reloadSoon();
  };

  const reconnect = () => {
    try {
      sessionStorage.setItem(
        AUTOJOIN_KEY,
        JSON.stringify({ ...session, channel: selectedChannel }),
      );
    } catch {
      // ignore - they'll just see the join screen
    }
    reloadSoon();
  };

  // After a Reconnect reload, rejoin automatically.
  useEffect(() => {
    let auto = null;
    try {
      auto = JSON.parse(sessionStorage.getItem(AUTOJOIN_KEY));
      sessionStorage.removeItem(AUTOJOIN_KEY);
    } catch {
      // ignore
    }
    if (auto?.name && auto?.team) join(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browsers only allow sound after a tap. Show a clear prompt until then
  // (mostly needed on iPhones, and after an automatic rejoin).
  const [soundBlocked, setSoundBlocked] = useState(false);
  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => setSoundBlocked(isAudioBlocked()), 1000);
    return () => clearInterval(id);
  }, [session]);

  const rename = (name) => {
    savePrefs({ ...loadPrefs(), name });
    setSession((s) => ({ ...s, name }));
    comm.setName(name);
    setShowSettings(false);
  };

  const switchChannel = (channelId) => {
    if (transmitting) stopTalking();
    setDirectTo(null);
    setSelectedChannel(channelId);
    comm.setChannel(channelId);
  };

  const sendDraft = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    comm.sendText(draft);
    setDraft("");
  };

  // Any tap lets the browser start incoming audio (required on iPhones).
  useEffect(() => {
    if (!session) return undefined;
    window.addEventListener("pointerdown", unlockAudio, true);
    window.addEventListener("keydown", unlockAudio, true);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio, true);
      window.removeEventListener("keydown", unlockAudio, true);
    };
  }, [session]);

  const pttDown = (e) => {
    if (!canTalk) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startTalking(directTo);
  };

  if (!session) return <JoinScreen onJoin={join} />;

  const current = CHANNELS.find((c) => c.id === selectedChannel);

  return (
    <div className="fixed inset-0 bg-slate-900 text-white overflow-hidden">
      <div className="max-w-md mx-auto h-full flex flex-col">
        {/* Header */}
        <div className="bg-slate-800 p-4 flex items-center justify-between border-b border-slate-700">
          <div className="flex items-center space-x-3 min-w-0">
            <div
              className={`w-3 h-3 shrink-0 rounded-full ${
                isConnected
                  ? peerList.length
                    ? "bg-green-500"
                    : "bg-yellow-500"
                  : "bg-red-500"
              }`}
            ></div>
            <div className="min-w-0">
              <h1 className="font-semibold text-lg">Clear Calm</h1>
              <p className="text-xs text-slate-400 truncate">
                {isConnected
                  ? `${session.team} · ${current.name} · ${session.name}`
                  : "Connecting..."}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            className="p-1"
          >
            <Settings className="w-6 h-6 text-slate-400" />
          </button>
        </div>

        {/* Status Bar */}
        <div className="bg-slate-800 px-4 py-2 border-b border-slate-700">
          <div className="flex items-center justify-between text-sm gap-2">
            <div className="flex items-center space-x-4">
              {isMuted && <span className="text-red-300">Speaker muted</span>}
              <div className="flex items-center space-x-1" title="Team online">
                <Users className="w-4 h-4" />
                <span className="text-slate-300">{peerList.length + 1}</span>
              </div>
            </div>
            <div
              className={`px-2 py-1 rounded text-xs font-medium truncate ${
                transmitting
                  ? directPeer
                    ? "bg-purple-600"
                    : "bg-red-600"
                  : talkers.length
                    ? talkers.some((t) => t.to === comm.selfId)
                      ? "bg-purple-600"
                      : "bg-amber-600"
                    : isConnected
                      ? "bg-green-600"
                      : "bg-slate-600"
              }`}
            >
              {transmitting
                ? directPeer
                  ? `TALKING TO ${directPeer.name.toUpperCase()}`
                  : "TRANSMITTING"
                : talkers.length
                  ? `${talkers
                      .map((t) =>
                        t.to === comm.selfId ? `${t.name} (to you)` : t.name,
                      )
                      .join(", ")} TALKING`
                  : isConnected
                    ? peerList.length
                      ? "READY"
                      : "WAITING FOR TEAM"
                    : "OFFLINE"}
            </div>
          </div>
        </div>

        {/* Direct (private) talk banner */}
        {directPeer && (
          <div className="px-4 py-2 bg-purple-900/60 border-b border-purple-500 flex items-center justify-between gap-2">
            <span className="text-sm text-purple-100 truncate">
              <b>Direct to {directPeer.name}</b> - only they will hear you
            </span>
            <button
              onClick={() => setDirectTo(null)}
              className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 shrink-0"
            >
              Back to channel
            </button>
          </div>
        )}

        {soundBlocked && (
          <button
            onClick={() => {
              unlockAudio();
              chirp(660, 0.15, 0.2);
              setSoundBlocked(isAudioBlocked());
            }}
            className="w-full px-4 py-2 bg-amber-500 text-slate-900 text-sm font-semibold"
          >
            Tap here to turn on sound
          </button>
        )}

        {/* Talk controls - near the top so the button is easy to reach and
          away from the phone's bottom-edge scroll and home gestures */}
        <div className="px-4 py-3 bg-slate-800 border-b border-slate-700">
          {/* Main Controls */}
          <div className="flex items-center justify-between">
            {/* Leave */}
            <button
              onClick={() => {
                if (window.confirm("Leave the team?")) leave();
              }}
              aria-label="Disconnect"
              className="p-3 rounded-full transition-all bg-red-600 hover:bg-red-700"
            >
              <PhoneOff className="w-6 h-6" />
            </button>

            {/* Push-to-Talk Button */}
            <div className="flex flex-col items-center">
              <button
                onPointerDown={pttDown}
                onPointerUp={stopTalking}
                onPointerCancel={stopTalking}
                onLostPointerCapture={stopTalking}
                onContextMenu={(e) => e.preventDefault()}
                disabled={!canTalk}
                aria-label={
                  directPeer
                    ? `Hold to talk to ${directPeer.name}`
                    : "Hold to talk"
                }
                style={{ touchAction: "none", WebkitUserSelect: "none" }}
                className={`w-28 h-28 rounded-full transition-all duration-150 select-none ${
                  transmitting
                    ? directPeer
                      ? "bg-purple-500 scale-110 shadow-lg shadow-purple-500/50"
                      : "bg-red-500 scale-110 shadow-lg shadow-red-500/50"
                    : canTalk
                      ? directPeer
                        ? "bg-purple-600 hover:bg-purple-700"
                        : "bg-blue-600 hover:bg-blue-700"
                      : "bg-slate-600 cursor-not-allowed"
                }`}
              >
                {micState === "denied" ? (
                  <MicOff className="w-12 h-12 mx-auto" />
                ) : (
                  <Mic className="w-12 h-12 mx-auto" />
                )}
              </button>
              <span className="text-sm text-slate-300 mt-2">
                {micState === "denied"
                  ? "Mic blocked"
                  : !canTalk
                    ? "Starting mic..."
                    : transmitting
                      ? "Release to stop"
                      : directPeer
                        ? `Hold to talk to ${directPeer.name}`
                        : hasKeyboard
                          ? "Hold to talk (or Space)"
                          : "Hold to talk"}
              </span>
            </div>

            {/* Speaker Mute Toggle */}
            <button
              onClick={() => setIsMuted(!isMuted)}
              aria-label={isMuted ? "Unmute speaker" : "Mute speaker"}
              className={`p-3 rounded-full transition-all ${
                isMuted ? "bg-red-600" : "bg-slate-600 hover:bg-slate-700"
              }`}
            >
              {isMuted ? (
                <VolumeX className="w-6 h-6" />
              ) : (
                <Volume2 className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>

        {/* Channel Selection */}
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="grid grid-cols-4 gap-2">
            {CHANNELS.map((channel) => (
              <button
                key={channel.id}
                onClick={() => switchChannel(channel.id)}
                className={`px-1 py-2 rounded-lg border transition-all ${
                  selectedChannel === channel.id
                    ? channel.emergency
                      ? "border-red-500 bg-red-500/20 text-red-300"
                      : "border-blue-500 bg-blue-500/20 text-blue-300"
                    : "border-slate-600 bg-slate-800 hover:bg-slate-700"
                }`}
              >
                <div className="text-xs font-medium whitespace-nowrap">
                  {channel.emergency ? "Emergency" : `Ch ${channel.id}`}
                </div>
                <div className="text-xs text-slate-400">
                  {channelCounts[channel.id]} on
                </div>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1 mt-3">
            <span className="text-xs px-2 py-1 rounded-full bg-blue-600/30 text-blue-200">
              {session.name} (you)
            </span>
            {[...onChannel, ...elsewhere].map((p) => {
              const hearing =
                p.talking &&
                (p.to === comm.selfId ||
                  (!p.to && p.channel === selectedChannel));
              return (
                <button
                  key={p.id}
                  onClick={() => setDirectTo(directTo === p.id ? null : p.id)}
                  title={`Talk privately to ${p.name}`}
                  className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 border ${
                    directTo === p.id
                      ? "border-purple-400 bg-purple-600 text-white"
                      : hearing
                        ? "border-transparent bg-amber-500 text-slate-900"
                        : p.channel === selectedChannel
                          ? "border-transparent bg-slate-700 text-slate-200"
                          : "border-slate-700 bg-transparent text-slate-400"
                  }`}
                >
                  {hearing && <Mic className="w-3 h-3" />}
                  {p.name}
                  {p.channel !== selectedChannel && (
                    <span className="opacity-70">
                      ·{" "}
                      {p.channel === EMERGENCY_ID ? "Emerg" : `Ch ${p.channel}`}
                    </span>
                  )}
                </button>
              );
            })}
            {unlinked.map((u) => (
              <span
                key={u.id}
                title={`You're not connected to ${u.name}`}
                className="text-xs px-2 py-1 rounded-full border border-dashed border-red-400 text-red-300"
              >
                {u.name} · no link
              </span>
            ))}
          </div>
          {unlinked.length > 0 && (
            <p className="text-xs text-red-300 mt-2">
              No direct link to {unlinked.map((u) => u.name).join(", ")} - a
              network between you is blocking it. Setting up a TURN relay fixes
              this (see Settings &gt; Connection).
            </p>
          )}
          {peerList.length > 0 && !directPeer && (
            <p className="text-xs text-slate-500 mt-2">
              Tap a name to talk to that person privately.
            </p>
          )}
        </div>

        {/* Message Feed */}
        <div
          ref={feedRef}
          className="flex-1 min-h-0 p-4 space-y-3 overflow-y-auto overscroll-contain"
        >
          {visibleMessages.length === 0 && (
            <p className="text-sm text-slate-500 text-center mt-8">
              No messages yet on {current.name}. Hold the big button to talk, or
              type below.
            </p>
          )}
          {visibleMessages.map((message) => {
            const mine = message.from === comm.selfId;
            const emergency = message.channel === EMERGENCY_ID;
            return (
              <div
                key={message.id}
                className={`p-3 rounded-lg ${
                  message.type === "system"
                    ? "bg-slate-800 border-l-4 border-blue-500"
                    : emergency
                      ? `bg-red-900/60 border border-red-500 ${
                          mine ? "ml-8" : "mr-8"
                        }`
                      : mine
                        ? "bg-blue-600 ml-8"
                        : "bg-slate-700 mr-8"
                }`}
              >
                <div className="flex justify-between items-start mb-1 gap-2">
                  <span className="text-sm font-medium text-slate-200 flex items-center gap-1">
                    {emergency && message.type !== "system" && (
                      <AlertTriangle className="w-4 h-4 text-red-300" />
                    )}
                    {message.type === "system"
                      ? "System"
                      : mine
                        ? "You"
                        : message.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatTime(message.ts)}
                  </span>
                </div>
                <p className="text-sm text-slate-100 whitespace-pre-wrap break-words">
                  {message.text}
                </p>
              </div>
            );
          })}
        </div>

        {/* Text compose */}
        <form
          onSubmit={sendDraft}
          className="px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] bg-slate-800 border-t border-slate-700 flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1000}
            placeholder={`Message ${current.name}`}
            disabled={!isConnected}
            className="flex-1 rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={!isConnected || !draft.trim()}
            aria-label="Send message"
            className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>

        {showSettings && (
          <SettingsPanel
            session={session}
            comm={comm}
            volume={volume}
            onVolume={setVolume}
            onRename={rename}
            onLeave={leave}
            onReconnect={reconnect}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </div>
  );
};

export default ClearCalmCommApp;
