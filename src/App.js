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
import useComm from "./useComm";

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
    invite.passcode || prefs.passcode || ""
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
    </div>
  );
};

const SettingsPanel = ({ session, comm, onRename, onLeave, onClose }) => {
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
      <div className="bg-slate-800 w-full max-w-md rounded-t-2xl sm:rounded-2xl p-5 space-y-5">
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
  const talkers = onChannel.filter((p) => p.talking);

  // Show this channel's messages, system notices, and anything sent to
  // Emergency (which everyone sees, whatever channel they're on).
  const visibleMessages = messages.filter(
    (m) =>
      m.type === "system" ||
      m.channel === selectedChannel ||
      m.channel === EMERGENCY_ID
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
      startTalking();
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
  }, [canTalk, startTalking, stopTalking]);

  const join = ({ name, team, passcode }) => {
    savePrefs({ name, team, passcode });
    setSession({ name, team, passcode });
    comm.connect({ name, team, passcode, channel: selectedChannel });
  };

  const leave = () => {
    comm.disconnect();
    setSession(null);
    setShowSettings(false);
  };

  const rename = (name) => {
    savePrefs({ ...loadPrefs(), name });
    setSession((s) => ({ ...s, name }));
    comm.setName(name);
    setShowSettings(false);
  };

  const switchChannel = (channelId) => {
    if (transmitting) stopTalking();
    setSelectedChannel(channelId);
    comm.setChannel(channelId);
  };

  const sendDraft = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    comm.sendText(draft);
    setDraft("");
  };

  const pttDown = (e) => {
    if (!canTalk) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startTalking();
  };

  if (!session) return <JoinScreen onJoin={join} />;

  const current = CHANNELS.find((c) => c.id === selectedChannel);

  return (
    <div className="max-w-md mx-auto bg-slate-900 text-white h-screen h-[100dvh] flex flex-col">
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
            <span className="text-slate-300">
              Vol: {isMuted ? "muted" : `${volume}%`}
            </span>
            <div className="flex items-center space-x-1" title="Team online">
              <Users className="w-4 h-4" />
              <span className="text-slate-300">{peerList.length + 1}</span>
            </div>
          </div>
          <div
            className={`px-2 py-1 rounded text-xs font-medium truncate ${
              transmitting
                ? "bg-red-600"
                : talkers.length
                ? "bg-amber-600"
                : isConnected
                ? "bg-green-600"
                : "bg-slate-600"
            }`}
          >
            {transmitting
              ? "TRANSMITTING"
              : talkers.length
              ? `${talkers.map((t) => t.name).join(", ")} TALKING`
              : isConnected
              ? peerList.length
                ? "READY"
                : "WAITING FOR TEAM"
              : "OFFLINE"}
          </div>
        </div>
      </div>

      {/* Channel Selection */}
      <div className="p-4 border-b border-slate-700">
        <div className="grid grid-cols-4 gap-2">
          {CHANNELS.map((channel) => (
            <button
              key={channel.id}
              onClick={() => switchChannel(channel.id)}
              className={`p-2 rounded-lg border transition-all ${
                selectedChannel === channel.id
                  ? channel.emergency
                    ? "border-red-500 bg-red-500/20 text-red-300"
                    : "border-blue-500 bg-blue-500/20 text-blue-300"
                  : "border-slate-600 bg-slate-800 hover:bg-slate-700"
              }`}
            >
              <div className="text-xs font-medium truncate">
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
          {onChannel.map((p) => (
            <span
              key={p.id}
              className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 ${
                p.talking
                  ? "bg-amber-500 text-slate-900"
                  : "bg-slate-700 text-slate-200"
              }`}
            >
              {p.talking && <Mic className="w-3 h-3" />}
              {p.name}
            </span>
          ))}
        </div>
      </div>

      {/* Message Feed */}
      <div ref={feedRef} className="flex-1 p-4 space-y-3 overflow-y-auto">
        {visibleMessages.length === 0 && (
          <p className="text-sm text-slate-500 text-center mt-8">
            No messages yet on {current.name}. Hold the button to talk, or type
            below.
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
        className="px-4 py-2 bg-slate-800 border-t border-slate-700 flex gap-2"
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

      {/* Controls */}
      <div className="p-4 bg-slate-800">
        {/* Volume Control */}
        <div className="flex items-center space-x-3 mb-4">
          <VolumeX className="w-5 h-5 text-slate-400" />
          <div className="flex-1">
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Volume"
              className="w-full h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer"
            />
          </div>
          <Volume2 className="w-5 h-5 text-slate-400" />
        </div>

        {/* Main Controls */}
        <div className="flex items-center justify-between">
          {/* Leave */}
          <button
            onClick={leave}
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
              aria-label="Hold to talk"
              style={{ touchAction: "none", WebkitUserSelect: "none" }}
              className={`w-20 h-20 rounded-full transition-all duration-150 select-none ${
                transmitting
                  ? "bg-red-500 scale-110 shadow-lg shadow-red-500/50"
                  : canTalk
                  ? "bg-blue-600 hover:bg-blue-700"
                  : "bg-slate-600 cursor-not-allowed"
              }`}
            >
              {micState === "denied" ? (
                <MicOff className="w-8 h-8 mx-auto" />
              ) : (
                <Mic className="w-8 h-8 mx-auto" />
              )}
            </button>
            <span className="text-xs text-slate-400 mt-2">
              {micState === "denied"
                ? "Mic blocked"
                : !canTalk
                ? "Starting mic..."
                : transmitting
                ? "Release to stop"
                : "Hold to talk (or Space)"}
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

      {showSettings && (
        <SettingsPanel
          session={session}
          comm={comm}
          onRename={rename}
          onLeave={leave}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
};

export default ClearCalmCommApp;
