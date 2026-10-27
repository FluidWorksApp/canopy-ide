## Connect your brain

Canopy's smart features now all run on one agent CLI you are already signed in to — your **brain**. Connecting it is the first thing Canopy asks, and you can see at a glance whether it is working.

**What you see**

- **First run starts with "Connect your brain."** Canopy lists the agent CLIs on this computer that can power it, recommends one, and checks it straight away with a one-word question. If it answers, you're done. If none is installed, it offers to install one. If it's signed out, **Sign in** opens a terminal running that CLI's own sign-in, and Canopy checks again when you close the terminal or come back to the window. If no project is open yet, it tells you the exact command to run. You can also pick a main model and a cheaper background model. **Skip** still works: files, terminals and git never need a brain.
- **A brain chip in the status bar**, next to the plan-usage chip, shows your brain and a coloured dot with its state in words (connected, checking, signed out, rate-limited, not connected). Click it to see what Canopy's own features spent on your plan today, broken down by feature. You can set a daily budget and a budget for each feature there, see the last error, and press **Check again**. When the brain isn't connected, the chip reads **Connect your brain** and opens the connect step.
- **Settings → Agents → Brain** has the same connect panel, today's spending with budgets, a list of **features not using your brain** (for now, a Companion set to another CLI or model, with **Use my brain** to reset it), and a switch for automatic brain work.
- **Suggest message in the commit box.** Stage files and press **Suggest message**: the brain reads the staged diff and your recent commit subjects and writes the commit message. You can still edit it before committing.
- **Better tab names.** If an agent doesn't name its own task within about 20 seconds, the brain gives its tab a short title based on your opening message, instead of showing the first 48 characters of it. A name you typed, or one the agent chose, always wins.
- **One-line session summaries.** In Agents, a session whose agent hasn't published what it's doing now shows the brain's one-line summary of what the session is for, instead of your latest message ("yes do it").
- **No more silent nothing.** Until a brain is connected, these features show a single **Connect your brain** button where they would have been (the commit box, the Companion's empty state, the chip).

**When the brain is used**

- Once when Canopy starts, plus whenever you press Check again, to check the connection. This uses the cheap background model.
- When you press **Suggest message**. This uses your main model.
- Once for each new agent session whose agent didn't name itself. This uses the background model. The result is cached by the opening message, so the same session is never asked about twice.

Every call is counted under its feature in the chip, and it stops for the day once that feature's budget, or the daily budget, is used up. The brain runs read-only and leaves no session in your CLI's resume list. In a cloud workspace it runs on your own computer, not in the workspace.

**How to turn it off**

- Automatic naming and summaries: Settings → Agents → Automatic brain work → **Let the brain name sessions**.
- Spending: set a daily budget, or a budget for one feature, from the brain chip or Settings → Agents → Brain spending. Set **0** to stop that feature completely.
- Suggest message only runs when you press it.
