import { api } from "./client";
import type {
  AdminOverview,
  AuditRow,
  Hotword,
  HotwordStatus,
  LoginResponse,
  OpportunityCandidate,
  Recording,
  RecordingDetail,
  RecordingTask,
  RoleMapping,
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
}): Promise<Recording> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("title", input.title);
  if (input.meeting_type) form.append("meeting_type", input.meeting_type);
  if (input.tag) form.append("tag", input.tag);
  form.append("auto_process", String(input.auto_process ?? true));
  const { data } = await api.post<Recording>("/recordings", form);
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

// -------- tasks --------

export async function fetchTasks(): Promise<RecordingTask[]> {
  const { data } = await api.get<RecordingTask[]>("/tasks");
  return data;
}

// -------- hotwords --------

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

export async function patchHotword(id: string, payload: Partial<Pick<Hotword, "kind" | "aliases" | "scope" | "weight" | "active" | "state" | "protected">>): Promise<Hotword> {
  const { data } = await api.patch<Hotword>(`/hotwords/${id}`, payload);
  return data;
}

export async function syncHotwordSource(source: "all" | "crm" | "wecom-journals", preview: boolean): Promise<{ ok: boolean; results: unknown[]; status: HotwordStatus }> {
  const { data } = await api.post("/hotwords/sync", { source, preview });
  return data;
}

export async function maintainHotwords(): Promise<{ expired: number; rescored: number; status: HotwordStatus }> {
  const { data } = await api.post("/hotwords/maintain");
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
  scope?: "personal" | "team" | "global";
  team_id?: string;
  file: File;
}): Promise<Voiceprint> {
  const form = new FormData();
  form.append("name", input.name);
  if (input.threshold != null) form.append("threshold", String(input.threshold));
  if (input.scope) form.append("scope", input.scope);
  if (input.team_id) form.append("team_id", input.team_id);
  form.append("file", input.file);
  const { data } = await api.post<Voiceprint>("/voiceprints", form);
  return data;
}

export async function createVoiceprintFromRecording(payload: {
  recording_id: string;
  speaker: string;
  name?: string;
  segment_ids?: string[];
  profile_id?: string;
  update_current_recording?: boolean;
  threshold?: number;
  scope?: "personal" | "team" | "global";
  team_id?: string;
}): Promise<{
  profile: Voiceprint;
  sample_count: number;
  sample_duration: number;
  sample_duration_label: string;
  updated_segments: number;
}> {
  const { data } = await api.post("/voiceprints/from-recording", payload);
  return data;
}

export async function patchVoiceprint(id: string, payload: Partial<Pick<Voiceprint, "name" | "threshold" | "active">>): Promise<Voiceprint> {
  const { data } = await api.patch<Voiceprint>(`/voiceprints/${id}`, payload);
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

export function recordingAudioUrl(id: string): string {
  return `${apiPrefix()}/recordings/${id}/audio`;
}

export function exportTranscriptUrl(id: string): string {
  return `${apiPrefix()}/recordings/${id}/export/transcript.md`;
}

export function exportSummaryUrl(id: string): string {
  return `${apiPrefix()}/recordings/${id}/export/summary.md`;
}

export function exportSummaryVersionUrl(id: string, summaryId: string): string {
  return `${apiPrefix()}/recordings/${id}/export/summaries/${summaryId}.md`;
}

export function auditCsvUrl(params: { category?: string; q?: string; from?: string; to?: string }): string {
  const search = new URLSearchParams();
  if (params.category) search.set("category", params.category);
  if (params.q) search.set("q", params.q);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  const qs = search.toString();
  return `${apiPrefix()}/audit.csv${qs ? `?${qs}` : ""}`;
}

export function segmentAudioUrl(recordingId: string, segmentId: string): string {
  return `${apiPrefix()}/recordings/${recordingId}/segments/${segmentId}/audio`;
}
