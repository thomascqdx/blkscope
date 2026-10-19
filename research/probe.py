import sys, glob
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig

path = glob.glob('work/*.trace')[0]
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300))

def q(sql, n=60):
    print('==', sql)
    try:
        df = tp.query(sql).as_pandas_dataframe()
        print(df.head(n).to_string())
    except Exception as e:
        print('ERR', e)

q("select name, count(*) c from ftrace_event group by name order by c desc", 200)
q("select (max(ts)-min(ts))/1e6 dur_ms from ftrace_event")
for n in ['block_rq_issue','block_rq_complete','block_rq_insert','block_bio_queue','block_rq_requeue','android_fs_dataread_start','f2fs_submit_page_write','ufshcd_command','block_io_start','block_io_done']:
    q(f"select ts, utid, arg_set_id from ftrace_event where name='{n}' limit 3")
    q(f"select a.key, a.display_value from ftrace_event f join args a using(arg_set_id) where f.name='{n}' and f.id=(select min(id) from ftrace_event where name='{n}')")
q("select name, count(*) c from slice group by name order by c desc limit 40")
q("select name, count(*) from track group by name order by 2 desc limit 40")
q("select name, type, count(*) from counter_track group by name order by 3 desc limit 40")
q("select key, str_value from metadata")
