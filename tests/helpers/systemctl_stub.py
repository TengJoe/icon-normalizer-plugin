#!/usr/bin/env python3
"""Fixture-only systemctl. Never forwards a command to a real manager."""
import fcntl
import json
import os
from pathlib import Path
import sys

path = Path(os.environ['ICON_NORMALIZER_TEST_MANAGER'])
path.parent.mkdir(parents=True, exist_ok=True)
args = [a for a in sys.argv[1:] if a != '--user']
with open(str(path)+'.lock', 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    data = json.loads(path.read_text()) if path.exists() else {'units':{}, 'calls':[]}
    data['calls'].append(args)
    action = args[0] if args else ''
    names = [a for a in args[1:] if a.startswith('icon-normalizer.')]
    fail = os.environ.get('ICON_NORMALIZER_TEST_FAIL_ACTION') == action
    if not fail:
        for name in names:
            state = data['units'].setdefault(name, {'enabled':False, 'active':False})
            if action in ('enable','disable'):
                state['enabled'] = action == 'enable'
                if '--now' in args:
                    state['active'] = action == 'enable'
            elif action in ('start','stop'):
                state['active'] = action == 'start'
            elif action == 'show':
                print('LoadState=loaded')
                print('UnitFileState='+('enabled' if state['enabled'] else 'disabled'))
                print('ActiveState='+('active' if state['active'] else 'inactive'))
                print('SubState='+('running' if state['active'] else 'dead'))
    path.write_text(json.dumps(data))
if fail:
    print('fixture injected failure', file=sys.stderr)
    sys.exit(1)
if action not in ('show','enable','disable','start','stop','daemon-reload'):
    print('unsupported fixture action', file=sys.stderr)
    sys.exit(2)
