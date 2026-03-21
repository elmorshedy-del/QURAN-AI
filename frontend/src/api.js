const DEFAULT_LOCAL_API = "http://localhost:8000";
const DEFAULT_LOCAL_SEGMENTER = "http://localhost:8001";

function normalizeBase(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  return value.replace(/\/+$/, "");
}

function toAbsoluteBackendUrl(base, value) {
  if (!value) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}

export function getApiBase() {
  const configured = normalizeBase(import.meta.env.VITE_API_BASE);
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

export function getSegmenterBase() {
  const configured = normalizeBase(import.meta.env.VITE_SEGMENTER_BASE);
  if (configured) {
    return configured;
  }
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_SEGMENTER;
  }
  const { protocol, hostname, port } = window.location;
  if (port === "8001") {
    return `${protocol}//${hostname}:${port}`;
  }
  return `${protocol}//${hostname}:8001`;
}

async function readJson(response) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`.trim());
  }
  return response.json();
}

export async function fetchHealth() {
  const response = await fetch(`${getApiBase()}/api/health`);
  return readJson(response);
}

export async function fetchAyah(surah, ayah) {
  const base = getApiBase();
  const response = await fetch(`${base}/api/surah/${surah}/ayah/${ayah}`);
  const payload = await readJson(response);
  return {
    ...payload,
    word_audio_urls: Array.isArray(payload.word_audio_urls)
      ? payload.word_audio_urls.map((url) => toAbsoluteBackendUrl(base, url))
      : [],
  };
}

export async function fetchSegmenterHealth() {
  const response = await fetch(`${getSegmenterBase()}/api/health`);
  return readJson(response);
}
