"""Single durable worker. Run with python -m backend.app.voice_worker."""
import fcntl
import logging
import os
import threading
import time

from . import main as m
from . import voice_integration as v

log = logging.getLogger('voice-worker')


def recover():
    # Only the worker holding the filesystem lock can recover leases. Partial
    # transcript rows alone never prove a completed ASR transaction.
    with m.db() as c:
        c.execute("update voice_jobs set status='queued',updated_at=? where status='running'",(v.timestamp(),))
        c.execute("update tasks set status='failed',error='工作进程中断，任务已重新排队',finished_at=?,updated_at=? where status='running'",(m.now(),m.now()))
        c.execute("update recordings set asr_status='queued' where asr_status='running'")
        c.execute("update recordings set summary_status='pending' where summary_status='running'")
        rows=c.execute("select id,owner_id from recordings where asr_status='queued'").fetchall()
    for row in rows:
        try:v.enqueue(row['id'],row['owner_id'])
        except Exception:log.exception('Cannot recover recording %s',row['id'])


def claim():
    with m.db() as c:
        c.execute('BEGIN IMMEDIATE')
        row=c.execute("select * from voice_jobs where status in ('queued','retry') and available_at<=? order by created_at,id limit 1",(time.time(),)).fetchone()
        if not row:return None
        c.execute("update voice_jobs set status='running',updated_at=? where id=?",(v.timestamp(),row['id']))
        return dict(row)


def fail(job,exc):
    with m.db() as c:live=dict(c.execute('select * from voice_jobs where id=?',(job['id'],)).fetchone())
    count=live['attempt']+1;message=v.sanitize_error(exc)
    if isinstance(exc,v.TitleConflict):status='conflict'
    elif any(s in message.lower() for s in ['unauthorized','token expired','未登录','授权过期','invalid_grant']):status='blocked'
    else:status='retry' if count<4 else 'failed'
    v.update_job(job['id'],status=status,attempt=count,error=message,available_at=time.time()+min(3600,60*2**(count-1)))
    log.error('Job %s stage=%s status=%s: %s',job['id'],live['stage'],status,message)


def scheduler(stop):
    while not stop.wait(5):
        try:
            v.set_state('worker_heartbeat',{'at':v.timestamp(),'epoch':time.time(),'pid':os.getpid()})
            due=time.time()-v.state('last_scan_attempt',0)>=600
            if v.state('pilot_passed') and (v.state('sync_requested',False) or (v.state('sync_enabled',False) and due)):
                v.set_state('sync_requested',False)
                v.set_state('last_scan_attempt',time.time())
                try:v.scan()
                except Exception as exc:
                    v.set_state('last_sync',{'at':v.timestamp(),'error':v.sanitize_error(exc),'complete':False})
                    log.error('Sync failed: %s',v.sanitize_error(exc))
        except Exception:log.exception('Scheduler failure')


def main():
    logging.basicConfig(level=logging.WARNING,format='%(asctime)s %(levelname)s %(message)s')
    lock=(m.BASE/'voice-worker.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('Another voice worker already owns the queue')
    m.ensure_schema();v.ensure_schema();recover()
    stop=threading.Event()
    threading.Thread(target=scheduler,args=(stop,),daemon=True,name='voice-scheduler').start()
    while True:
        job=claim()
        if not job:time.sleep(2);continue
        try:v.run_job(job)
        except Exception as exc:fail(job,exc)


if __name__=='__main__':main()
