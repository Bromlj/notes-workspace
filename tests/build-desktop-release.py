"""Package only the clean desktop build, never profiles or the working tree."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
program = root / 'desktop' / 'dist' / 'Notes Workspace'
release = root / 'release'
release.mkdir(exist_ok=True)
archive = release / 'Notes-Workspace-Desktop-5.2.0-Windows-x64.zip'
for required in ['Notes Workspace.exe', 'Install.cmd', 'START HERE.txt', 'TEST_REPORT.md', 'resources/app/main.cjs', 'resources/codex/bin/codex.exe']:
    if not (program / required).is_file():
        raise RuntimeError('Missing release file: ' + required)
forbidden = {'auth.json', 'connection.json', 'notes.json', 'document-bindings.json', 'cookies', 'local state', '.codex', 'desktopdata', 'codex-home', 'notework', 'startup-error.log'}
manifest = {'version': '5.2.0', 'platform': 'Windows x64', 'files': []}
for file in sorted(program.rglob('*')):
    if not file.is_file() or file.name == 'RELEASE-MANIFEST.json':
        continue
    relative = file.relative_to(program)
    if any(part.lower() in forbidden for part in relative.parts):
        raise RuntimeError('Private file in release: ' + str(relative))
    digest = hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
    manifest['files'].append({'path': relative.as_posix(), 'bytes': file.stat().st_size, 'sha256': digest})
(program / 'RELEASE-MANIFEST.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
    for file in sorted(program.rglob('*')):
        if file.is_file():
            output.write(file, Path('Notes Workspace') / file.relative_to(program))
with zipfile.ZipFile(archive) as check:
    for entry in manifest['files']:
        with check.open('Notes Workspace/' + entry['path']) as content:
            if hashlib.file_digest(content, 'sha256').hexdigest() != entry['sha256']:
                raise RuntimeError('ZIP content hash failed: ' + entry['path'])
    if json.loads(check.read('Notes Workspace/RELEASE-MANIFEST.json')) != manifest:
        raise RuntimeError('ZIP release manifest failed')
digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
archive.with_suffix('.zip.sha256.txt').write_text(digest + '  ' + archive.name + '\n', encoding='ascii')
print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest, 'programFiles': len(manifest['files']), 'zipIntegrity': 'passed', 'privateDataScan': 'passed'}))
