import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, readApiError } from '@/api/client';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/Button';

type Job = {id:string;recording_id?:string;source_title?:string;title?:string;stage:string;status:string;error?:string;title_locked:number;remote_applied_title?:string};
type Status = {configured:boolean;account_name:string;sync_enabled:boolean;auto_title:boolean;writeback_enabled:boolean;sync_since:string;pilot_passed?:{title:string};worker?:{epoch:number};last_sync?:{at:string;seen:number;added:number;error?:string};mcp_url:string;jobs:Job[]};
type Grant = {id:string;client_name:string;scopes:string;revoked:number;expires:number};
const stages:Record<string,string>={download:'下载录音',import:'导入录音',transcribe:'本地转写',summary:'生成纪要',title:'生成主题',writeback:'回写钉钉',done:'完成',summary_only:'生成纪要',transcribe_only:'重新转写'};
const states:Record<string,string>={queued:'等待处理',running:'处理中',retry:'等待重试',blocked:'需要重新授权',conflict:'标题冲突',failed:'失败',done:'完成'};

export function Integrations() {
  const qc=useQueryClient();const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const q=useQuery({queryKey:['voice-integrations'],queryFn:async()=>(await api.get<Status>('/integrations/dingtalk')).data,refetchInterval:5000});
  const grants=useQuery({queryKey:['voice-grants'],queryFn:async()=>(await api.get<Grant[]>('/integrations/mcp/grants')).data,refetchInterval:15000});
  async function act(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await qc.invalidateQueries({queryKey:['voice-integrations']});await qc.invalidateQueries({queryKey:['voice-grants']});}catch(e){setError(readApiError(e));}finally{setBusy(false);}}
  const d=q.data;const online=d?.worker && Date.now()/1000-d.worker.epoch<90;
  return <div className="page-body page--object-index"><PageHead title="钉钉同步与 MCP" subtitle="钉钉录音自动归档到本机，并通过授权连接查询转写内容。"/>
    {(error||q.error)&&<p role="alert" style={{color:'#c43b35'}}>{error||readApiError(q.error)}</p>}
    {!d?<p>正在读取同步状态…</p>:<>
      <section className="card" style={{padding:24,marginBottom:20}}>
        <h2 style={{fontSize:18,fontWeight:650,marginBottom:12}}>钉钉听记</h2><p>{d.configured?`已绑定：${d.account_name}`:'当前账号未绑定钉钉'} · 工作进程{online?'在线':'离线'}</p>
        <p>自动同步每 10 分钟执行。仅同步本人拥有、钉钉 CLI 可列出的听记；初始范围从 {d.sync_since?.slice(0,10)||'—'} 开始。重复扫描不会重复导入。</p>
        {d.pilot_passed?<p>真实录音验证已通过：{d.pilot_passed.title}</p>:<p>正在验证首条录音，通过后才能开启自动同步。</p>}
        <div style={{display:'flex',gap:24,flexWrap:'wrap',margin:'20px 0'}}>
          {([['sync_enabled','每 10 分钟自动同步'],['auto_title','自动生成会议主题'],['writeback_enabled','将主题回写钉钉']] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={d[key]} disabled={busy||!d.configured||(key==='sync_enabled'&&!d.pilot_passed)} onChange={e=>act(()=>api.patch('/integrations/dingtalk',{[key]:e.target.checked}))}/> {label}</label>)}
        </div>
        <Button disabled={busy||!d.configured||!d.pilot_passed} onClick={()=>act(()=>api.post('/integrations/dingtalk/sync'))}>立即同步</Button>
        {d.last_sync&&<p>最近同步：{d.last_sync.at} · {d.last_sync.error||`发现 ${d.last_sync.seen} 条，新增 ${d.last_sync.added} 条`}</p>}
        <p style={{color:'#64748b'}}>暂停自动同步会停止后续扫描，已入队任务继续处理。转写在本机完成，纪要和主题使用已配置的大模型。手工改过的标题会保留并停止自动回写。</p>
      </section>
      <section className="card" style={{padding:24,marginBottom:20}}><h2 style={{fontSize:18,fontWeight:650,marginBottom:12}}>外网 MCP 连接</h2><p>在支持 OAuth 的 MCP 客户端添加以下地址，使用本地录音系统账号登录并授权。</p><code style={{overflowWrap:'anywhere'}}>{d.mcp_url}</code><p>默认读取录音、逐字稿和纪要；手动同步和重试需要额外的 voice:manage 授权。Mac mini 需保持开机联网。</p>
        {grants.data?.map(g=><div key={g.id} style={{display:'flex',gap:16,alignItems:'center',padding:'8px 0'}}><span>{g.client_name} · {g.scopes} · {g.revoked?'已撤销':g.expires<Date.now()/1000?'已过期':'已授权'}</span>{!g.revoked&&<Button disabled={busy} onClick={()=>act(()=>api.delete(`/integrations/mcp/grants/${g.id}`))}>撤销授权</Button>}</div>)}
      </section>
      <section className="card" style={{padding:24}}><h2 style={{fontSize:18,fontWeight:650,marginBottom:12}}>处理记录</h2>{!d.jobs.length&&<p>暂无任务</p>}
        {d.jobs.map(j=><article key={j.id} style={{padding:'18px 0',borderBottom:'1px solid #e2e8f0'}}>
          <strong>{j.recording_id?<Link to={`/app/recordings/${j.recording_id}`}>{j.title||j.source_title}</Link>:j.source_title||'录音处理'}</strong>
          <p>{states[j.status]||j.status} · {stages[j.stage]||j.stage}{j.remote_applied_title?' · 钉钉标题已核验':''}{j.title_locked?' · 标题已锁定':''}</p>
          {j.error&&<p role="status" style={{color:'#b45309'}}>{j.error}</p>}
          <div style={{display:'flex',gap:12}}>
            {['failed','retry','blocked','conflict'].includes(j.status)&&<Button disabled={busy} onClick={()=>act(()=>api.post(`/integrations/jobs/${j.id}/retry`))}>从当前阶段重试</Button>}
            {j.recording_id&&j.source_title&&<Button disabled={busy} onClick={()=>{const title=window.prompt('编辑本地标题。保存后锁定标题，自动回写将停止。',j.title);if(title?.trim())act(()=>api.patch(`/recordings/${j.recording_id}/title`,{title,locked:true}));}}>编辑并锁定标题</Button>}
          </div>
        </article>)}
      </section>
    </>}
  </div>;
}
