### Signed in means connected
Signed in to your Canopy account, you're already connected to your teams: channels, direct messages and who's around show up on their own, end-to-end encrypted, with no code or link to exchange. Join codes and the self-hosted relay are now only offered when you aren't signed in, or while a relay session is already running. Opening Shared sessions on a workspace now connects by itself, so you no longer click "View shared sessions" first.

### Links you can read, paste and remember
Every workspace, shared agent session and team message now has a link hosted on canopyide.dev that reads like what it points to:

- a workspace: `canopyide.dev/platform/api-server`
- a shared session: `canopyide.dev/platform/api-server/s/fix-login-bug-27`
- a message, plan or handoff in team chat: `canopyide.dev/platform/t/general/quiet-otter-41`

Copy a link with one click: from a workspace's Overview, from Copy workspace link in the workspace switcher, from any row in Shared sessions, or by right-clicking a chat message. There's nothing to generate, and the same thing always gets the same link.

To open one, click it in chat, paste it into SpotSearch (⌘K), or run `canopy <link>` from a terminal. Canopy opens the workspace, shows the shared session, or jumps to the message in its conversation.

A link is only a name. Canopy checks your access every time someone opens one, so a link that reaches the wrong person shows them nothing. Someone removed from a team or workspace loses access straight away. Message links never carry the message itself: it stays encrypted on your teammates' devices.
