# DingTalk ingestion and authenticated Voice MCP

Deployment: 2026-10-21. This extension preserves the existing Voice SQLite data and audio files. The service release and state live under `~/Library/Application Support/AhamVoice`, outside iCloud Documents.

## Runtime

- API: `com.newvoice.backend`, port 8000; existing Voice session authentication.
- Frontend: `com.newvoice.frontend`, port 5173; `/app/integrations` manages sync and personal OAuth grants.
- Durable worker: `com.orchisky.voice-worker`, `python -m backend.app.voice_worker` in the ASR environment. A filesystem lock ensures one worker; SQLite commits each stage. Scheduler scans every 600 seconds independently of ASR.
- OAuth MCP: `com.orchisky.voice-mcp`, `python -m mcp_service.server` in an isolated venv using `mcp_service/requirements.txt`. Loopback port 8770.
- Tunnel: `com.orchisky.voice-public-tunnel`, restricted reverse SSH from Tencent loopback 18769 to Mac loopback 8770.
- nginx serves `https://ai.orchisky.cn/voice/mcp` and its OAuth discovery paths, without exposing the Voice API or file tree.

## Configuration and state

Set `RECORDING_AI_HOME` to the data directory for all processes. The private `voice-integration.json` specifies owner_id, dws_path, dws_profile, account_name, sync_since, pilot_uuid and public_issuer. Bind one verified profile to one active business user. `mcp-bridge-key` is 32 random bytes; the gateway authenticates internal requests with HMAC, timestamp and signed user/scopes. Keep these private files out of source control.

Tables `recording_sources`, `voice_jobs`, `voice_state`, `voice_title_history` live in the existing app database. OAuth uses a separate private SQLite database, storing only hashes of bearer credentials. Passwords and temporary Voice login sessions are not retained by the gateway. Each MCP call rechecks current user status and recording permissions.

## Synchronization behavior

The configured initial window begins 2026-10-14 10:27 Asia/Shanghai. Only owned (`mine`) minutes returned by DingTalk CLI are ingested. Incremental scans overlap seven days; a daily full scan repeats the configured baseline to catch late appearance. CLI completeness is checked; unavailable/untranscribed items omitted by DingTalk are not guaranteed to be discoverable.

Stages: download → import → transcribe → summary → title → writeback → done. Source profile/UUID and audio hashes prevent duplicate imports. Only one CPU transcription runs at once. Completed ASR/summary stages are reused after interruption. Transient failures back off at 1, 2 and 4 minutes, then remain visible for manual retry. Authentication failures and title conflicts require attention. Retrying starts from the saved stage.

Original local and source titles remain in source metadata and title history. Local manual edits lock the title. Before writing DingTalk, reread the remote title and reject unexpected changes. DingTalk may add its own MM-DD prefix: verify the exact generated theme or that exact dated theme. Never treat a CLI success/failed verification status alone as proof of the final title.

Disabling scheduled sync stops new scans, not existing queued work. Automatic naming and writeback have separate switches. The pilot gate prevents scheduled scanning before a real recording has completed and been independently read back.

## MCP connection

URL: `https://ai.orchisky.cn/voice/mcp`
Transport: Streamable HTTP. Authentication: OAuth 2.0 authorization code with PKCE S256. Dynamic registration is supported; no static client secret is needed. Required resource is the exact MCP URL. Default scope `voice:read`; optional `voice:manage` allows personal hotword updates for the authenticated user, and explicit sync/retry for the configured DingTalk owner only.

ChatGPT: Plugins → plus → Add custom MCP server → name and URL → OAuth → review and create as a plugin → connect using the local Voice username/password. In a new chat, select the plugin with @.

Codex CLI (verified installed flags):

```sh
codex mcp add orchisky-voice --url https://ai.orchisky.cn/voice/mcp --oauth-resource https://ai.orchisky.cn/voice/mcp --oauth-client-registration dcr
```

Follow the login prompt. If sign-in did not start:

```sh
codex mcp login orchisky-voice --oauth-client-registration dcr --scopes voice:read
```

For optional management tools, reauthorize with `--scopes voice:read,voice:manage`. Revoke individual grants on the local integration page. Access tokens last up to one hour; refresh credentials rotate and expire after 30 days. Refresh reuse revokes the grant.

Tools: voice_connection_status, voice_list_recordings, voice_search, voice_get_transcript, voice_get_summary, voice_recording_detail, voice_sync_status, voice_sync_now, voice_retry_job, voice_list_hotwords, voice_update_hotwords. Transcript tools paginate up to 100 segments and return next_offset. Date filters use source recording time when available.

## Verification and recovery

Tests:

```sh
python -m unittest discover -s tests -p test_voice_pipeline.py
python -m pytest tests/test_voice_oauth.py -q
npm ci --prefix frontend-src
npm run build --prefix frontend-src
```

Run pipeline tests in the ASR environment and OAuth tests in the MCP environment with pytest installed. Tests use temporary databases and synthetic users. Public acceptance additionally exercised real HTTPS, OAuth login, initialization, tool discovery, authorized reads, cross-user denial, read-scope denial and revocation using an ephemeral test account, removed afterward.

Pilot: 54m21s, 407 segments, 18,658 transcript characters and a 9,898-character current summary; local title `2026-10-20｜产品化边界与金蝶接入认证及定价交付口径讨论`, DingTalk title `产品化边界与金蝶接入认证及定价交付口径讨论`. Original 57 recordings, 22,504 segments and 57 summaries matched the pre-change SQLite backup row-for-row; original audio files exist.

Backup: `repair-backups/voice-integration-20261021-101632` inside the data home. Never restore this old database over new recordings. To roll back runtime, first stop worker/MCP/tunnel, preserve the current database, and repoint backend/frontend WorkingDirectory to the prior release. Additive integration tables may remain. The previous API's background queue is not a substitute for the durable worker.

The Mac must be on, online, and logged into the macOS user session for LaunchAgents. Closing this chat or the browser does not stop processing. Current Mac AC system sleep is disabled. Power loss with no logged-in user requires login before agents resume.

## Official connection references

- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli

## Claude interoperability and hotwords (2026-10-21 update)

All client Origins are accepted on discovery, OAuth and MCP, per owner request. CORS supports preflight and exposes WWW-Authenticate. Cross-origin cookie credentials are not enabled. The canonical Host remains enforced; correct password, flow-bound consent cookie/CSRF, PKCE, token audience, per-call user access and write scope checks remain in force. Do not replace these with anonymous access. Existing grants are not expanded automatically.

In Claude custom connector setup, use the same URL, OAuth sign-in and **Register automatically** (dynamic client registration), not the published-identity/CIMD option, which this server does not implement. Reconnect after deployment to refresh tools. A write-capable grant must include `voice:read voice:manage`. Clients requesting only read access can enable the unchecked optional management checkbox on the first-party consent page; it explicitly describes personal hotword updates and sync/retry side effects. The issued token reports actual granted scopes. Existing/read-only grants cannot write until the user reauthorizes.

`voice_list_hotwords` lists only the caller's personal manual words (query/limit/offset). `voice_update_hotwords` accepts 1–100 entries, keyed case-insensitively by `word`. Optional fields: `aliases` (list of common misrecognitions; replaces aliases for that word), `kind`, `weight` (1–10), `active` (false disables). Omitted fields and unrelated words remain unchanged. All rows update in one transaction, with before/after audit records; duplicates or invalid entries reject the entire batch. No other user's or external/shared source words are altered.

Example tool arguments:

```json
{"entries":[{"word":"金蝶","aliases":["金碟"],"weight":9},{"word":"兰之天","kind":"客户简称","weight":10}]}
```

These changes feed subsequent local transcription jobs; they do not reprocess historical transcripts or update DingTalk ASR vocabulary. Existing ASR filtering still applies (normally 2–8 characters and no formal company-name suffixes); returned `asr_eligible_terms` shows qualifying candidates. Personal product/system terms remain disabled across service restarts when explicitly disabled.

## Browser consent redirect correction

Browser testing reproduced a consumed consent form with an unredeemed authorization code: the original `form-action 'self'` policy blocked the POST's external 303 callback. Authorization and consent responses now permit the registered callback origin, with a single response CSP header. No arbitrary callback is accepted; registered redirect and PKCE validation remain unchanged.

The login form uses a nonce-authorized submit handler to show progress and disable duplicate submissions. Every flow has its own short-lived consent cookie, so opening a second authorization tab does not invalidate the first. Completed flows retain only hashes for ten minutes to display a friendly already-submitted page; they never issue a second authorization code. Expired/old forms explain how to restart from the client. Existing consumed forms cannot be reused: reconnect from Claude to obtain a new form.
