import glob
import pandas as pd
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
path = glob.glob('work/*.trace')[0]
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300, ingest_ftrace_in_raw=True))
Q = lambda s: tp.query(s).as_pandas_dataframe()

pc = Q("""select ts, utid, extract_arg(arg_set_id,'ino') ino, extract_arg(arg_set_id,'offset') off,
          extract_arg(arg_set_id,'bytes') bytes, extract_arg(arg_set_id,'filebuf') name,
          extract_arg(arg_set_id,'major_dev') maj, extract_arg(arg_set_id,'minor_dev') mnr
          from ftrace_event where name='tran_fs_pagecache_start' order by ts""")
ins = Q("""select ts, utid, extract_arg(arg_set_id,'bytes') bytes, extract_arg(arg_set_id,'rwbs') rwbs,
           extract_arg(arg_set_id,'sector') sector from ftrace_event where name='block_rq_insert' order by ts""")
mk = Q("""select ts, utid, extract_arg(arg_set_id,'pid') pid, extract_arg(arg_set_id,'rwbs') rwbs,
          extract_arg(arg_set_id,'sector') sector from ftrace_event where name='block_rq_mq_make_request' order by ts""")
fa = Q("""select ts, utid, extract_arg(arg_set_id,'i_ino') ino, extract_arg(arg_set_id,'index') idx,
          extract_arg(arg_set_id,'s_dev') sdev from ftrace_event where name='mm_filemap_add_to_page_cache' order by ts""")

for d in (pc, ins, mk, fa):
    for c in d.columns:
        if c not in ('name', 'rwbs'):
            d[c] = pd.to_numeric(d[c]).astype('int64')
print('pagecache_start bytes dist:\n', pc.bytes.value_counts().head(10))
print('pagecache dev:\n', pc.groupby(['maj', 'mnr']).size())
print('filemap sdev:\n', fa.sdev.value_counts().head(10))
print('pc per-file top:\n', pc.groupby('name').bytes.agg(['count', 'sum']).sort_values('sum', ascending=False).head(15))

# (1) for each pagecache_start: offset/4096 vs following filemap_add index of same thread & ino
pc['page'] = pc.off // 4096
m = pd.merge_asof(pc.sort_values('ts'), fa.rename(columns={'ts': 'fa_ts', 'ino': 'fa_ino'}).sort_values('fa_ts'),
                  left_on='ts', right_on='fa_ts', by='utid', direction='forward', tolerance=2_000_000)
ok = m.fa_ts.notna()
print(f'\n[pc->next filemap_add same thread <=2ms] {ok.mean():.3f}; same ino {(m.fa_ino == m.ino)[ok].mean():.3f}; '
      f'idx==page {(m.idx == m.page)[ok].mean():.3f}; dt p50/p90 us {((m.fa_ts - m.ts)[ok] / 1e3).quantile([.5, .9]).tolist()}')

# (2) for each READ insert: preceding pagecache_start on same thread
r = ins[ins.rwbs.str.contains('R')].copy()
print(f'\nread inserts {len(r)}, write inserts {(ins.rwbs.str.contains("W")).sum()}')
for tol in [1_000_000, 5_000_000, 20_000_000, 100_000_000]:
    mm = pd.merge_asof(r.sort_values('ts'), pc.rename(columns={'ts': 'pc_ts', 'bytes': 'pc_bytes'}).sort_values('pc_ts'),
                       left_on='ts', right_on='pc_ts', by='utid', direction='backward', tolerance=tol)
    print(f'  read insert with preceding pagecache_start same thread within {tol / 1e6:.0f}ms: {mm.pc_ts.notna().mean():.3f}')
mm = pd.merge_asof(r.sort_values('ts'), pc.rename(columns={'ts': 'pc_ts', 'bytes': 'pc_bytes'}).sort_values('pc_ts'),
                   left_on='ts', right_on='pc_ts', by='utid', direction='backward', tolerance=20_000_000)
mm['dt_us'] = (mm.ts - mm.pc_ts) / 1e3
print('  dt p50/p90/p99 us', mm.dt_us.quantile([.5, .9, .99]).tolist())
print('  by rwbs coverage:\n', mm.groupby('rwbs').pc_ts.apply(lambda s: f'{s.notna().mean():.2f} n={len(s)}'))
# read inserts with preceding filemap_add on same thread (any file)
mf = pd.merge_asof(r.sort_values('ts'), fa.rename(columns={'ts': 'fa_ts'}).sort_values('fa_ts'),
                   left_on='ts', right_on='fa_ts', by='utid', direction='backward', tolerance=5_000_000)
print(f'  read insert with preceding filemap_add same thread within 5ms: {mf.fa_ts.notna().mean():.3f}')

# (3) how many pagecache_start does NOT lead to an insert from the same thread before next pagecache_start (cache hit?)
pc2 = pc.copy(); pc2['next_pc'] = pc2.groupby('utid').ts.shift(-1)
mi = pd.merge_asof(pc2.sort_values('ts'), r[['ts', 'utid', 'bytes']].rename(columns={'ts': 'in_ts', 'bytes': 'in_bytes'}).sort_values('in_ts'),
                   left_on='ts', right_on='in_ts', by='utid', direction='forward')
lead = mi.in_ts.notna() & ((mi.in_ts < mi.next_pc) | mi.next_pc.isna())
print(f'\n[pc followed by own read insert before next pc] {lead.mean():.3f}')

# (4) make_request vs insert: same thread? pid == tid?
th = Q("select utid, tid from thread")
mk2 = mk.merge(th, on='utid')
print(f'\nmake_request pid==tid {(mk2.pid == mk2.tid).mean():.3f}')

# sample timeline for one thread
u = r.utid.value_counts().index[0]
ev = pd.concat([pc[pc.utid == u].assign(ev='PC')[['ts', 'ev', 'name', 'off', 'bytes']],
                fa[fa.utid == u].assign(ev='FA')[['ts', 'ev', 'ino', 'idx']],
                ins[ins.utid == u].assign(ev='INS')[['ts', 'ev', 'bytes', 'rwbs', 'sector']]]).sort_values('ts')
ev['ts'] = (ev.ts - ev.ts.iloc[0]) / 1e3
print('\nsample timeline utid', u)
print(ev.iloc[200:320].to_string())
