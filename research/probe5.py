import glob
from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
path = glob.glob('work/*.trace')[0]
tp = TraceProcessor(trace=path, config=TraceProcessorConfig(load_timeout=300, ingest_ftrace_in_raw=True))

def q(sql, n=60):
    print('==', sql)
    try:
        print(tp.query(sql).as_pandas_dataframe().head(n).to_string(max_colwidth=140))
    except Exception as e:
        print('ERR', e)

q("select name, idx, severity, source, value from stats where value>0 and name not like 'ftrace_cpu%'")
q("""select substr(a.string_value,1,60) buf, count(*) c from ftrace_event f join args a on a.arg_set_id=f.arg_set_id and a.key='buf'
     where f.name='print' and (a.string_value like '%cache%' or a.string_value like '%fs%' or a.string_value like '%io%' or a.string_value like '%read%')
     group by substr(a.string_value,1,25) order by c desc""")
q("""select p.name pname, count(*) c, sum(b.int_value)/1048576.0 mb from ftrace_event f join args b on b.arg_set_id=f.arg_set_id and b.key='bytes'
     join thread t using(utid) left join process p using(upid) where f.name='block_rq_insert' group by 1 order by mb desc""", 25)
q("""select count(distinct a.int_value) from ftrace_event f join args a on a.arg_set_id=f.arg_set_id and a.key='req_tag' where f.name='block_rq_mq_complete_request'""")
q("""select max(a.int_value) from ftrace_event f join args a on a.arg_set_id=f.arg_set_id and a.key='req_tag' where f.name='block_rq_mq_complete_request'""")
