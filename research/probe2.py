import glob, inspect
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
print(inspect.signature(TraceProcessorConfig.__init__))
path = glob.glob('work/*.trace')[0]
kw = {}
if 'ingest_ftrace_in_raw' in str(inspect.signature(TraceProcessorConfig.__init__)):
    kw['ingest_ftrace_in_raw'] = True
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300, **kw))

def q(sql, n=80):
    print('==', sql)
    try:
        print(tp.query(sql).as_pandas_dataframe().head(n).to_string())
    except Exception as e:
        print('ERR', e)

q("select name, str_value from metadata where name='trace_config_pbtxt'")
q("select name, count(*) c from ftrace_event group by name order by c desc", 200)
q("select count(*), count(blocked_function), sum(state='D'), sum(state='DK') from thread_state")
q("select blocked_function, count(*) c, sum(dur)/1e6 ms from thread_state where blocked_function is not null group by 1 order by ms desc", 40)
q("select state, count(*), sum(dur)/1e6 ms from thread_state group by state order by 3 desc")
q("select name, idx, severity, value from stats where value>0 and (severity!='info' or name like '%ftrace%')", 80)
q("select (select min(ts) from sched)/1e9 s0, (select max(ts) from sched)/1e9 s1, (select count(*) from sched) n")
