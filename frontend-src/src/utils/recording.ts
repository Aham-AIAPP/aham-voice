import type { Recording } from '@/api/types';
export type RecordingState = 'failed' | 'active' | 'done' | 'pending';
export function recordingState(rec: Recording): RecordingState {
  if ([rec.asr_status, rec.summary_status].some(s => s === 'running' || s === 'queued')) return 'active';
  if (rec.asr_status === 'failed' || rec.summary_status === 'failed') return 'failed';
  if (rec.asr_status === 'done' && rec.summary_status === 'done') return 'done';
  return 'pending';
}
export function recordingStatus(rec: Recording) {
  const state = recordingState(rec);
  if (state === 'active') return { tone: 'accent' as const, label: rec.asr_status === 'queued' || rec.summary_status === 'queued' ? '排队中' : rec.asr_status === 'running' ? '正在转写' : '正在生成纪要' };
  if (state === 'failed') return { tone: 'rust' as const, label: rec.asr_status === 'failed' ? '转写失败' : '纪要失败' };
  if (state === 'done') return { tone: 'moss' as const, label: '已生成' };
  return { tone: 'muted' as const, label: rec.asr_status === 'done' ? '等待纪要' : '未开始' };
}
