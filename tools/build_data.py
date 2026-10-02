"""
Build the two data files the dashboard reads:
  data/data.enc.json  - the real data, AES-256-GCM encrypted with your password
  data/demo.json      - an anonymised copy with randomised numbers (for the demo user)

Usage:
  python3 tools/build_data.py <real-data.json> <password>

The plain real-data JSON must NEVER be committed to git.
The dashboard itself can also re-encrypt and save (Settings -> Save to GitHub),
so this script is only needed for the first build or a fresh Excel import.
"""
import json, os, sys, re, base64, random, copy
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITER = 250_000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def encrypt(obj, password):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(password.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode('utf-8'), None)
    b = lambda x: base64.b64encode(x).decode()
    return {'v': 1, 'kdf': 'PBKDF2-SHA256', 'iter': ITER, 'salt': b(salt), 'iv': b(iv), 'ct': b(ct)}


# ---------------- demo data ----------------
HEB = '֐-׿'
NAME_MAP = [  # whole-word replacements (people, places, providers that identify the family)
    ('רונן', 'דני'), ('טל', 'מיכל'), ('יובל', 'נועה'), ('אופיר', 'איתי'), ('אפיר', 'איתי'), ('מתן', 'עומר'),
    ('עין הקורא', 'הזית'), ('עיןהקורא', 'הזית'), ('בן גוריון', 'הרימון'), ('בןגוריון', 'הרימון'),
    ('ישראל בן ציון', 'התאנה'), ('ישראלבןציון', 'התאנה'), ('וייצבארד', 'הגפן'), ('וייצברד', 'הגפן'),
    ('גן רווה', 'גן העיר'), ('בת-ים', 'חולון'), ('בת ים', 'חולון'), ('פורטו', 'ליסבון'), ('גאיה', 'סינטרה'),
    ('מור', 'אור'), ('סאלם', 'גז-בית'), ('טוהר', 'מס-עירוני'), ('גולן', 'סלולר'),
    ('METAOR', 'ALPHA'), ('AUSTIN', 'BETA'), ('VEEV', 'ACME'), ('PORTO', 'LISBON'),
    ('Ronen', 'Dani'), ('Tal', 'Michal'), ('RONEN', 'DANI'), ('TAL', 'MICHAL'),
]


def anon_text(s):
    for a, b in NAME_MAP:
        s = re.sub(rf'(?<![{HEB}A-Za-z])([ולבמש]?){re.escape(a)}(?![{HEB}A-Za-z])', lambda m: m.group(1) + b, s)
    s = re.sub(r'\(\d{6,}\)', '(000000000)', s)  # policy numbers
    s = re.sub(r':\s*\d+', '', s) if False else s
    return s


def walk(o, fn_num, fn_str, key=None):
    if isinstance(o, dict):
        return {k: walk(v, fn_num, fn_str, k) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(v, fn_num, fn_str, key) for v in o]
    if isinstance(o, bool):
        return o
    if isinstance(o, (int, float)):
        return fn_num(o, key)
    if isinstance(o, str):
        return fn_str(o)
    return o


def make_demo(real):
    rnd = random.Random(42)
    d = copy.deepcopy(real)
    keep_num_keys = {'v', 'version', 'year', 'baseYear', 'endYear', 'growth', 'usd', 'eur', 'need', 'want', 'invest',
                     'orphan_split', 'iter'}

    def item_factor():
        return rnd.uniform(0.55, 1.4)

    # scale every money series with a per-row factor so the shape stays realistic
    def scale_series(lst, f):
        return [round(x * f * rnd.uniform(0.93, 1.07)) if isinstance(x, (int, float)) and x else x for x in lst]

    for y, groups in d['expenses'].items():
        for g in groups:
            for it in g['items']:
                it['months'] = scale_series(it['months'], item_factor())
    for y, rows in d['incomes'].items():
        for it in rows:
            it['months'] = scale_series(it['months'], item_factor())
    d.pop('expenseTotalsOverride', None)
    gf = rnd.uniform(0.45, 0.7)
    for a in d['assets']:
        f = gf * rnd.uniform(0.7, 1.3)
        for k in ('value', 'foreign', 'buyPrice', 'pension'):
            if a.get(k):
                a[k] = round(a[k] * f, -2)
    for l in d['liabilities']:
        f = gf * rnd.uniform(0.7, 1.3)
        for k in ('value', 'foreign'):
            if l.get(k):
                l[k] = round(l[k] * f, -2)
    for h in d['netWorthHistory']:
        h['assets'] = round(h['assets'] * gf); h['liabilities'] = round(h['liabilities'] * gf); h['net'] = h['assets'] - h['liabilities']
    for g in d['graphHistory']:
        for k in g:
            if k != 'month':
                g[k] = round(g[k] * gf)
    for y in d.get('budget', {}).values():
        y['investments'] = [round(x * gf) for x in y['investments']]
    for it in d['inheritance']['items']:
        it['base'] = round(it['base'] * gf, -3)
    for h in d['inheritance']['history']:
        h['values'] = [round(v * gf, -3) for v in h['values']]
    for t in d['portugal']['transfers']:
        t['amount'] = round(t['amount'] * gf, -2)
    for row in d['risk']['coverage']:
        for p in row['people'].values():
            for k in ('value', 'premium'):
                if isinstance(p.get(k), (int, float)) and p[k] > 1:
                    p[k] = round(p[k] * gf)
    for k in ('ifRonenDies', 'ifTalDies'):
        d['risk']['survivors'][k] = {kk: round(v * gf) for kk, v in d['risk']['survivors'][k].items()}
    fake_people = ['יואב לוי', 'שירה כהן', 'מאיה פרץ', 'אלון מזרחי', 'רועי אברהם', 'נטע ביטון', 'גיל אזולאי']
    for i, c in enumerate(d['contacts']):
        c['name'] = fake_people[i % len(fake_people)]
        c['phone'] = f'050-000-00{i:02d}'
        c['notes'] = ''
    d['meta']['demo'] = True
    d = walk(d, lambda n, k: n, anon_text)
    d['risk']['coverage'] = [{**r, 'people': {anon_text(p): v for p, v in r['people'].items()}} for r in d['risk']['coverage']]
    d['settings']['people'] = {'p1': 'דני', 'p2': 'מיכל'}
    return d


if __name__ == '__main__':
    src, pw = sys.argv[1], sys.argv[2]
    real = json.load(open(src, encoding='utf-8'))
    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    json.dump(encrypt(real, pw), open(os.path.join(ROOT, 'data', 'data.enc.json'), 'w'), indent=0)
    json.dump(make_demo(real), open(os.path.join(ROOT, 'data', 'demo.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print('written data/data.enc.json and data/demo.json')
