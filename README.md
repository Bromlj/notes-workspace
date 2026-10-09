# Notes Workspace

A Windows notepad with an optional Codex panel, independent chats for each note, project folders, attachments, model and thinking controls, and opt-in AI revisions with undo.

## Install the Windows app

Download the Windows x64 ZIP from [Releases](https://github.com/Bromlj/notes-workspace/releases/latest), extract the **whole ZIP**, then run `Install.cmd` inside the extracted `Notes Workspace` folder. It installs for your Windows account and creates a notepad desktop shortcut. No separate Node, Python, development environment or API key is needed to use the app.

Alternatively, if you have Git:

```powershell
git clone https://github.com/Bromlj/notes-workspace.git
cd notes-workspace
.\Get-App.cmd
```

The downloader gets the tested Windows release; Git only downloads the small source repository. The large application runtimes are distributed as release assets rather than Git objects.

Each person signs in with **their own ChatGPT account** through the Account page. AI usage comes from the account's available Codex allowance; this is not the normal ChatGPT website or a transfer of its chat history. The official Codex runtime is bundled.

## Use it

- Write, format, open and save ordinary notes normally.
- **Alt+W** reveals the AI panel; **Alt+Q** hides it immediately. Hiding does not cancel accepted work.
- **Alt+Shift+S** opens settings, including an optional restore passphrase.
- The **+** button creates a separate note and Codex chat. Select a project folder in the panel to let Codex work on that project's files using its normal sandbox and approval controls.
- Choose models and thinking levels from the catalog returned by your signed-in account. Attach supported documents or images with the attachment control.
- Enable **Edit this note** to allow Codex to revise the current note. This defaults off for each note. While hidden, the visible note and its recovery text stay frozen; showing AI catches up to the staged revision. If you typed meanwhile, review and explicitly apply or discard the pending revision. **Undo AI edit** restores the pre-task note and turns note editing off.
- **Apply pending** can apply one staged revision even when **Edit this note** is off. Confirm the replacement when asked. This one-time action leaves automatic note editing off; you can undo it afterward.

The cover provides visual privacy. Notes and local backups are not encrypted, and the app does not hide its processes or system activity. A restore passphrase prevents accidental reveals; it does not secure an unlocked computer.

## Build from source

Build on **Windows x64** with Git and Node.js 22.12 or newer. Runtime downloads require internet access. Python 3.11 or newer is needed only to create a release ZIP.

```powershell
npm ci --prefix native
npm ci --prefix desktop
node desktop/build.cjs
```

The program is generated at `desktop/dist/Notes Workspace/Notes Workspace.exe`. Run `Install.cmd` from that generated folder to install your build. `desktop/Install.cmd` in the source tree is a packaging input, not a ready-to-run installer.

To create a release ZIP with an embedded per-file manifest and SHA-256 verification:

```powershell
python tests/build-desktop-release.py
```

The ZIP and its checksum are written to `release/`. The build copies explicit application files, licensed third-party runtimes and notices. It does not package your installed app data, browser profile, account credentials, notes or test profiles.

## Tests

The published 5.1.1 build passed **127 helper/protocol/storage tests and 71 packaged-app checks**, including real Codex file edits and commands. See [the test report](desktop/TEST_REPORT.md) for the measured scope and limits.

After installing the source dependencies, run the helper tests without signing in:

```powershell
node --test tests/core.test.cjs tests/direct.test.cjs tests/agent.test.cjs tests/desktop-service.test.cjs tests/desktop-backup.test.cjs tests/desktop-storage.test.cjs tests/note-host.test.cjs tests/worker-note-edit.test.cjs
```

For packaged application tests, first build the app and install the test driver:

```powershell
npm install --prefix tests
node tests/desktop-e2e.cjs
node tests/desktop-import.cjs
node tests/desktop-note-edit-e2e.cjs
node tests/desktop-first-run.cjs
```

These scripts launch the built application with disposable profiles. `desktop-first-run.cjs` uses the real bundled Codex runtime with an empty sign-in profile. The other scripts use the included app-server fixture. Test screenshots, profiles and result files are generated locally and ignored by Git.

The following **live tests use your current Codex sign-in and account allowance**. They make real requests, but restrict edits to disposable projects created by the tests and do not automatically approve requests for additional access:

```powershell
node tests/desktop-live.cjs
node tests/desktop-note-edit-live.cjs
```

Optional overrides: `PLAYWRIGHT_MODULE` selects an existing Playwright installation, `NOTES_DESKTOP_EXE` selects a built executable, and `NOTES_TEST_NODE` selects Node for deterministic fixtures. Defaults work with the commands above.

## Compatibility and licenses

The window, taskbar and desktop shortcut use the notepad icon. The EXE retains the official Electron runtime's embedded icon and version metadata: its bytes are preserved because Windows blocked a resource-modified launcher on the verification machine.

This release has no custom code-signing certificate. Windows reputation warnings and managed policies can vary. Fresh human sign-in, first-time administrator sandbox setup and other computers were not fully tested; the test results are not a guarantee of perfection or compatibility with future service changes.

Notes Workspace source is [MIT licensed](LICENSE.txt). Bundled third-party components retain their own licenses; see [desktop/licenses](desktop/licenses) and the notices preserved with the release runtimes. Independent personal-use software; not affiliated with OpenAI or Microsoft.
