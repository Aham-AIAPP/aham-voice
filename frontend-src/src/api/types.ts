// Domain types — these mirror the FastAPI backend (backend/app/main.py).
// Keep them in lock-step with the backend's `normalize_*` functions and
// schema definitions.

export type Role = "admin" | "manager" | "member";
export type UserStatus = "active" | "disabled";
export type UserSource = "local" | "wecom";

export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  mobile: string;
  dept: string;
  role: Role;
  team_id: string | null;
  managed_team_ids: string[];
  status: UserStatus;
  source: UserSource;
  wecom_userid: string | null;
  must_change_password: boolean;
  last_active_at: string;
  last_login_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface Team {
  id: string;
  name: string;
  dept: string;
  wecom_department_id: string | null;
  parent_wecom_department_id: string | null;
  manager_ids: string[];
  member_count: number;
  recording_count: number;
}

export type RecordingProcessingStatus =
  | "pending"
  | "queued"
  | "running"
  | "done"
  | "failed";

export interface Recording {
  id: string;
  title: string;
  filename: string;
  file_path: string;
  meeting_type: string;
  tag: string | null;
  owner_id: string;
  owner_name: string;
  team_id: string | null;
  duration: number;
  duration_label: string;
  asr_status: RecordingProcessingStatus;
  summary_status: RecordingProcessingStatus;
  created_at: string;
  updated_at: string;
}

export interface TranscriptSegment {
  id: string;
  recording_id: string;
  start_sec: number;
  end_sec: number;
  start_label: string;
  speaker: string;
  speaker_name: string | null;
  voiceprint_id: string | null;
  speaker_confidence: number | null;
  text: string;
  confidence: number | null;
}

export interface Summary {
  id: string;
  recording_id: string;
  content: string;
  model: string;
  created_at: string;
  version: number;
  instruction: string | null;
  base_summary_id: string | null;
  is_current: number;
  content_length?: number;
}

export interface RecordingTask {
  id: string;
  recording_id: string | null;
  recording_title: string;
  step: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  phase: string | null;
  phase_index: number | null;
  phase_total: number | null;
  elapsed_seconds: number;
  elapsed_label: string;
  eta_seconds: number | null;
  eta_label: string | null;
  stale_seconds: number;
  is_stale: boolean;
}

export interface Hotword {
  id: string;
  word: string;
  kind: string;
  aliases: string | null;
  source: string;
  scope: string;
  weight: number;
  active: boolean;
  state: string;
  protected: boolean;
  frequency: number;
  confidence: number;
  score: number;
  team_id: string | null;
  owner_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  hit_count: number;
  updated_at: string | null;
}


export interface Voiceprint {
  id: string;
  name: string;
  note?: string | null;
  owner_id: string | null;
  team_id: string | null;
  scope: "personal" | "team" | "global";
  threshold: number;
  active: number;
  created_at: string;
  sample_path?: string;
}

// 大模型（LLM）配置 —— 对齐 aham-voice 开源版。API Key 永不回显。
export interface Settings {
  llm_configured: boolean;
  llm_api_base: string;
  llm_model: string;
  llm_provider: string;
  // legacy DeepSeek 别名（后端同步返回，兼容旧缓存）
  deepseek_configured?: boolean;
  deepseek_api_base?: string;
  deepseek_model?: string;
}

export interface LlmTestResult {
  ok: boolean;
  model: string;
  latency_ms: number;
  error?: string;
}

// 录音详情页给说话人命名并建声纹的结果。能建声纹的说话人命名后即返回新建的 profile。
export interface NameSpeakerResult {
  profile: Voiceprint;
  sample_count: number;
  sample_duration: number;
  sample_duration_label: string;
  updated_segments: number;
}

export interface SpeakerSampleSegment {
  id: string;
  recording_id: string;
  speaker: string;
  start_sec: number;
  end_sec: number;
  start_label: string;
  duration: number;
  duration_label: string;
  text: string;
  quality: "good" | "usable" | "short";
  audio_url: string;
}

export interface SpeakerCandidate {
  speaker: string;
  display_name: string;
  speaker_name: string | null;
  voiceprint_id: string | null;
  segment_count: number;
  total_duration: number;
  total_duration_label: string;
  sample_segments: SpeakerSampleSegment[];
}

export interface RoleMapping {
  id: string;
  match_type:
    | "wecom_userid"
    | "name"
    | "mobile"
    | "department_id"
    | "team_id"
    | "local_username";
  match_value: string;
  role: Role;
  managed_team_ids: string[];
  active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface WecomConfig {
  corp_id: string;
  sales_department_id: string;
  secret_configured: boolean;
  secret?: string;
}

export interface WecomSyncResult {
  preview: boolean;
  added: string[];
  updated: string[];
  disabled: string[];
  added_count: number;
  updated_count: number;
  disabled_count: number;
  team_count: number;
  initial_password: string | null;
}

export interface AuditRow {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_name: string;
  category: string;
  message: string;
}

export interface AdminOverview {
  active_users: number;
  team_count: number;
  today_processed_seconds: number;
  today_processed_label: string;
  storage_bytes: number;
  storage_label: string;
  integrations: Array<{ name: string; description: string; ok: boolean }>;
  recent_audit: AuditRow[];
}

export interface SystemStatus {
  base: string;
  db: string;
  paraformer: boolean;
  vad: boolean;
  punc: boolean;
  voiceprint: boolean;
  ffmpeg: boolean;
  deepseek_configured: boolean;
  deepseek_model: string;
  segmentation: string;
  diarization: string;
}

export interface HotwordPackage {
  id: string;
  recording_id: string;
  version: number;
  asr_terms_count: number;
  correction_terms_count: number;
  protected_terms_count: number;
  dynamic_terms_count: number;
  source_summary: Record<string, number>;
  asr_terms: string[];
  correction_terms: string[];
  created_at: string;
}

export interface EmotionAnalysis {
  id: string;
  recording_id: string;
  content: string;
  model: string;
  acoustic_json: string | null;
  created_at: string;
  version: number;
  is_current: number;
}

export interface RecordingDetail {
  recording: Recording;
  segments: TranscriptSegment[];
  summary: Summary | null;
  summaries: Summary[];
  emotion_analysis: EmotionAnalysis | null;
  tasks: RecordingTask[];
  outputs: Array<{
    id: string;
    kind: "transcript" | "summary" | "emotion";
    title: string;
    format: string;
    status: string;
    download_url: string;
    segment_count?: number;
    speaker_count?: number;
    model?: string;
    created_at?: string;
    version?: number;
  }>;
  hotword_package: HotwordPackage | null;
}
