import { api, getStoredToken } from "./client";
import type {
  AdminOverview,
  AuditRow,
  LlmTestResult,
  LoginResponse,
  NameSpeakerResult,
  OpportunityCandidate,
  Recording,
  RecordingDetail,
  RoleMapping,
  Settings,
  SpeakerCandidate,
  SystemStatus,
  Team,
  User,
  Voiceprint,
  WecomConfig,
  WecomSyncResult,
} from "./types";

// Thin one-call-per-export module. The TanStack Query hooks live alongside
// pages so they can shape the data when needed, but the verbs themselves
// are kept here so it's easy to grep for "which endpoints does the UI hit".

// -------- auth --------

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

// -------- recordings --------

export async function fetchRecordings(params: {
  scope?: "mine" | "team";
  q?: string;
  meeting_type?: string;
}): Promise<Recording[]> {
  const { data } = await api.get<Recording[]>("/recordings", { params });
  return data;
}

export async function fetchRecording(id: string): Promise<RecordingDetail> {
  const { data } = await api.get<RecordingDetail>(`/recordings/${id}`);
  return data;
}

export async function uploadRecording(input: {
  file: File;
  title: string;
  meeting_type?: string;
  tag?: string;
  auto_process?: boolean;
  expected_speakers?: number | null;
  onProgress?: (pct: number) => void;
}): Promise<Recording> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("title", input.title);
  if (input.meeting_type) form.append("meeting_type", input.meeting_type);
  if (input.tag) form.append("tag", input.tag);
  form.append("auto_process", String(input.auto_process ?? true));
  if (input.expected_speakers && input.expected_speakers >= 2) {
    form.append("expected_speakers", String(input.expected_speakers));
  }
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

export async function syncRecordingToCrm(id: string, relation?: {
  targetType?: string;
  targetId: string;
  targetName?: string;
  confidence?: number;
}): Promise<unknown> {
  const { data } = await api.post(`/recordings/${id}/crm/sync`, relation ? { relation } : {});
  return data;
}

export async function searchCrmOpportunities(q: string): Promise<{ candidates: OpportunityCandidate[] }> {
  const { data } = await api.get<{ candidates: OpportunityCandidate[] }>("/crm/opportunities/search", { params: { q } });
  return data;
}

export async function fetchSpeakerCandidates(id: string): Promise<SpeakerCandidate[]> {
  const { data } = await api.get<SpeakerCandidate[]>(`/recordings/${id}/speaker-candidates`);
  return data;
}

export async function renameSpeaker(recordingId: string, speaker: string, payload: {
  name: string;
  voiceprint_id?: string;
}): Promise<{ recording_id: string; speaker: string; name: string; updated_segments: number }> {
  const { data } = await api.patch(`/recordings/${recordingId}/speakers/${speaker}`, payload);
  return data;
}

// -------- hotwords（仅保留个人手填热词；表格版/在线更新已移除）--------

// 个人热词（对齐 aham-voice 富文本框）：读/写当前用户全部个人热词，无损 round-trip。
// 注：热词「在线更新」（CRM/企微同步、重算评分、同步状态）功能已整体移除。
export async function fetchAllHotwordWords(): Promise<string[]> {
  const { data } = await api.get<string[]>("/hotwords/words");
  return data;
}

export async function saveAllHotwords(words: string[]): Promise<{ ok: boolean; count: number; words: string[] }> {
  const { data } = await api.put("/hotwords", { words });
  return data;
}

// -------- settings (大模型配置) --------

export async function fetchSettings(): Promise<Settings> {
  const { data } = await api.get<Settings>("/settings");
  return data;
}

export async function patchSettings(payload: {
  llm_api_key?: string;
  llm_api_base?: string;
  llm_model?: string;
  llm_provider?: string;
  newcrm_base_url?: string;
  newcrm_token?: string;
}): Promise<Settings> {
  const { data } = await api.patch<Settings>("/settings", payload);
  return data;
}

export async function testLlmConnection(payload: {
  api_key?: string;
  api_base?: string;
  model?: string;
}): Promise<LlmTestResult> {
  const { data } = await api.post<LlmTestResult>("/settings/test", payload);
  return data;
}

// -------- voiceprints --------

export async function fetchVoiceprints(): Promise<Voiceprint[]> {
  const { data } = await api.get<Voiceprint[]>("/voiceprints");
  return data;
}

// 录音详情页「点名字直接命名」的薄封装（对齐 aham-voice）：只传姓名，一步完成
// 回填当前录音 + 建跨录音声纹；发言 <5s 时后端降级为仅命名（downgraded=true）。
export async function nameSpeakerFromRecording(payload: {
  recording_id: string;
  speaker: string;
  name: string;
  update_current_recording?: boolean;
}): Promise<NameSpeakerResult> {
  const { data } = await api.post<NameSpeakerResult>("/voiceprints/from-recording", {
    update_current_recording: true,
    ...payload,
  });
  return data;
}

export async function patchVoiceprint(id: string, payload: Partial<Pick<Voiceprint, "name" | "note" | "threshold" | "active">>): Promise<Voiceprint> {
  const { data } = await api.patch<Voiceprint>(`/voiceprints/${id}`, payload);
  return data;
}

export async function deleteVoiceprint(id: string): Promise<{ ok: boolean; id: string }> {
  const { data } = await api.delete(`/voiceprints/${id}`);
  return data;
}

// -------- users & teams --------

export async function fetchUsers(params: { role?: string; status?: string; q?: string }): Promise<User[]> {
  const { data } = await api.get<User[]>("/users", { params });
  return data;
}

export async function patchUser(id: string, payload: Partial<Pick<User, "username" | "name" | "email" | "mobile" | "dept" | "role" | "team_id" | "managed_team_ids" | "status">>): Promise<User> {
  const { data } = await api.patch<User>(`/users/${id}`, payload);
  return data;
}

export async function resetUserPassword(id: string): Promise<User> {
  const { data } = await api.post<User>(`/users/${id}/reset-password`);
  return data;
}

export async function fetchTeams(): Promise<Team[]> {
  const { data } = await api.get<Team[]>("/teams");
  return data;
}

export async function patchTeam(id: string, payload: Partial<Pick<Team, "name" | "dept" | "manager_ids">>): Promise<Team> {
  const { data } = await api.patch<Team>(`/teams/${id}`, payload);
  return data;
}

// -------- WeCom + role mappings --------

export async function fetchWecomConfig(): Promise<WecomConfig> {
  const { data } = await api.get<WecomConfig>("/wecom/config");
  return data;
}

export async function patchWecomConfig(payload: Partial<{ corp_id: string; secret: string; sales_department_id: string }>): Promise<WecomConfig> {
  const { data } = await api.patch<WecomConfig>("/wecom/config", payload);
  return data;
}

export async function fetchRoleMappings(): Promise<RoleMapping[]> {
  const { data } = await api.get<RoleMapping[]>("/wecom/role-mappings");
  return data;
}

export async function createRoleMapping(payload: Omit<RoleMapping, "id" | "created_at" | "updated_at">): Promise<RoleMapping> {
  const { data } = await api.post<RoleMapping>("/wecom/role-mappings", payload);
  return data;
}

export async function patchRoleMapping(id: string, payload: Partial<RoleMapping>): Promise<RoleMapping> {
  const { data } = await api.patch<RoleMapping>(`/wecom/role-mappings/${id}`, payload);
  return data;
}

export async function deleteRoleMapping(id: string): Promise<void> {
  await api.delete(`/wecom/role-mappings/${id}`);
}

export async function syncWecom(preview = false): Promise<WecomSyncResult> {
  const { data } = await api.post<WecomSyncResult>("/wecom/sync", { preview });
  return data;
}

// -------- audit / overview / system --------

export async function fetchAuditRows(params: { category?: string; q?: string; from?: string; to?: string }): Promise<AuditRow[]> {
  const { data } = await api.get<AuditRow[]>("/audit", { params });
  return data;
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  const { data } = await api.get<AdminOverview>("/admin/overview");
  return data;
}

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

export function auditCsvUrl(params: { category?: string; q?: string; from?: string; to?: string }): string {
  const search = new URLSearchParams();
  if (params.category) search.set("category", params.category);
  if (params.q) search.set("q", params.q);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  const qs = search.toString();
  return withToken(`${apiPrefix()}/audit.csv${qs ? `?${qs}` : ""}`);
}

export function segmentAudioUrl(recordingId: string, segmentId: string): string {
  return withToken(`${apiPrefix()}/recordings/${recordingId}/segments/${segmentId}/audio`);
}
