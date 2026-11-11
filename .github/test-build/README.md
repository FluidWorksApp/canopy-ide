# Canopy test build (persistent PTY host)

Built by `.github/workflows/test-build.yml` from branch `@BRANCH@`, commit
`@SHA@`. Release profile (single instance, `~/.canopy/pty-host`, like a
shipped app). It is **unsigned and not notarized**, has no updater signature,
and is not a release.

Files: `Canopy.app.zip` (the app, zipped with `ditto`), the `.dmg` if one was
built, and this README.

## Before you start

- **Quit the installed Canopy first (⌘Q).** This build has the same bundle id
  and is single-instance, so while the installed app runs, launching this one
  only hands over to it and exits. Quitting the installed app ends its
  terminals as usual.
- Keep this app out of `/Applications`. Run it from its own folder, for example
  `~/Downloads/canopy-test`, so it does not replace or shadow the real app.
- It uses your real `~/.canopy` (projects, settings, agent state).
- This build is ad hoc signed with a different code identity from the shipped
  app, so macOS may ask again for folder, microphone or keychain access.
- If the updater offers a new version, decline. Installing it would replace this
  build with a release.

## Unpack and open (unsigned app)

```sh
mkdir -p ~/Downloads/canopy-test && cd ~/Downloads/canopy-test
gh run download @RUN_ID@ -R @REPO@ -n @ARTIFACT@
ditto -x -k Canopy.app.zip .
xattr -dr com.apple.quarantine Canopy.app   # harmless if nothing is set
```

`gh run download` and `ditto` do not add a quarantine flag, so the app usually
opens straight away. If you downloaded it in a browser, macOS blocks an unsigned
app. Run the `xattr` line above, or open it once, then go to System Settings →
Privacy & Security and click **Open Anyway**. Right-click → Open no longer
bypasses this on macOS 15 and later. If macOS says the app "is damaged", use
`xattr`.

## Launch with the flag

The main binary is `Canopy.app/Contents/MacOS/@BINARY@`. Quit any running copy
first, since a running app does not pick up a new environment. Then use one of
these:

```sh
# 1. From Terminal, through LaunchServices (checked on macOS 27):
open -n --env CANOPY_PTY_HOST=1 ./Canopy.app
#    `CANOPY_PTY_HOST=1 open -n ./Canopy.app` also passes the variable on
#    macOS 27 (open(1): apps inherit the caller's environment).

# 2. Run the binary directly. It stays tied to this Terminal window, and
#    closing the window ends the app (hosted terminals survive that).
CANOPY_PTY_HOST=1 ./Canopy.app/Contents/MacOS/@BINARY@

# 3. For Dock or Finder launches, set it for your login session:
launchctl setenv CANOPY_PTY_HOST 1
#    ...and unset it after testing. Every app started afterwards sees it.
launchctl unsetenv CANOPY_PTY_HOST
```

Without the flag, launch with `open -n ./Canopy.app`, after
`launchctl unsetenv CANOPY_PTY_HOST` if you used option 3.

## Manual tests

a. **Survive quit.** With the flag, open two terminals. Run `top` in one and a
   Claude agent in the other. Quit with ⌘Q, then relaunch with the flag. Both
   terminals come back with their history and keep running. Resize the window
   and check that both redraw cleanly.

b. **Context bridge.** In the adopted Claude agent, call a canopy tool (for
   example, ask it to list Canopy agents or open a file in Canopy). It should
   work against the new app, through `~/.canopy/pty-host/ctx.sock`.

c. **Quit and Stop All.** With an agent running, press ⌥⌘Q (or pick the app
   menu item under Quit). A dialog asks "Stop 1 running agent?". Choose
   **Stop all**. Relaunch with the flag: the terminal shows Resume, not
   Reconnecting. After about 60 s, `pgrep canopy-pty-host` prints nothing.

d. **Flag off.** Launch without the flag (see above), open a terminal and quit.
   The terminals are killed as before, and nothing is adopted on the next
   launch.

e. **No quarantine on the installed host.** After a launch with the flag:

   ```sh
   xattr -l ~/.canopy/pty-host/bin/*/canopy-pty-host
   ```

   This should show no `com.apple.quarantine`. The check only proves something
   if the app was still quarantined at its first launch: download the zip in a
   browser, unzip it in Finder, open it with Open Anyway, and do not run `xattr
   -dr`. A `gh run download` copy has no quarantine to begin with.

Useful while testing: `pgrep -fl canopy-pty-host`, `ls ~/.canopy/pty-host`.

## When you are done

A host left by a plain ⌘Q can linger for up to two hours. Use Quit and Stop All,
or `pkill canopy-pty-host`. Then run `launchctl unsetenv CANOPY_PTY_HOST` if you
set it, and delete the test app.
