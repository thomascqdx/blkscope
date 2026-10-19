import glob
import numpy as np
import pandas as pd
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
path = glob.glob('work/*.trace')[0]
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300, ingest_ftrace_in_raw=True))

def Q(s):
    d = tp.query(s).as_pandas_dataframe()
    for c in d.columns:
        try:
            d[c] = pd.to_numeric(d[c])
        except (ValueError, TypeError):
            pass
    return d

def ev(name, keys):
    cols = ', '.join(f"extract_arg(arg_set_id,'{k}') as \"{k}\"" for k in keys)
    return Q(f"select ts, utid, {cols} from ftrace_event where name='{name}' order by ts")

ins = ev('block_rq_insert', ['dev', 'sector', 'nr_sector', 'bytes', 'rwbs'])
iss = ev('block_rq_issue', ['dev', 'sector', 'nr_sector', 'bytes', 'rwbs'])
cmp_ = ev('block_rq_complete', ['dev', 'sector', 'nr_sector', 'rwbs', 'error'])
mk = ev('block_rq_mq_make_request', ['pid', 'sector', 'rwbs', 'class', 'priority', 'is_ux_task', 'is_ux_loop', 'FG_META', 'type', 'data'])
mq = ev('block_rq_mq_complete_request', ['sector', 'req_tag', 'rwbs'])
rq = Q("select ts, extract_arg(arg_set_id,'rq_log') rq_log from ftrace_event where name='block_rq_mq_requeue_request'")

print('devs', ins.dev.value_counts().to_dict())
for k in ['class', 'priority', 'is_ux_task', 'is_ux_loop', 'FG_META', 'type', 'data']:
    print(k, mk[k].value_counts().head(8).to_dict())
rq['reason'] = rq.rq_log.str.extract(r'requeue_reason: (\d+)')
print('requeue reasons', rq.reason.value_counts().to_dict())
print('requeue rq_log sample', rq.rq_log.iloc[0])

# pair: complete <- last issue (same dev,sector) <- last insert
def pair(left, right, lname, rname):
    l = left.rename(columns={'ts': lname}).sort_values(lname)
    r = right.rename(columns={'ts': rname})[[rname, 'dev', 'sector']].sort_values(rname)
    return pd.merge_asof(l, r, left_on=lname, right_on=rname, by=['dev', 'sector'], direction='backward')
p = pair(cmp_[['ts', 'dev', 'sector', 'nr_sector', 'rwbs']], iss, 't_c', 't_i')
p = pair(p.rename(columns={'t_c': 'tc'}).rename(columns={'tc': 't_c'}), ins, 't_c', 't_ins') if False else p
ins2 = ins.rename(columns={'ts': 't_ins'})[['t_ins', 'dev', 'sector', 'utid', 'bytes']].sort_values('t_ins')
p = pd.merge_asof(p.dropna(subset=['t_i']).sort_values('t_i').astype({'t_i': 'int64'}), ins2, left_on='t_i', right_on='t_ins', by=['dev', 'sector'], direction='backward')
p['svc_ms'] = (p.t_c - p.t_i) / 1e6
p['q_ms'] = (p.t_i - p.t_ins) / 1e6
print(f'\npaired {len(p)} / complete {len(cmp_)}; with insert {p.t_ins.notna().mean():.3f}')
for c in ['svc_ms', 'q_ms']:
    print(c, p[c].quantile([.5, .9, .99, .999, 1]).round(3).to_dict())
p['kb'] = p.nr_sector / 2
print('size KB dist', p.kb.value_counts().head(8).to_dict())
print('svc p50/p99 by size bucket', p.groupby(pd.cut(p.kb, [0, 4, 16, 64, 256, 1e9])).svc_ms.quantile([.5, .99]).unstack().round(3).to_dict())

# concurrency: in-flight (issue..complete) and waiting (insert..issue)
def maxconc(starts, ends):
    e = np.concatenate([np.stack([starts, np.ones(len(starts))], 1), np.stack([ends, -np.ones(len(ends))], 1)])
    e = e[np.lexsort((e[:, 1], e[:, 0]))]
    c = np.cumsum(e[:, 1])
    return int(c.max()), e[:, 0], c
mx, t, c = maxconc(p.t_i.values, p.t_c.values)
dur = np.diff(t, append=t[-1])
print(f'\nmax in-flight {mx}; time-weighted depth hist', {int(k): round(v / dur.sum(), 3) for k, v in pd.Series(dur).groupby(np.minimum(c, 40)).sum().items() if v / dur.sum() > 0.005})
w = p.dropna(subset=['t_ins'])
mw, _, _ = maxconc(w.t_ins.values, w.t_i.values)
print('max waiting (inserted not issued)', mw)
print('distinct req_tag', mq.req_tag.nunique(), 'range', mq.req_tag.min(), mq.req_tag.max())

# page cache refault: add of (sdev,ino,idx) previously deleted in trace
fa = ev('mm_filemap_add_to_page_cache', ['s_dev', 'i_ino', 'index'])
fd = ev('mm_filemap_delete_from_page_cache', ['s_dev', 'i_ino', 'index'])
key = lambda d: d.s_dev.astype('int64') * (1 << 40) + d.i_ino.astype('int64') * (1 << 20) + d['index'].astype('int64')
fa['k'] = key(fa); fd['k'] = key(fd)
first_del = fd.groupby('k').ts.min()
fa['fd'] = fa.k.map(first_del)
ref = fa[fa.fd.notna() & (fa.ts > fa.fd)]
print(f'\npage cache adds {len(fa)}, deletes {len(fd)}, refaults(add after delete same page) {len(ref)} = {len(ref) / len(fa):.3f}, refault MB {len(ref) * 4 / 1024:.1f}')

# target app
th = Q("select utid, tid, t.name tname, upid, p.pid, p.name pname from thread t left join process p using(upid)")
tgt = th[th.pname == 'com.opera.mini.native']
main = tgt[tgt.tid == tgt.pid]
print('\nopera pids', tgt.pid.unique()[:5], 'main utid', main.utid.tolist())
ts_ = Q("select utid, ts, dur, state from thread_state where state='D'")
md = ts_[ts_.utid.isin(main.utid)]
print(f'opera main thread D: n={len(md)} total {md.dur.sum() / 1e6:.1f}ms max {md.dur.max() / 1e6:.2f}ms')
ad = ts_[ts_.utid.isin(tgt.utid)].merge(th[['utid', 'tname']], on='utid').groupby('tname').dur.agg(['count', 'sum']).sort_values('sum', ascending=False).head(10)
ad['sum'] = ad['sum'] / 1e6
print('opera threads D ms\n', ad)
sl = Q("""select s.ts, s.dur, s.name from slice s where s.name like 'launching%' or s.name like 'bindApplication%' or s.name like 'activityStart%'
          or s.name like 'activityResume%' or s.name like 'Choreographer#doFrame%' and 0 or s.name like 'MetricsLogger:launchObserverNotifyIntentStarted%' or s.name like 'reportFullyDrawn%' order by ts limit 20""")
print('startup slices\n', sl.to_string())

# UX request queue wait vs non-UX
mk2 = mk.rename(columns={'ts': 't_mk', 'rwbs': 'rwbs_mk'})
w2 = pd.merge_asof(w.sort_values('t_ins').astype({'t_ins': 'int64'}), mk2[['t_mk', 'sector', 'is_ux_task', 'FG_META', 'class']].sort_values('t_mk'),
                   left_on='t_ins', right_on='t_mk', by='sector', direction='backward', tolerance=5_000_000)
print('\nmatched make_request', w2.t_mk.notna().mean().round(3))
print('q_ms/svc_ms by is_ux_task\n', w2.groupby('is_ux_task')[['q_ms', 'svc_ms']].quantile(.99).round(3))
print('q_ms p99 by rwbs\n', w2.groupby('rwbs')[['q_ms', 'svc_ms']].quantile(.99).round(3))
