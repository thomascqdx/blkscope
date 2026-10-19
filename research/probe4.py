import glob
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
path = glob.glob('work/*.trace')[0]
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300, ingest_ftrace_in_raw=True))

def q(sql, n=50):
    print('==', sql)
    try:
        print(tp.query(sql).as_pandas_dataframe().head(n).to_string(max_colwidth=160))
    except Exception as e:
        print('ERR', e)

q("select name, str_value, int_value from metadata")
q("""select a.int_value caller, count(*) c, sum(b.int_value) io_wait from ftrace_event f
     join args a on a.arg_set_id=f.arg_set_id and a.key='caller'
     join args b on b.arg_set_id=f.arg_set_id and b.key='io_wait'
     where f.name='sched_blocked_reason' group by 1 order by c desc""")
q("select a.value_type, a.display_value from args a where a.key='caller' limit 3")
q("""select s.name, count(*) c from slice s where s.name like '%cache%' or s.name like '%tran%' or s.name like '%atomic%'
     or s.name like '%fs%' or s.name like '%dex%' or s.name like '%apk%' or s.name like '%.so%' group by 1 order by c desc""", 60)
q("""select f.name, count(*) from ftrace_event f where f.name='print' and exists(select 1 from args a where a.arg_set_id=f.arg_set_id and a.key='buf' and (a.string_value like '%cache%' or a.string_value like '%tran_fs%')) group by 1""")
q("""select a.string_value, count(*) c from ftrace_event f join args a on a.arg_set_id=f.arg_set_id and a.key='buf'
     where f.name='print' group by substr(a.string_value,1,40) order by c desc""", 60)
q("""select b.display_value rwbs, count(*) c from ftrace_event f join args b on b.arg_set_id=f.arg_set_id and b.key='rwbs' where f.name='block_rq_issue' group by 1 order by c desc""")
q("""select b.display_value dev, count(*) c from ftrace_event f join args b on b.arg_set_id=f.arg_set_id and b.key='dev' where f.name='block_rq_issue' group by 1 order by c desc""")
for k in ['class','data','priority','type','is_ux_task','is_ux_loop','FG_META','bi_ioprio','req_nr','transsion_cmd_flags']:
    q(f"""select b.display_value {k}, count(*) c from ftrace_event f join args b on b.arg_set_id=f.arg_set_id and b.key='{k}' where f.name='block_rq_mq_make_request' group by 1 order by c desc""", 15)
q("""select a.display_value rq_log from ftrace_event f join args a on a.arg_set_id=f.arg_set_id and a.key='rq_log' where f.name='block_rq_mq_complete_request' limit 3""")
q("""select b.display_value filebuf, count(*) c, sum(c2.int_value) bytes from ftrace_event f join args b on b.arg_set_id=f.arg_set_id and b.key='filebuf'
     join args c2 on c2.arg_set_id=f.arg_set_id and c2.key='bytes' where f.name='tran_fs_pagecache_start' group by 1 order by bytes desc""", 30)
