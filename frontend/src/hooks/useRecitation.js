import { useCallback, useEffect, useRef, useState } from "react";

const SAMPLE_RATE = 16000;
const CHUNK_INTERVAL_MS = 300;
const DEFAULT_LOCAL_API = "http://localhost:8000";

function normalizeHttpBase(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  return value.replace(/\/+$/, "");
}

function inferHttpBase() {
  const configured = normalizeHttpBase(import.meta.env.VITE_API_BASE);
  if (configured) {
    return configured;
  }
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_API;
  }
  const { protocol, hostname, port } = window.location;
  if (port === "8000") {
    return `${protocol}//${hostname}:${port}`;
  }
  return `${protocol}//${hostname}:8000`;
}

function inferWsBase(httpBase) {
  const configured = String(import.meta.env.VITE_WS_BASE || "").trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }
  return httpBase.replace(/^http/i, "ws");
}

function toAbsoluteUrl(base, value) {
  if (!value) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}

export function useRecitation({
  surah,
  ayah,
  onReady,
  onCorrection,
  onCorrect,
  onSummary,
  onStateChange,
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const [audioState, setAudioState] = useState("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [micPermission, setMicPermission] = useState("unknown");

  const wsRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const audioContextRef = useRef(null);
  const chunksRef = useRef([]);
  const intervalRef = useRef(null);
  const connectPromiseRef = useRef(null);
  const meterUpdateRef = useRef(0);

  const apiBase = inferHttpBase();
  const wsBase = inferWsBase(apiBase);

  const emitState = useCallback(
    (payload) => {
      if (onStateChange) {
        onStateChange({
          apiBase,
          wsBase,
          ...payload,
        });
      }
    },
    [apiBase, onStateChange, wsBase],
  );

  const teardownAudio = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    chunksRef.current = [];
    setAudioState("idle");
    setAudioLevel(0);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (connectPromiseRef.current) {
      return connectPromiseRef.current;
    }

    connectPromiseRef.current = new Promise((resolve, reject) => {
      setSocketState("connecting");
      emitState({ status: "connecting", socketState: "connecting" });
      const ws = new WebSocket(`${wsBase}/ws/recite`);

      ws.onopen = () => {
        setIsConnected(true);
        setSocketState("connected");
        setConnectionError("");
        emitState({ status: "connected", socketState: "connected" });
        connectPromiseRef.current = null;
        resolve();
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case "system_status":
            emitState({
              status: message.state || "ready",
              socketState: "connected",
              backend: message.backend || null,
            });
            break;
          case "ready":
            if (onReady) {
              onReady(message);
            }
            emitState({
              status: "ready",
              message,
              socketState: "connected",
              backend: message.backend || null,
            });
            break;
          case "correction": {
            const correction = {
              ...message,
              audio_url: toAbsoluteUrl(apiBase, message.audio_url),
            };
            if (correction.audio_url) {
              const audio = new Audio(correction.audio_url);
              audio.play().catch(() => {});
            }
            if (onCorrection) {
              onCorrection(correction);
            }
            emitState({ status: "correction", message: correction, socketState: "connected" });
            break;
          }
          case "correct":
            if (onCorrect) {
              onCorrect(message);
            }
            emitState({ status: "correct", message, socketState: "connected" });
            break;
          case "summary":
            if (onSummary) {
              onSummary(message);
            }
            emitState({ status: "summary", message, socketState: "connected" });
            break;
          default:
            break;
        }
      };

      ws.onerror = () => {
        setSocketState("error");
        setConnectionError("Unable to reach the recitation server.");
        emitState({ status: "error", socketState: "error" });
      };

      ws.onclose = () => {
        setIsConnected(false);
        setSocketState("disconnected");
        wsRef.current = null;
        connectPromiseRef.current = null;
        emitState({ status: "disconnected", socketState: "disconnected" });
      };

      wsRef.current = ws;

      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Timed out connecting to recitation server."));
          connectPromiseRef.current = null;
        }
      }, 4000);
    }).catch((error) => {
      setConnectionError(error.message);
      emitState({ status: "error", error: error.message });
      throw error;
    });

    return connectPromiseRef.current;
  }, [apiBase, emitState, onCorrection, onCorrect, onReady, onSummary, wsBase]);

  const startRecording = useCallback(async () => {
    await connect();

    try {
      setMicPermission("requesting");
      setAudioState("requesting");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      setMicPermission("granted");
      mediaStreamRef.current = stream;
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        const float32Data = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        const int16Data = new Int16Array(float32Data.length);
        for (let index = 0; index < float32Data.length; index += 1) {
          const sample = float32Data[index];
          sumSquares += sample * sample;
          int16Data[index] = Math.max(
            -32768,
            Math.min(32767, Math.round(sample * 32768)),
          );
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, float32Data.length));
        const now = Date.now();
        if (now - meterUpdateRef.current > 180) {
          meterUpdateRef.current = now;
          setAudioLevel(rms);
          setAudioState(rms > 0.01 ? "speech" : "quiet");
          emitState({
            status: "recording",
            socketState: "connected",
            audioState: rms > 0.01 ? "speech" : "quiet",
            audioLevel: rms,
          });
        }
        chunksRef.current.push(int16Data.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      wsRef.current.send(
        JSON.stringify({
          type: "start",
          surah,
          ayah,
        }),
      );

      intervalRef.current = setInterval(() => {
        if (chunksRef.current.length === 0 || wsRef.current?.readyState !== WebSocket.OPEN) {
          return;
        }
        wsRef.current.send(concatenateBuffers(chunksRef.current));
        chunksRef.current = [];
      }, CHUNK_INTERVAL_MS);

      setIsRecording(true);
      emitState({
        status: "recording",
        socketState: "connected",
        audioState: "warming",
        audioLevel: 0,
      });
    } catch (error) {
      teardownAudio();
      setMicPermission("denied");
      setConnectionError("Microphone access is required to start recitation.");
      emitState({ status: "error", error: String(error), audioState: "error" });
    }
  }, [ayah, connect, emitState, surah, teardownAudio]);

  const stopRecording = useCallback(() => {
    if (chunksRef.current.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(concatenateBuffers(chunksRef.current));
    }
    chunksRef.current = [];

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }

    teardownAudio();
    setIsRecording(false);
    emitState({ status: "stopped", socketState, audioState: "idle", audioLevel: 0 });
  }, [emitState, socketState, teardownAudio]);

  useEffect(() => {
    return () => {
      teardownAudio();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [teardownAudio]);

  return {
    apiBase,
    wsBase,
    isRecording,
    isConnected,
    socketState,
    audioState,
    audioLevel,
    micPermission,
    connectionError,
    connect,
    startRecording,
    stopRecording,
  };
}

function concatenateBuffers(buffers) {
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return output.buffer;
}
