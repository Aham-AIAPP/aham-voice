export async function setup(page, options = {}) {
  const state = { role: 'manager', emptySummary: false, apiError: '', uploadError: false, ...options };
  const requests = [], unexpected = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const user = { id: 'test-user', username: 'test-user', name: '林悦', email: '', mobile: '', role: state.role, team_id: 'test-team', managed_team_ids: ['*'], dept: '演示团队', status: 'active', source: 'local', must_change_password: !!state.mustChangePassword };
  const recordings = Array.from({length: 18}, (_,i) => ({
    id: 'rec-' + i, title: (i === 0 ? '远川制造 · 需求调研' : '项目会议 ' + i), filename: 'meeting.wav',
    owner_id: i % 2 ? 'other-user' : user.id, owner_name: i % 2 ? '陈言' : user.name, team_id: 'test-team',
    duration: 60, duration_label: '01:00', meeting_type: i % 2 ? '内部会议' : '客户调研', tag: '试用项目',
    asr_status: i === 2 ? 'queued' : i === 3 ? 'pending' : 'done',
    summary_status: i === 1 ? 'failed' : i === 2 ? 'pending' : 'done',
    created_at: '2026-10-26 09:00:00', updated_at: '2026-10-26 09:00:00',
  }));
  let summaries = [
    { id: 'summary-2', recording_id: 'rec-0', version: 2, content: state.emptySummary ? '   ' : '# 会议纪要\n\n确认试用范围，保留原有数据与权限。', model: 'test-model', is_current: 1, created_at: '2026-10-26 09:10:00', instruction: null },
    { id: 'summary-1', recording_id: 'rec-0', version: 1, content: '# 历史纪要\n\n这是第一版内容。', model: 'test-model', is_current: 0, created_at: '2026-10-26 09:05:00', instruction: null },
  ];
  if (state.richContent) summaries[0].content = '# 会议纪要\n\n确认试用范围，保留原有数据与权限。\n\n## 已确认事项\n\n- 先验证录音上传、逐字稿与会议纪要的完整流程。\n- 由林悦整理试用材料，陈言核对交付范围。\n- 现有账号权限和历史版本继续保留。\n\n## 行动安排\n\n| 事项 | 负责人 | 完成时间 |\n| --- | --- | --- |\n| 整理试用材料 | 林悦 | 2026-10-28 |\n| 核对交付范围 | 陈言 | 2026-10-30 |\n\n## 待确认\n\n试用后的验收时间由双方另行确认。纪要中的结论需结合逐字稿核对。';
  const segments = [
    { id: 'seg-1', speaker: '1', speaker_name: '林悦', start_sec: 0, end_sec: 1, start_label: '00:00', text: '第一轮试用先确认需求。', voiceprint_id: 'vp-1' },
    { id: 'seg-2', speaker: '2', speaker_name: null, start_sec: 1, end_sec: 2, start_label: '00:01', text: '需要保留现有功能。', voiceprint_id: null },
  ];
  if (state.longTranscript) for (let i = 2; i < 40; i++) segments.push({ ...segments[i % 2], id: 'seg-' + (i + 1), start_sec: i, end_sec: i + 1, start_label: '00:' + String(i).padStart(2, '0'), text: '按既定范围继续核对会议事项，并记录待确认的内容。' });
  const candidates = [
    { speaker: '1', speaker_name: '林悦', display_name: '林悦', total_duration: 10, total_duration_label: '00:10', segment_count: 1, voiceprint_id: 'vp-1', sample_segments: [segments[0]] },
    { speaker: '2', speaker_name: null, display_name: 'Speaker 2', total_duration: 2, total_duration_label: '00:02', segment_count: 1, voiceprint_id: null, sample_segments: [segments[1]] },
  ];
  let words = ['专业词', '产品名'];
  let voiceprints = [
    { id: 'vp-1', name: '林悦', owner_id: user.id, team_id: 'test-team', scope: 'personal', note: '', threshold: 0.5, active: 1, created_at: '2026-10-26 09:00:00' },
    { id: 'vp-other', name: '其他成员', owner_id: 'other-user', team_id: 'other-team', scope: 'global', note: '', threshold: 0.5, active: 1, created_at: '2026-10-26 09:00:00' },
  ];
  let emotion = null, queuedReads = 0, draft = null;
  // Short valid WAV enables real browser decoding/seek without any recording data.
  const wav = Buffer.alloc(44 + 8000 * 2 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length - 44,40);
  await page.addInitScript(() => localStorage.setItem('newvoice.token', 'fixture-token'));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), pathname = url.pathname, method = req.method();
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') { unexpected.push(req.url()); return route.abort(); }
    if (!pathname.startsWith('/api/')) return route.continue();
    requests.push({ path: pathname, method, search: url.search, body: req.postData(), auth: req.headers().authorization });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (state.apiError === pathname) return json({ detail: '测试请求失败，重试后继续。' }, 500);
    if (pathname === '/api/me') return state.expired ? json({detail:'Session expired'},401) : json(user);
    if (pathname === '/api/auth/login') { state.expired=false; return json({token:'fixture-token',user}); }
    if (pathname === '/api/auth/change-password') { user.must_change_password=false; return json(user); }
    if (pathname === '/api/auth/logout') return json({});
    if (pathname === '/api/recordings' && method === 'GET') {
      return json(recordings.filter(r => (url.searchParams.get('scope') !== 'mine' || r.owner_id === user.id) && (!url.searchParams.get('q') || r.title.includes(url.searchParams.get('q'))) && (!url.searchParams.get('meeting_type') || url.searchParams.get('meeting_type') === '全部' || r.meeting_type === url.searchParams.get('meeting_type'))));
    }
    if (pathname === '/api/recordings' && method === 'POST') {
      if (state.uploadError) return json({ detail: '上传测试失败' }, 500);
      recordings.push({...recordings[0],id:'uploaded',title:'上传验证',asr_status:'pending',summary_status:'pending'});
      return json(recordings.at(-1));
    }
    if (pathname.endsWith('/audio')) return route.fulfill({status:200,contentType:'audio/wav',body:wav});
    if (pathname.includes('/export/')) return route.continue();
    if (pathname.endsWith('/speaker-candidates')) return json(candidates);
    if (pathname.endsWith('/summary/revise/preview')) {
      const instruction = req.postDataJSON().instruction;
      draft = {draft_id:'draft-1',recording_id:'rec-0',base_summary_id:summaries[0].id,base_content:summaries[0].content,content:'# 修改后纪要\n\n'+instruction,model:'test-model',status:'awaiting_confirmation'};
      return json(draft);
    }
    if (pathname.endsWith('/summary/revise/apply')) {
      const instruction = '按议题整理';
      summaries = [{ ...summaries[0], id:'summary-3',version:3,content:draft.content, instruction, is_current:1}, ...summaries.map(s=>({...s,is_current:0}))];
      return json({summary_id:'summary-3',version:3});
    }
    if (pathname.endsWith('/summarize')) { queuedReads = 1; return json({recording_id:'rec-1',job_id:'job-summary',status:'queued'}); }
    if (pathname.endsWith('/process')) { const rec = recordings.find(r=>r.id===pathname.split('/')[3]); rec.asr_status='queued'; return json({status:'queued',recording_id:rec.id}); }
    if (pathname.endsWith('/emotion')) { emotion={id:'emotion-1',content:'# 情绪分析\n\n交流平稳。',model:'test-model',version:1,created_at:'2026-10-26 09:20:00'}; return json({status:'queued'}); }
    if (pathname.includes('/speakers/')) {
      const speaker=pathname.split('/').at(-1), name=req.postDataJSON().name;
      segments.find(s=>s.speaker===speaker).speaker_name=name; candidates.find(s=>s.speaker===speaker).speaker_name=name;
      return json({updated_segments:1});
    }
    if (pathname === '/api/voiceprints/from-recording') {
      const {speaker,name}=req.postDataJSON();
      segments.find(s=>s.speaker===speaker).speaker_name=name; candidates.find(s=>s.speaker===speaker).speaker_name=name;
      return json({profile:voiceprints[0],updated_segments:1});
    }
    if (/^\/api\/recordings\/[^/]+$/.test(pathname)) {
      const rec = recordings.find(r=>r.id===pathname.split('/').at(-1));
      if (!rec) return json({detail:'录音不存在'},404);
      if (queuedReads && rec.id === 'rec-1') { queuedReads++; if(queuedReads > 2) rec.summary_status='done'; }
      const empty = rec.asr_status !== 'done';
      return json({ recording:rec, segments:empty ? [] : segments, summary:empty ? null : summaries[0], summaries:empty ? [] : summaries, tasks:[], hotword_package:{asr_terms_count:2}, emotion_analysis:emotion, outputs:[] });
    }
    if (pathname === '/api/hotwords/words') return json(words);
    if (pathname === '/api/hotwords' && method === 'PUT') { words=req.postDataJSON().words; return json({ok:true,count:words.length,words}); }
    if (pathname === '/api/voiceprints') return json(voiceprints);
    if (pathname.startsWith('/api/voiceprints/')) {
      const id=pathname.split('/').at(-1);
      if(method==='DELETE') voiceprints=voiceprints.filter(v=>v.id!==id);
      else Object.assign(voiceprints.find(v=>v.id===id),req.postDataJSON());
      return json({ok:true});
    }
    if (pathname === '/api/teams') return json([{id:'test-team',name:'演示团队',dept:'测试',manager_ids:['test-user'],member_count:2,recording_count:18}]);
    if (pathname === '/api/users') return json([user]);
    if (pathname === '/api/audit') return json([{id:'a1',created_at:'2026-10-26 09:00:00',actor_name:'林悦',category:'recording.upload',message:'上传测试录音'}]);
    if (pathname === '/api/wecom/role-mappings') return json([]);
    if (pathname === '/api/wecom/config') return json({corp_id:'',sales_department_id:'',secret_configured:false});
    if (pathname === '/api/settings') return json({llm_configured:true,llm_model:'test-model',llm_api_base:'https://example.invalid',llm_provider:'test'});
    if (pathname === '/api/admin/overview') return json({active_users:2,team_count:1,today_processed_label:'1 小时',storage_label:'1 MB',integrations:[],recent_audit:[]});
    if (pathname === '/api/system/status') return json({base:'/test',db:'/test/db.sqlite',paraformer:true,vad:true,punc:true,voiceprint:true,ffmpeg:true});
    if (pathname === '/api/integrations/dingtalk') return json({configured:true,account_name:'演示账号',sync_enabled:false,auto_title:false,writeback_enabled:false,sync_since:'2026-10-26',worker:{epoch:Date.now()/1000},mcp_url:'https://example.invalid/voice/mcp',jobs:[]});
    if (pathname === '/api/integrations/mcp/grants') return json([]);
    unexpected.push(method+' '+pathname); return json({detail:'Unmocked endpoint'},501);
  });
  return {state, requests,unexpected,errors,recordings,user,segments};
}
