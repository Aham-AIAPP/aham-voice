import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchRecording, processRecording, summarizeRecording, generateEmotion, recordingAudioUrl, exportSummaryVersionUrl, exportTranscriptUrl, exportEmotionUrl } from '@/api/endpoints';
import { readApiError } from '@/api/client';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Diag } from '@/components/Diag';
import { PageLoading } from '@/components/PageLoading';
import { EmptyState } from '@/components/EmptyState';
import { Status } from '@/components/Status';
import { Avatar } from '@/components/Avatar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { recordingStatus, recordingState } from '@/utils/recording';
import { SpeakersCard } from './SpeakersCard';
import { Timeline } from './Timeline';
import { Preview, TRANSCRIPT_KEY, EMOTION_KEY, type ArtifactKey } from './Preview';
import { ReviseComposer } from './ReviseComposer';
import { Drawer } from './Drawer';

export function RecordingDetail() {
  const { id } = useParams<{ id: string }>();
  return <RecordingContent key={id} recordingId={id ?? ''} />;
}

function RecordingContent({ recordingId }: { recordingId: string }) {
  const qc = useQueryClient();
  const location = useLocation();
  const from = location.state?.backTo;
  const backTo = typeof from === 'string' && (from === '/app/recordings' || from.startsWith('/app/recordings?')) ? from : '/app/recordings';
  const audioRef = useRef<HTMLAudioElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const [mediaError, setMediaError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null);
  const [hasRevisionPreview, setHasRevisionPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState<ArtifactKey | null>(null);
  const [confirmReprocess, setConfirmReprocess] = useState(false);
  const [requestedSnapshot, setRequestedSnapshot] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['recording', recordingId],
    queryFn: () => fetchRecording(recordingId),
    enabled: !!recordingId,
    // Queued summary_only jobs do not immediately change recording status.
    // Keep polling while this view is open, including after queued retries.
    refetchInterval: 6000,
  });
  useEffect(() => {
    if (!location.hash || detail.isLoading) return;
    const frame = requestAnimationFrame(() => readerRef.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [location.hash, location.key, detail.isLoading]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['recording', recordingId] });
    qc.invalidateQueries({ queryKey: ['recordings'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['speaker-candidates', recordingId] });
  };
  const action = useMutation({
    mutationFn: (kind: 'process' | 'summary') => kind === 'process' ? processRecording(recordingId) : summarizeRecording(recordingId),
    onSuccess: () => { setRequestedSnapshot(snapshot); invalidate(); },
  });
  const emotionMut = useMutation({ mutationFn: () => generateEmotion(recordingId), onSuccess: invalidate });

  if (detail.isLoading) return <div className="record-loading"><PageLoading /></div>;
  if (detail.isError) return <div className="record-loading"><Diag code="REC_E_DETAIL">{readApiError(detail.error)}</Diag><Button onClick={() => detail.refetch()}>重试</Button><Link to={backTo}>返回录音库</Link></div>;
  if (!detail.data) return <EmptyState description="没有这条录音。" />;

  const { recording: rec, segments, tasks, hotword_package: pkg, emotion_analysis: emotion } = detail.data;
  const summaries = detail.data.summaries.length ? detail.data.summaries : detail.data.summary ? [detail.data.summary] : [];
  const currentSummary = summaries.find(s => s.is_current) ?? summaries[0] ?? null;
  const selectedSummary = summaries.find(s => s.id === selectedSummaryId) ?? currentSummary;
  const hasSummary = !!currentSummary?.content?.trim();
  const showSummary = summaries.some(s => s.content?.trim());
  const showEmotion = !!emotion?.content?.trim() || rec.asr_status === 'done';
  const hasSelectedContent = !!selectedSummary?.content?.trim();
  // The panel already labels the document; retain its original content for exports.
  const summaryBody = selectedSummary?.content.replace(/^\s*#{1,2}[ \t]+会议纪要[ \t]*(?:\r?\n|$)/u, '') ?? '';
  const isCurrent = selectedSummary?.id === currentSummary?.id;
  const snapshot = JSON.stringify([rec.asr_status, rec.summary_status, currentSummary?.id, tasks.map(t => [t.id, t.status, t.updated_at])]);
  const waiting = requestedSnapshot === snapshot;
  const processing = recordingState(rec) === 'active';
  const pipelineBusy = processing || waiting || action.isPending;
  const emotionRunning = tasks.some(t => t.step.includes('情绪') && (t.status === 'running' || t.status === 'queued'));
  const status = recordingStatus(rec);
  const needsSummary = rec.asr_status === 'done' && (!hasSummary || rec.summary_status === 'failed');
  const failure = [...tasks].reverse().find(t => t.status === 'failed');
  const currentTask = [...tasks].reverse().find(t => t.status === 'running' || t.status === 'queued');
  const summaryMissing = rec.summary_status === 'done' && !hasSummary;
  const description = waiting ? '等待录音服务开始处理，页面会自动更新。'
    : processing ? (currentTask ? '录音服务正在执行：' + currentTask.step + ' · ' + currentTask.elapsed_label : '录音服务正在处理，页面会自动更新。')
    : rec.asr_status === 'failed' ? '转写失败，可以重试录音处理。'
    : rec.summary_status === 'failed' ? '纪要生成失败，已有逐字稿和历史版本仍可查看。'
    : summaryMissing ? '纪要状态已完成，但正文为空。需要重新生成纪要。'
    : hasSummary ? '纪要已生成，等待你核对；可对照逐字稿、修改或导出。'
    : rec.asr_status === 'done' ? '转写已完成，可以生成会议纪要。' : '录音已保存，可以开始转写和生成纪要。';
  const availableViews = [showSummary && 'summary', segments.length > 0 && 'transcript', showEmotion && 'emotion'].filter(Boolean);
  const requestedView = location.hash.replace('#record-', '');
  const activeView = availableViews.includes(requestedView) ? requestedView : availableViews[0];
  const viewLink = (view: string) => ({ pathname: location.pathname, search: location.search, hash: '#record-' + view });
  const speakerIds = [...new Set(segments.map(s => s.speaker))];
  const uniqueSpeakers = new Set(segments.map(s => s.speaker)).size;
  const matched = new Set(segments.filter(s => s.voiceprint_id).map(s => s.speaker)).size;

  function updatePlaybackPosition(seconds: number) {
    const segment = segments.find(s => s.start_sec <= seconds && seconds < s.end_sec);
    setActiveSegmentId(segment?.id ?? null);
  }

  function seek(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    setMediaError('');
    try {
      audio.currentTime = seconds;
      updatePlaybackPosition(seconds);
      audio.play().catch(() => setMediaError('播放未开始，可使用播放器重试。'));
    } catch { setMediaError('音频尚未就绪，加载后再定位。'); }
  }

  return <div className="record-page">
    <div className="record-heading">
      <Link to={backTo} className="record-back">返回录音库</Link>
      <div className="record-title-row">
        <h1>{rec.title}</h1>
        {pipelineBusy ? <Button variant="primary" disabled>{waiting ? '等待处理' : '处理中'}</Button>
          : needsSummary ? <Button variant="primary" onClick={() => action.mutate('summary')}>{rec.summary_status === 'failed' || summaryMissing ? '重试纪要' : '生成纪要'}</Button>
          : rec.asr_status !== 'done' ? <Button variant="primary" onClick={() => action.mutate('process')}>{rec.asr_status === 'failed' ? '重试转写' : '开始处理'}</Button>
          : null}
      </div>
      <div className="record-subtitle"><Status tone={summaryMissing ? 'rust' : status.tone}>{summaryMissing ? '纪要正文缺失' : status.label}</Status><span className="tnum">{rec.duration_label}</span><span>{segments.length} 段发言 · {uniqueSpeakers} 位说话人</span></div>
      <div className="record-next" role="status">{description}{processing && currentTask && <progress value={currentTask.progress} max={100} aria-label="当前处理进度" />}</div>
      {!processing && !waiting && recordingState(rec) === 'failed' && failure?.error && <p className="record-error">{failure.error}</p>}
      {action.isError && <Diag code="REC_E_ACTION">{readApiError(action.error)}</Diag>}
    </div>
    <div className="record-layout">
      <div className="record-content" ref={readerRef}>
        <div className="record-reading-tools">
          <section className="record-audio" aria-label="录音播放">
            <audio ref={audioRef} controls preload="metadata" src={recordingAudioUrl(recordingId)} onError={() => setMediaError('音频加载失败，可刷新页面重试。')} onPlaying={() => { setMediaError(''); setIsPlaying(true); }} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} onTimeUpdate={e => updatePlaybackPosition(e.currentTarget.currentTime)} onSeeked={e => updatePlaybackPosition(e.currentTarget.currentTime)} />
            {mediaError && <p className="record-error" role="alert">{mediaError}</p>}
          </section>
          <div className="record-toolbar">
            <nav className="record-anchors" aria-label="内容导航">
              {showSummary && <Link to={viewLink('summary')} state={location.state} replace preventScrollReset aria-current={activeView === 'summary' ? 'page' : undefined}><Icon name="file-text" />会议纪要</Link>}
              {segments.length > 0 && <Link to={viewLink('transcript')} state={location.state} replace preventScrollReset aria-current={activeView === 'transcript' ? 'page' : undefined}><Icon name="text-align-start" />逐字稿</Link>}
              {showEmotion && <Link to={viewLink('emotion')} state={location.state} replace preventScrollReset aria-current={activeView === 'emotion' ? 'page' : undefined}><Icon name="chart-no-axes-combined" />情绪分析</Link>}
            </nav>
            <div className="record-export-actions" aria-label="导出文件">
              {segments.length > 0 && <a className="btn btn--secondary" href={exportTranscriptUrl(recordingId)} download title="导出完整逐字稿，包含说话人与时间戳（Markdown）"><Icon name="download" />导出转写</a>}
              {hasSelectedContent && activeView === 'summary' && <a className={'btn ' + (hasRevisionPreview ? 'btn--secondary' : 'btn--primary')} href={exportSummaryVersionUrl(recordingId, selectedSummary!.id)} download><Icon name="download" />导出纪要{!isCurrent ? ' v' + selectedSummary!.version : ''}</a>}
              {emotion?.content?.trim() && activeView === 'emotion' && <a className="btn btn--primary" href={exportEmotionUrl(recordingId)} download><Icon name="download" />导出分析</a>}
            </div>
          </div>
        </div>
        {showSummary && <section id="record-summary" className="record-section" hidden={activeView !== 'summary'}>
          <header className="record-section-head"><h2>会议纪要</h2>
            {summaries.length > 0 && <select aria-label="纪要版本" value={selectedSummary?.id ?? ''} onChange={e => setSelectedSummaryId(e.target.value === currentSummary?.id ? null : e.target.value)}>
              {summaries.map(s => <option key={s.id} value={s.id}>v{s.version}{s.id === currentSummary?.id ? ' · 当前版本' : ' · 历史版本'}</option>)}
            </select>}
          </header>
          {selectedSummary && <p className="record-source">AI 生成 · {selectedSummary.model} · {selectedSummary.created_at}{segments.length > 0 && <> · <Link to={viewLink('transcript')} state={location.state} replace preventScrollReset>查看逐字稿依据</Link></>}{!isCurrent && <Button size="sm" onClick={() => setSelectedSummaryId(null)}>返回当前版本</Button>}</p>}
          {hasSelectedContent ? <article className="markdown record-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryBody}</ReactMarkdown></article>
            : <p className="record-muted">{pipelineBusy ? '纪要处理中，完成后自动显示。' : '还没有可阅读的纪要正文。'}</p>}
          {hasSummary && isCurrent && <details className="record-revise"><summary>修改纪要</summary>
            <ReviseComposer recordingId={recordingId} currentSummaryId={currentSummary!.id} onPreviewChange={setHasRevisionPreview} disabled={pipelineBusy || rec.asr_status !== 'done'} disabledReason={pipelineBusy ? '处理完成后可以修改纪要' : '转写完成后可以修改纪要'} />
          </details>}
        </section>}
        {segments.length > 0 && <section id="record-transcript" className="record-section" hidden={activeView !== 'transcript'}>
          <header className="record-section-head"><h2>录音转写</h2><span className="record-section-count">{segments.length} 段发言 · {uniqueSpeakers} 位说话人</span></header>
          <p className="record-muted transcript-hint">点击时间，定位并播放对应发言。</p>
          {segments.length ? <ol className="record-transcript">{segments.map(seg => <li key={seg.id} aria-current={activeSegmentId === seg.id ? 'true' : undefined}>
            <button className="transcript-time tnum" onClick={() => seek(seg.start_sec)} aria-label={'播放 ' + seg.start_label + ' 的发言'}>{seg.start_label}</button>
            <div className="transcript-body">
              <div className="transcript-meta"><span className="transcript-speaker-mark" data-color={speakerIds.indexOf(seg.speaker) % 4} aria-hidden="true"><Icon name="user-round" size={14} /></span><span>{seg.speaker_name || '说话人 ' + seg.speaker}</span>{activeSegmentId === seg.id && <span className="transcript-playing">{isPlaying ? '正在播放' : '已定位'}</span>}</div>
              <p>{seg.text}</p>
            </div>
          </li>)}</ol> : <p className="record-muted">{processing ? '转写进行中，完成后自动显示。' : '还没有逐字稿。'}</p>}
        </section>}
        {showEmotion && <section id="record-emotion" className="record-section" hidden={activeView !== 'emotion'}>
          <header className="record-section-head"><h2>对话情绪分析</h2>{emotion?.content?.trim() && <span className="record-section-count">v{emotion.version}</span>}</header>
          {emotion?.content?.trim() ? <div className="record-analysis"><p className="record-source">AI 生成 · {emotion.model} · <Link to={viewLink('transcript')} state={location.state} replace preventScrollReset>查看逐字稿依据</Link></p><article className="markdown record-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{emotion.content}</ReactMarkdown></article></div> : <>
            <p className="record-muted">按需分析说话情绪、客户意向与异议。</p>
            <Button variant="secondary" disabled={rec.asr_status !== 'done' || pipelineBusy || emotionRunning} loading={emotionMut.isPending} onClick={() => emotionMut.mutate()}>{emotionRunning ? '正在分析' : '生成情绪分析'}</Button>
          </>}
          {emotionMut.isError && <Diag code="REC_E_EMOTION">{readApiError(emotionMut.error)}</Diag>}
        </section>}
        <details className="record-fold record-history"><summary>处理与修改记录 <span>{tasks.length} 个任务 · {summaries.length} 个纪要版本 · {rec.owner_name} · {rec.updated_at}</span></summary>
          <Timeline recording={rec} tasks={tasks} summaries={summaries} segments={segments} emotion={emotion}
            onPreviewSummary={summaryId => setPreviewKey('summary:' + summaryId)}
            onPreviewTranscript={() => setPreviewKey(TRANSCRIPT_KEY)} onPreviewEmotion={() => setPreviewKey(EMOTION_KEY)}
            onGenerateEmotion={() => emotionMut.mutate()} emotionPending={emotionMut.isPending || emotionRunning || pipelineBusy} activePreviewKey={previewKey} />
        </details>
      </div>
      <aside className="record-properties" aria-label="录音属性">
        <h2>录音属性</h2>
        <dl>
          <div><dt>所属成员</dt><dd><Avatar name={rec.owner_name} size="sm" />{rec.owner_name || '未指定'}</dd></div>
          <div><dt>会议类型</dt><dd>{rec.meeting_type || '未选择'}</dd></div>
          <div><dt>客户 / 项目</dt><dd>{rec.tag || '未填写'}</dd></div>
          <div><dt>原始文件</dt><dd>{rec.filename}</dd></div>
          <div><dt>创建时间</dt><dd>{rec.created_at}</dd></div>
          <div><dt>更新时间</dt><dd>{rec.updated_at}</dd></div>
          <div><dt>热词</dt><dd>{pkg?.asr_terms_count ? '已启用 ' + pkg.asr_terms_count + ' 条' : '未启用'}</dd></div>
          <div><dt>声纹匹配</dt><dd>{uniqueSpeakers ? matched + ' / ' + uniqueSpeakers + ' 位' : '等待转写'}</dd></div>
        </dl>
        {segments.length > 0 && <SpeakersCard recordingId={recordingId} asrStatus={rec.asr_status} />}
        <details className="record-fold record-advanced"><summary>处理操作</summary>
          <p className="record-muted">重新处理会重新转写并生成纪要，已有的说话人命名可能需要重新核对。</p>
          <Button variant="secondary" disabled={pipelineBusy} onClick={() => setConfirmReprocess(true)}>重新处理整条录音</Button>
        </details>
      </aside>
    </div>
    <ConfirmDialog open={confirmReprocess} title="重新处理整条录音？" body="将重新转写并生成纪要，当前逐字稿和说话人结果会更新。" confirmText="重新处理" onCancel={() => setConfirmReprocess(false)} onConfirm={() => { setConfirmReprocess(false); action.mutate('process'); }} />
    <Drawer open={previewKey !== null} raw onClose={() => setPreviewKey(null)}>
      {previewKey !== null && <Preview recordingId={recordingId} summaries={summaries} segments={segments} emotion={emotion} selected={previewKey} onSelect={setPreviewKey} onClose={() => setPreviewKey(null)} />}
    </Drawer>
  </div>;
}
