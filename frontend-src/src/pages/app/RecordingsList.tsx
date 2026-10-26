import { Fragment, useLayoutEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchRecordings } from '@/api/endpoints';
import { Button } from '@/components/Button';
import { Status } from '@/components/Status';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/EmptyState';
import { PageLoading } from '@/components/PageLoading';
import { Diag } from '@/components/Diag';
import { useAuth } from '@/context/auth';
import { readApiError } from '@/api/client';
import { recordingState, recordingStatus } from '@/utils/recording';
import type { Recording } from '@/api/types';

const MEETING_TYPES = ['全部', '内部会议', '客户调研', '方案汇报', '销售电话'];
const STATES = ['all', 'active', 'failed', 'done', 'pending'];

export function RecordingsList() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const latestParams = useRef(params);
  useLayoutEffect(() => { latestParams.current = params; }, [params]);
  const navigate = useNavigate();
  const canSeeTeam = user?.role === 'manager';
  const isOrgWide = canSeeTeam && (user?.managed_team_ids ?? []).includes('*');
  const scope = canSeeTeam && (params.get('scope') === 'team' || (!params.has('scope') && isOrgWide)) ? 'team' : 'mine';
  const q = params.get('q') ?? '';
  const meetingType = MEETING_TYPES.includes(params.get('type') ?? '') ? params.get('type')! : '全部';
  const state = STATES.includes(params.get('status') ?? '') ? params.get('status')! : 'all';
  function filter(key: string, value: string) {
    const next = new URLSearchParams(latestParams.current);
    if (!value || value === '全部' || value === 'all') next.delete(key);
    else next.set(key, value);
    latestParams.current = next;
    setParams(next, { replace: true });
  }
  function clearFilters() {
    const next = new URLSearchParams({ scope });
    latestParams.current = next;
    setParams(next, { replace: true });
  }
  const query = useQuery({
    queryKey: ['recordings', scope, meetingType, q],
    queryFn: () => fetchRecordings({ scope, meeting_type: meetingType, q }),
    refetchInterval: 6000,
  });
  const filtered = (query.data ?? []).filter(rec => state === 'all' || recordingState(rec) === state);
  const groups = new Map<string, Recording[]>();
  for (const rec of filtered) {
    const day = rec.updated_at?.slice(0, 10) || '日期未记录';
    groups.set(day, [...(groups.get(day) ?? []), rec]);
  }
  const hasFilters = !!q || meetingType !== '全部' || state !== 'all';
  const backTo = '/app/recordings' + (params.size ? '?' + params : '');
  return (
    <div className="recordings-page">
      <h1 className="sr-only">录音库</h1>
      <div className="recordings-toolbar">
        {canSeeTeam && <div className="filter-bar__segments" role="group" aria-label="可见范围">
          <button aria-pressed={scope === 'mine'} onClick={() => filter('scope', 'mine')}>我的录音</button>
          <button aria-pressed={scope === 'team'} onClick={() => filter('scope', 'team')}>{isOrgWide ? '全部录音' : '团队录音'}</button>
        </div>}
        <label className="recordings-search">
          <Icon name="search" size={14} />
          <input type="search" aria-label="搜索录音" placeholder="搜索标题、客户、标签、成员" value={q} onChange={e => filter('q', e.target.value)} />
        </label>
        <Button variant="primary" onClick={() => navigate('/app/recordings/new')}>上传录音</Button>
      </div>
      <div className="recordings-filters">
        <span className="recordings-count" role="status">{query.isLoading ? '加载中' : query.isError ? '加载失败' : filtered.length + ' 条录音'}</span>
        <select value={state} onChange={e => filter('status', e.target.value)} aria-label="处理状态">
          <option value="all">全部状态</option><option value="active">处理中</option><option value="failed">处理失败</option><option value="done">已生成</option><option value="pending">未完成</option>
        </select>
        <select value={meetingType} onChange={e => filter('type', e.target.value)} aria-label="会议类型">
          {MEETING_TYPES.map(t => <option key={t} value={t}>{t === '全部' ? '全部类型' : t}</option>)}
        </select>
        {hasFilters && <Button size="sm" onClick={clearFilters}>清除筛选</Button>}
      </div>
      {query.isError ? <Diag code="REC_E_LIST">{readApiError(query.error)}<Button onClick={() => query.refetch()}>重试</Button></Diag> : query.isLoading ? <PageLoading /> : filtered.length === 0 ? (
        <EmptyState description={hasFilters ? '当前条件没有匹配的录音。' : '还没有录音，上传一段开始。'} action={<Button onClick={() => hasFilters ? clearFilters() : navigate('/app/recordings/new')}>{hasFilters ? '清除筛选' : '上传录音'}</Button>} />
      ) : <table className="recordings-table" aria-label="录音库">
        <colgroup><col /><col className="recordings-state" /><col className="recordings-type" /><col className="recordings-tag" /><col className="recordings-duration" /><col className="recordings-date" /><col className="recordings-owner" /></colgroup>
        <thead className="recordings-columns"><tr><th scope="col">录音名称</th><th scope="col">状态</th><th scope="col">会议类型</th><th scope="col" className="recordings-tag">客户 / 项目</th><th scope="col" className="recordings-duration">时长</th><th scope="col" className="recordings-date">更新</th><th scope="col" className="recordings-owner">成员</th></tr></thead>
        <tbody>{[...groups.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([day, rows]) => <Fragment key={day}>
          <tr className="recordings-group"><th colSpan={7} scope="rowgroup">{day}<span>{rows.length} 条</span></th></tr>
          {rows.map(rec => {
            const status = recordingStatus(rec);
            const to = '/app/recordings/' + rec.id;
            return <tr key={rec.id} className="recordings-row" onClick={e => { if (!(e.target as HTMLElement).closest('a')) navigate(to, { state: { backTo } }); }}>
              <td className="recordings-name"><Link to={to} state={{ backTo }} title={rec.title}>{rec.title}</Link></td>
              <td className="recordings-state"><Status tone={status.tone}>{status.label}</Status></td>
              <td className="recordings-type"><span className="recording-tag">{rec.meeting_type || '未选择'}</span></td>
              <td className="recordings-tag" title={rec.tag ?? undefined}>{rec.tag || '未填写'}</td>
              <td className="recordings-duration tnum">{rec.duration_label}</td>
              <td className="recordings-date" title={rec.updated_at}>{rec.updated_at?.slice(11, 16)}</td>
              <td className="recordings-owner"><span title={rec.owner_name || '未指定'} aria-label={'所属成员：' + (rec.owner_name || '未指定')}><Avatar name={rec.owner_name} size="sm" /></span></td>
            </tr>;
          })}
        </Fragment>)}</tbody>
      </table>}
    </div>
  );
}
