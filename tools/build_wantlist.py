#!/usr/bin/env python3
"""Build the Want List page from the JSON rows written by tools/wantlist-build.js.

Usage: python3 tools/build_wantlist.py <rows.json> <out.html> [date label]
rows.json is the claude_tmp.wantlist0..N metafield values joined in order.
"""
import json, sys, datetime, os

rows = json.load(open(sys.argv[1]))
label = sys.argv[3] if len(sys.argv) > 3 else datetime.date.today().strftime('%b %-d, %Y')
tpl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wantlist.html')).read()
html = tpl.replace('__DATA__', json.dumps(rows, separators=(',', ':')).replace('</', '<\\/')).replace('__DATE__', label)
open(sys.argv[2], 'w').write(html)
print(len(rows), 'series written to', sys.argv[2])
