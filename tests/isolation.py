"""One subprocess isolation boundary shared by CLI and installation tests."""
from pathlib import Path
import os
import shutil


def isolated_env(root: Path) -> dict[str, str]:
    root = root.absolute()
    bin_dir = root / 'test-bin'
    runtime = root / 'runtime'
    bin_dir.mkdir(parents=True, exist_ok=True)
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    stub = bin_dir / 'systemctl'
    if not stub.exists():
        shutil.copy2(Path(__file__).parent/'helpers'/'systemctl_stub.py', stub)
        stub.chmod(0o700)
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('ICON_NORMALIZER_'):
            env.pop(key)
    env.update({
        'PATH':str(bin_dir)+os.pathsep+env.get('PATH',''),
        'ICON_NORMALIZER_TEST_MANAGER':str(root/'test-manager.json'),
        'DBUS_SESSION_BUS_ADDRESS':'unix:path='+str(runtime/'absent-bus'),
        'XDG_RUNTIME_DIR':str(runtime), 'GSETTINGS_BACKEND':'memory',
        'PYTHONDONTWRITEBYTECODE':'1',
    })
    env.pop('XDG_DATA_HOME', None)
    env.pop('XDG_CACHE_HOME', None)
    env.pop('XDG_DATA_DIRS', None)
    return env
