"""Investigate requests whose requeue wait (t_iss - t_iss0) is abnormally long."""
import glob
import pandas as pd
from iotrace.tp import open_trace
from iotrace.extract import extract_all
from iotrace.model import build_model

path = glob.glob('work/*.trace')[0]
tp = open_trace(path)
ex = extract_all(tp)
tp.close()
m = build_model(ex)
r = m.req
r['rqw_ms'] = (r.t_iss - r.t_iss0) / 1e6
r['q_ms'] = (r.t_iss0 - r.t_ins) / 1e6
pd.set_option('display.width', 250)
print('rq_n>0:', (r.rq_n > 0).sum(), ' issue_count>1:', (r.issue_count > 1).sum())
print('requeue wait ms quantiles (issue_count>1):')
print(r.loc[r.issue_count > 1, 'rqw_ms'].quantile([.5, .9, .99, .999, 1]).round(3).to_dict())
big = r[r.rqw_ms > 50].sort_values('rqw_ms', ascending=False)
print('\nrequests with requeue wait > 50ms:', len(big))
print(big[['dev', 'sector', 'rwbs', 'bytes', 'issue_count', 'rq_n', 'rqw_ms', 'q_ms', 't_ins', 't_iss0', 't_iss', 't_cmp']].head(20).to_string())
print('\nrwbs of >50ms:', big.rwbs.value_counts().to_dict())
print('\nqueue wait (t_iss0 - t_ins) quantiles ms:', r.q_ms.quantile([.5, .99, .999, 1]).round(3).to_dict())
if len(big):
    s = big.iloc[0]
    key = (ex.rq_issue.dev == s.dev) & (ex.rq_issue.sector == s.sector)
    print('\nissue events for top key:', key.sum())
    print(ex.rq_issue[key][['ts', 'utid', 'nr_sector', 'rwbs']].head(15).to_string())
    kc = (ex.rq_complete.dev == s.dev) & (ex.rq_complete.sector == s.sector)
    print('complete events for top key:', kc.sum())
    print(ex.rq_complete[kc][['ts', 'nr_sector', 'rwbs', 'error']].head(15).to_string())
    ki = (ex.rq_insert.dev == s.dev) & (ex.rq_insert.sector == s.sector)
    print('insert events for top key:', ki.sum())
    print(ex.rq_insert[ki][['ts', 'nr_sector', 'rwbs']].head(15).to_string())
