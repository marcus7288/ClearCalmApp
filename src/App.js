import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Users,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";

const ClearCalmCommApp = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState(1);
  const [volume, setVolume] = useState(75);
  const [activeUsers, setActiveUsers] = useState([]);
  const [messages, setMessages] = useState([
    {
      id: 1,
      user: "Base Station",
      message: "Channel 1 is now active",
      time: "09:45",
      type: "system",
    },
    {
      id: 2,
      user: "Unit 2",
      message: "Copy that, standing by",
      time: "09:46",
      type: "received",
    },
  ]);

  const longPressTimer = useRef(null);
  const [isPressing, setIsPressing] = useState(false);

  const channels = [
    { id: 1, name: "Channel 1", users: 3 },
    { id: 2, name: "Channel 2", users: 1 },
    { id: 3, name: "Channel 3", users: 5 },
    { id: 4, name: "Emergency", users: 12 },
  ];

  // Push-to-talk handlers
  const handlePushToTalkStart = () => {
    if (!isConnected) return;
    longPressTimer.current = setTimeout(() => {
      setIsTransmitting(true);
      setIsPressing(true);
    }, 100);
  };

  const handlePushToTalkEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
    }
    setIsTransmitting(false);
    setIsPressing(false);
  };

  // Simulate receiving messages
  useEffect(() => {
    if (isConnected) {
      const interval = setInterval(() => {
        if (Math.random() > 0.7) {
          const newMessage = {
            id: Date.now(),
            user: `Unit ${Math.floor(Math.random() * 10) + 1}`,
            message: "Status update - all clear",
            time: new Date().toLocaleTimeString("en-US", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
            }),
            type: "received",
          };
          setMessages((prev) => [...prev.slice(-9), newMessage]);
        }
      }, 8000);
      return () => clearInterval(interval);
    }
  }, [isConnected]);

  const toggleConnection = () => {
    setIsConnected(!isConnected);
    if (!isConnected) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          user: "System",
          message: `Connected to ${
            channels.find((c) => c.id === selectedChannel).name
          }`,
          time: new Date().toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          }),
          type: "system",
        },
      ]);
    }
  };

  const switchChannel = (channelId) => {
    setSelectedChannel(channelId);
    if (isConnected) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          user: "System",
          message: `Switched to ${
            channels.find((c) => c.id === channelId).name
          }`,
          time: new Date().toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          }),
          type: "system",
        },
      ]);
    }
  };

  return (
    <div className="max-w-md mx-auto bg-slate-900 text-white min-h-screen flex flex-col">
      {/* Header */}
      <div className="bg-slate-800 p-4 flex items-center justify-between border-b border-slate-700">
        <div className="flex items-center space-x-3">
          <div
            className={`w-3 h-3 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
          ></div>
          <div>
            <h1 className="font-semibold text-lg">Clear Calm</h1>
            <p className="text-xs text-slate-400">
              {isConnected
                ? `Connected - ${
                    channels.find((c) => c.id === selectedChannel)?.name
                  }`
                : "Disconnected"}
            </p>
          </div>
        </div>
        <Settings className="w-6 h-6 text-slate-400" />
      </div>

      {/* Status Bar */}
      <div className="bg-slate-800 px-4 py-2 border-b border-slate-700">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center space-x-4">
            <span className="text-slate-300">Vol: {volume}%</span>
            <div className="flex items-center space-x-1">
              <Users className="w-4 h-4" />
              <span className="text-slate-300">
                {channels.find((c) => c.id === selectedChannel)?.users || 0}
              </span>
            </div>
          </div>
          <div
            className={`px-2 py-1 rounded text-xs font-medium ${
              isTransmitting
                ? "bg-red-600"
                : isConnected
                ? "bg-green-600"
                : "bg-slate-600"
            }`}
          >
            {isTransmitting
              ? "TRANSMITTING"
              : isConnected
              ? "READY"
              : "OFFLINE"}
          </div>
        </div>
      </div>

      {/* Channel Selection */}
      <div className="p-4 border-b border-slate-700">
        <h3 className="text-sm font-medium mb-3 text-slate-300">Channels</h3>
        <div className="grid grid-cols-2 gap-2">
          {channels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => switchChannel(channel.id)}
              className={`p-3 rounded-lg border transition-all ${
                selectedChannel === channel.id
                  ? "border-blue-500 bg-blue-500/20 text-blue-300"
                  : "border-slate-600 bg-slate-800 hover:bg-slate-700"
              }`}
            >
              <div className="text-sm font-medium">{channel.name}</div>
              <div className="text-xs text-slate-400">
                {channel.users} users
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Message Feed */}
      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        <h3 className="text-sm font-medium text-slate-300 mb-3">
          Communications
        </h3>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`p-3 rounded-lg ${
              message.type === "system"
                ? "bg-slate-700 border-l-4 border-blue-500"
                : message.type === "sent"
                ? "bg-blue-600 ml-8"
                : "bg-slate-700 mr-8"
            }`}
          >
            <div className="flex justify-between items-start mb-1">
              <span className="text-sm font-medium text-slate-200">
                {message.user}
              </span>
              <span className="text-xs text-slate-400">{message.time}</span>
            </div>
            <p className="text-sm text-slate-100">{message.message}</p>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="p-4 bg-slate-800 border-t border-slate-700">
        {/* Volume Control */}
        <div className="flex items-center space-x-3 mb-4">
          <VolumeX className="w-5 h-5 text-slate-400" />
          <div className="flex-1">
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              className="w-full h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer"
            />
          </div>
          <Volume2 className="w-5 h-5 text-slate-400" />
        </div>

        {/* Main Controls */}
        <div className="flex items-center justify-between">
          {/* Connection Toggle */}
          <button
            onClick={toggleConnection}
            className={`p-3 rounded-full transition-all ${
              isConnected
                ? "bg-red-600 hover:bg-red-700"
                : "bg-green-600 hover:bg-green-700"
            }`}
          >
            {isConnected ? (
              <PhoneOff className="w-6 h-6" />
            ) : (
              <Phone className="w-6 h-6" />
            )}
          </button>

          {/* Push-to-Talk Button */}
          <div className="flex flex-col items-center">
            <button
              onMouseDown={handlePushToTalkStart}
              onMouseUp={handlePushToTalkEnd}
              onTouchStart={handlePushToTalkStart}
              onTouchEnd={handlePushToTalkEnd}
              disabled={!isConnected}
              className={`w-20 h-20 rounded-full transition-all duration-150 ${
                isTransmitting
                  ? "bg-red-500 scale-110 shadow-lg shadow-red-500/50"
                  : isConnected
                  ? "bg-blue-600 hover:bg-blue-700 active:scale-105"
                  : "bg-slate-600 cursor-not-allowed"
              }`}
            >
              <Mic className="w-8 h-8 mx-auto" />
            </button>
            <span className="text-xs text-slate-400 mt-2">
              {isTransmitting ? "Release to stop" : "Hold to talk"}
            </span>
          </div>

          {/* Mute Toggle */}
          <button
            onClick={() => setIsMuted(!isMuted)}
            className={`p-3 rounded-full transition-all ${
              isMuted ? "bg-red-600" : "bg-slate-600 hover:bg-slate-700"
            }`}
          >
            {isMuted ? (
              <MicOff className="w-6 h-6" />
            ) : (
              <Mic className="w-6 h-6" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ClearCalmCommApp;
