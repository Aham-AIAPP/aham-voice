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
  tag: string | null;
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
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  hit_count: number;
  updated_at: string | null;
}

// Response of `PUT /api/hotwords` (personal-mode bulk replace). `words` is the
// deduped, sorted list the backend actually persisted.
export interface SaveAllHotwordsResponse {
  ok: boolean;
  count: number;
  words: string[];
}

export interface HotwordSource {
  id: string;
  name: string;
  source_type: string;
  enabled: number;
  schedule_minutes: number;
  lookback_days: number;
  asr_limit: number;
  correction_limit: number;
  candidate_limit: number;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface HotwordStatus {
  total: number;
  active: number;
  protected: number;
  dynamic: number;
  expired: number;
  limits: { asr: number; correction: number; protected: number };
  by_source: Array<{
    source: string;
    total: number;
    active: number;
    protected: number;
  }>;
  sources: HotwordSource[];
}

export interface Voiceprint {
  id: string;
  name: string;
  note: string | null;
  threshold: number;
  active: number;
  created_at: string;
  sample_path?: string;
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
  llm_configured: boolean;
  llm_model: string;
  llm_provider: string;
  // Legacy DeepSeek aliases, kept for backward compatibility.
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

// A pending proposal for the hotword table. kind="term" is a new word;
// kind="correction" means `heard` should have been `suggested`, and accepting it
// files `heard` as an alias so the next transcript gets it right.
export interface HotwordSuggestion {
  id: string;
  recording_id: string | null;
  recording_title?: string | null;
  kind: "term" | "correction";
  heard: string;
  suggested: string;
  reason: string;
  confidence: number;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  decided_at: string | null;
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

export interface DeleteRecordingResponse {
  ok: boolean;
  deleted_id: string;
}

export interface Settings {
  // Generic LLM fields (any OpenAI-compatible endpoint).
  llm_configured: boolean;
  llm_api_base: string;
  llm_model: string;
  llm_provider: string;
  // Legacy DeepSeek aliases, kept for backward compatibility.
  deepseek_configured: boolean;
  deepseek_api_base: string;
  deepseek_model: string;
  // Master switch for the optional LLM passes (章节、术语建议). Off keeps
  // everything beyond the summary on this machine.
  ai_enhance: boolean;
}

// One local model in the download manager. `status` is derived from the remote
// file listing, not from "does the folder exist" — a half-downloaded model looks
// identical on disk to a finished one.
export type ModelStatus = "missing" | "partial" | "ready" | "downloading" | "queued";

export interface ModelProgress {
  status: string;
  transferred_bytes: number;
  current_file: string;
  speed_bps: number;
  error: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
}

export interface ModelInfo {
  key: string;
  model_id: string;
  label: string;
  purpose: string;
  required: boolean;
  path: string;
  /** Ships inside the .app bundle: read-only, cannot be deleted or re-downloaded. */
  bundled: boolean;
  local_bytes: number;
  total_bytes: number;
  verified: boolean;
  missing_files: string[];
  status: ModelStatus;
  progress?: ModelProgress;
}

// Resolved MCP wiring for this install — paths differ between a dev checkout
// and the .app bundle, so the backend computes them.
export interface McpConfig {
  script_path: string;
  script_exists: boolean;
  runtime_path: string;
  client_config_path: string;
  uv_path: string;
  uv_found: boolean;
  snippet: string;
  tool_count: number;
}

export interface ModelsStatus {
  models: ModelInfo[];
  ready: boolean;
  required_missing: string[];
  total_bytes: number;
  local_bytes: number;
  downloading: string[];
}

// Result of POST /api/settings/test — a live probe of the LLM endpoint.
// `error` (friendly Chinese) is present only when `ok` is false.
export interface LlmTestResult {
  ok: boolean;
  model: string;
  latency_ms: number;
  error?: string;
}
