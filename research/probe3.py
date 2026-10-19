import glob
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
path = glob.glob('work/*.trace')[0]
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300, ingest_ftrace_in_raw=True))

def q(sql, n=40):
    print('==', sql)
    try:
        print(tp.query(sql).as_pandas_dataframe().head(n).to_string(max_colwidth=120))
    except Exception as e:
        print('ERR', e)

cfg = tp.query("select str_value from metadata where name='trace_config_pbtxt'").as_pandas_dataframe().iloc[0, 0]
open('work/trace_config.txt', 'w', encoding='utf8').write(cfg)

for n in ['sched_blocked_reason', 'block_rq_insert', 'block_rq_issue', 'block_rq_complete',
          'block_rq_mq_make_request', 'block_rq_mq_complete_request', 'block_rq_mq_requeue_request',
          'tran_fs_pagecache_start', 'mm_filemap_add_to_page_cache', 'mm_filemap_delete_from_page_cache']:
    print('\n########', n)
    q(f"""select f.id, f.ts, f.cpu, t.tid, t.name tname, f.arg_set_id from ftrace_event f left join thread t using(utid)
          where f.name='{n}' order by f.ts limit 5""")
    q(f"""select a.arg_set_id, a.key, a.display_value from args a where a.arg_set_id in
          (select arg_set_id from ftrace_event where name='{n}' order by ts limit 3) order by a.arg_set_id, a.id""", 60)

q("select name, count(*) c from slice where name like '%fault%' or name like '%read%' or name like '%open%' or name like '%fsync%' or name like '%io%' group by name order by c desc", 40)
q("select distinct t.type from track t", 80)
q("select s.name, count(*) from slice s join track t on s.track_id=t.id where t.type like '%cpu%' group by 1 order by 2 desc limit 20")
