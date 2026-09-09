import { api, getStoredToken } from "./client";
import type {
  DeleteRecordingResponse,
  McpConfig,
  Hotword,
  HotwordStatus,
  LlmTestResult,
  LoginResponse,
  Recording,
  RecordingDetail,
  SaveAllHotwordsResponse,
  SpeakerCandidate,
  ModelInfo,
  ModelsStatus,
  Settings,
  SystemStatus,
  User,
  Voiceprint,
} from "./types";

// Thin one-call-per-export module. The TanStack Query hooks live alongside
// pages so they can shape the data when needed, but the verbs themselves
// are kept here so it's easy to grep for "which endpoints does the UI hit".

// -------- auth (single-user desktop build: login is unused but kept harmless) --------

export async function login(username: string, password: string): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>("/auth/login", { username, password });
  return data;
}

export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<User> {
  const { data } = await api.post<User>("/auth/change-password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
  return data;
}

export async function fetchMe(): Promise<User> {
  const { data } = await api.get<User>("/me");
  return data;
}

// -------- settings (LLM / OpenAI-compatible API config) --------

export async function fetchSettings(): Promise<Settings> {
  const { data } = await api.get<Settings>("/settings");
  return data;
}

export async function patchSettings(payload: Partial<{
  // Generic LLM fields (preferred).
  llm_api_key: string;
  llm_api_base: string;
  llm_model: string;
  llm_provider: string;
  // Legacy DeepSeek fields, still accepted by the backend for compatibility.
  deepseek_api_key: string;
  deepseek_api_base: string;
  deepseek_model: string;
}>): Promise<Settings> {
  const { data } = await api.patch<Settings>("/settings", payload);
  return data;
}

// Live-probe the LLM endpoint. With no payload the backend uses the stored
// config; pass overrides to test values the user has typed but not yet saved.
export async function testLlmConnection(payload?: {
  api_key?: string;
  api_base?: string;
  model?: string;
}): Promise<LlmTestResult> {
  const { data } = await api.post<LlmTestResult>("/settings/test", payload ?? {});
  return data;
}

export async function fetchMcpConfig(): Promise<McpConfig> {
  const { data } = await api.get<McpConfig>("/mcp/config");
  return data;
}

// -------- local models (first-run download manager) --------

export async function fetchModels(refresh = false): Promise<ModelsStatus> {
  const { data } = await api.get<ModelsStatus>("/models", { params: refresh ? { refresh: true } : {} });
  return data;
}

export async function downloadModel(key: string): Promise<ModelInfo> {
  const { data } = await api.post<ModelInfo>(`/models/${key}/download`);
  return data;
}

export async function downloadAllModels(includeOptional: boolean): Promise<ModelsStatus> {
  const { data } = await api.post<ModelsStatus>("/models/download", { include_optional: includeOptional });
  return data;
}

export async function cancelModelDownload(key: string): Promise<ModelInfo> {
  const { data } = await api.post<ModelInfo>(`/models/${key}/cancel`);
  return data;
}

export async function deleteModel(key: string): Promise<ModelInfo> {
  const { data } = await api.delete<ModelInfo>(`/models/${key}`);
  return data;
}

// -------- recordings --------

export async function fetchRecordings(params: { q?: string }): Promise<Recording[]> {
  const { data } = await api.get<Recording[]>("/recordings", { params });
  return data;
}

export async function fetchRecording(id: string): Promise<RecordingDetail> {
  const { data } = await api.get<RecordingDetail>(`/recordings/${id}`);
  return data;
}

export async function deleteRecording(id: string): Promise<DeleteRecordingResponse> {
  const { data } = await api.delete<DeleteRecordingResponse>(`/recordings/${id}`);
  return data;
}

export async function uploadRecording(input: {
  file: File;
  title: string;
  tag?: string;
  briefing?: string;
  onProgress?: (pct: number) => void;
}): Promise<Recording> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("title", input.title);
  if (input.tag) form.append("tag", input.tag);
  if (input.briefing) form.append("briefing", input.briefing);
  const { data } = await api.post<Recording>("/recordings", form, {
    onUploadProgress: (e) => {
      if (input.onProgress && e.total) {
        input.onProgress(Math.round((e.loaded / e.total) * 100));
      }
    },
  });
  return data;
}

export async function processRecording(id: string): Promise<{ recording_id: string; status: string }> {
  const { data } = await api.post(`/recordings/${id}/process`);
  return data;
}

export async function transcribeRecording(id: string): Promise<{ recording_id: string; segments: number; speakers: number }> {
  const { data } = await api.post(`/recordings/${id}/transcribe`);
  return data;
}

export async function summarizeRecording(id: string): Promise<{ recording_id: string; model: string; summary_id: string; version: number }> {
  const { data } = await api.post(`/recordings/${id}/summarize`);
  return data;
}

export async function reviseSummary(id: string, instruction: string): Promise<{ recording_id: string; model: string; summary_id: string; version: number }> {
  const { data } = await api.post(`/recordings/${id}/summary/revise`, { instruction });
  return data;
}

export async function generateEmotion(id: string): Promise<{ status: string; recording_id: string }> {
  const { data } = await api.post(`/recordings/${id}/emotion`);
  return data;
}

export async function fetchSpeakerCandidates(id: string): Promise<SpeakerCandidate[]> {
  const { data } = await api.get<SpeakerCandidate[]>(`/recordings/${id}/speaker-candidates`);
  return data;
}

export async function mergeSpeakers(recordingId: string, from: string, into: string): Promise<{ moved_segments: number; into: string }> {
  const { data } = await api.post(`/recordings/${recordingId}/speakers/merge`, { from, into });
  return data;
}

export async function renameSpeaker(recordingId: string, speaker: string, payload: {
  name: string;
  voiceprint_id?: string;
}): Promise<{ recording_id: string; speaker: string; name: string; updated_segments: number }> {
  const { data } = await api.patch(`/recordings/${recordingId}/speakers/${speaker}`, payload);
  return data;
}

// -------- hotwords (manual maintenance) --------

export async function fetchHotwords(params: {
  state?: string;
  q?: string;
  protected?: "0" | "1";
}): Promise<Hotword[]> {
  const { data } = await api.get<Hotword[]>("/hotwords", { params });
  return data;
}

export async function fetchHotwordStatus(): Promise<HotwordStatus> {
  const { data } = await api.get<HotwordStatus>("/hotwords/status");
  return data;
}

// Personal-mode: load every hotword's `word` to populate the rich-text box.
// Uses the dedicated, un-paginated /hotwords/words endpoint whose read range
// (source='manual') matches exactly what `PUT /hotwords` replaces — so the box
// round-trips losslessly and never drops words beyond the paginated 1000 cap.
export async function fetchAllHotwordWords(): Promise<string[]> {
  const { data } = await api.get<string[]>("/hotwords/words");
  return data;
}

// Personal-mode: full overwrite of the current user's manual hotwords. The
// caller splits the 「、」-separated box into a trimmed array; the backend
// validates, dedupes (case-insensitive), and returns the sorted persisted list.
export async function saveAllHotwords(words: string[]): Promise<SaveAllHotwordsResponse> {
  const { data } = await api.put<SaveAllHotwordsResponse>("/hotwords", { words });
  return data;
}

export async function createHotword(payload: {
  word: string;
  kind?: string;
  aliases?: string;
  weight?: number;
  protected?: boolean;
}): Promise<Hotword> {
  const { data } = await api.post<Hotword>("/hotwords", payload);
  return data;
}

export async function patchHotword(id: string, payload: Partial<Pick<Hotword, "kind" | "aliases" | "scope" | "weight" | "active" | "state" | "protected">>): Promise<Hotword> {
  const { data } = await api.patch<Hotword>(`/hotwords/${id}`, payload);
  return data;
}

export async function deleteHotword(id: string): Promise<{ ok: boolean; id: string }> {
  const { data } = await api.delete(`/hotwords/${id}`);
  return data;
}

export async function maintainHotwords(): Promise<{ expired: number; rescored: number; status: HotwordStatus }> {
  const { data } = await api.post("/hotwords/maintain");
  return data;
}

export async function importHotwordsTxt(file: File): Promise<{ inserted: number; skipped: number; total: number }> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post("/hotwords/import", form);
  return data;
}

// -------- voiceprints --------

export async function fetchVoiceprints(): Promise<Voiceprint[]> {
  const { data } = await api.get<Voiceprint[]>("/voiceprints");
  return data;
}

export async function createVoiceprint(input: {
  name: string;
  threshold?: number;
  file: File;
}): Promise<Voiceprint> {
  const form = new FormData();
  form.append("name", input.name);
  if (input.threshold != null) form.append("threshold", String(input.threshold));
  form.append("file", input.file);
  const { data } = await api.post<Voiceprint>("/voiceprints", form);
  return data;
}

export interface NameSpeakerResult {
  // null when downgraded (< 5s total speech: named only, no voiceprint built).
  profile: Voiceprint | null;
  downgraded: boolean;
  sample_count: number;
  sample_duration: number;
  sample_duration_label: string;
  updated_segments: number;
}

export async function createVoiceprintFromRecording(payload: {
  recording_id: string;
  speaker: string;
  name?: string;
  note?: string;
  segment_ids?: string[];
  profile_id?: string;
  update_current_recording?: boolean;
  threshold?: number;
}): Promise<NameSpeakerResult> {
  const { data } = await api.post<NameSpeakerResult>("/voiceprints/from-recording", payload);
  return data;
}

// Name a speaker from a recording and build a voiceprint (with note). If the
// speaker's total speaking time is < 5s the backend downgrades to name-only and
// returns { downgraded: true, profile: null }.
export async function nameSpeakerFromRecording(payload: {
  recording_id: string;
  speaker: string;
  name: string;
  note?: string;
  segment_ids?: string[];
  profile_id?: string;
  update_current_recording?: boolean;
  threshold?: number;
}): Promise<NameSpeakerResult> {
  return createVoiceprintFromRecording(payload);
}

export async function patchVoiceprint(id: string, payload: Partial<Pick<Voiceprint, "name" | "note" | "threshold" | "active">>): Promise<Voiceprint> {
  const { data } = await api.patch<Voiceprint>(`/voiceprints/${id}`, payload);
  return data;
}

export async function deleteVoiceprint(id: string): Promise<{ ok: boolean; id: string }> {
  const { data } = await api.delete<{ ok: boolean; id: string }>(`/voiceprints/${id}`);
  return data;
}

// -------- system --------

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const { data } = await api.get<SystemStatus>("/system/status");
  return data;
}

// Helpers that don't go through axios (audio src, download hrefs). They need
// the same origin resolution as the axios client so a 5173-served frontend
// points its <audio> src at :8000.
function apiPrefix(): string {
  if (typeof window === "undefined") return "/api";
  const { protocol, hostname, port } = window.location;
  if (port === "5174") return "/api";
  if (port === "5173" || port === "") return `${protocol}//${hostname}:8000/api`;
  return "/api";
}

// Append the session token as a query param. Media/download URLs are loaded
// directly by the browser (<audio src>, <a download>), which can't attach the
// Authorization header — so the backend also accepts ?token=.
function withToken(url: string): string {
  const token = getStoredToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export function recordingAudioUrl(id: string): string {
  return withToken(`${apiPrefix()}/recordings/${id}/audio`);
}

export function exportTranscriptUrl(id: string): string {
  return withToken(`${apiPrefix()}/recordings/${id}/export/transcript.md`);
}

export function exportSummaryUrl(id: string): string {
  return withToken(`${apiPrefix()}/recordings/${id}/export/summary.md`);
}

export function exportSummaryVersionUrl(id: string, summaryId: string): string {
  return withToken(`${apiPrefix()}/recordings/${id}/export/summaries/${summaryId}.md`);
}

export function exportEmotionUrl(id: string): string {
  return withToken(`${apiPrefix()}/recordings/${id}/export/emotion.md`);
}

export function segmentAudioUrl(recordingId: string, segmentId: string): string {
  return withToken(`${apiPrefix()}/recordings/${recordingId}/segments/${segmentId}/audio`);
}
