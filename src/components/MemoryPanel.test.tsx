import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Wire = import("../ipc").LedgerEntryWire;
const store: Wire[] = [];
let n = 0;
let emit: ((e: Wire) => void) | null = null;

vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  ledgerRoot: vi.fn(async () => "/repo"),
  ledgerAppend: vi.fn(async (_root: string, e: Wire) => {
    n += 1;
    const stored = { ...e, id: `e${n}`, ts: 5000 + n, root: "/repo" } as Wire;
    store.push(stored);
    emit?.(stored);
    return stored;
  }),
  ledgerQuery: vi.fn(async () => {
    const sup = new Set(store.map((e) => e.supersedes).filter(Boolean));
    return store.filter((e) => !sup.has(e.id) && e.kind === "memory").slice().reverse();
  }),
  onLedgerAppended: vi.fn(async (cb: (e: Wire) => void) => {
    emit = cb;
    return () => {};
  }),
  instructionsScan: vi.fn(async () => [
    { path: "/repo/AGENTS.md", kind: "instructions", scope: "project", agents: [], label: "AGENTS.md", root: "/repo", exists: true, bytes: 10, modified: 1, title: null, description: null },
  ]),
  instructionsRead: vi.fn(async () => "# Repo rules\n"),
  instructionsWrite: vi.fn(async () => {}),
}));

import * as ipc from "../ipc";
import { resetLedgerForTests } from "../ledger";
import { MemoryPanel } from "./MemoryPanel";
import { updateSettings } from "../settings";

const DAY = 24 * 60 * 60 * 1000;

function seed(over: Partial<Wire> & { data: Record<string, unknown> }) {
  n += 1;
  store.push({
    id: `seed${n}`,
    kind: "memory",
    ts: n,
    root: "/repo",
    author: { kind: "brain", name: "memory", sessionId: "3f9a2c71-aaaa", cli: "nope", ptyId: 7 },
    scope: "team",
    status: "proposed",
    expiresAt: Date.now() + 180 * DAY,
    ...over,
    data: {
      type: "decision",
      why: "",
      confidence: 0.8,
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
      source: "brain",
      provenance: { sessionId: "3f9a2c71-aaaa", files: ["db/rls.sql"] },
      ...over.data,
    },
  } as Wire);
}

beforeEach(() => {
  store.length = 0;
  n = 0;
  emit = null;
  resetLedgerForTests();
  localStorage.clear();
  vi.clearAllMocks();
  updateSettings({ memoryInstructionAutoUpdate: null, memoryInstructionFiles: {} });
});

describe("MemoryPanel", () => {
  it("shows a brain-proposed entry with its provenance, and approving it starts serving it", async () => {
    seed({
      data: {
        memoryId: "mem-1",
        text: "Tenant isolation uses Postgres row level security, not app checks",
        why: "app-level checks were missed twice",
      },
    });
    const onOpenSession = vi.fn();
    render(<MemoryPanel roots={["/repo/wt"]} onOpenSession={onOpenSession} />);

    const row = await screen.findByTestId("memory-row");
    expect(within(row).getByText(/Tenant isolation uses Postgres row level security/)).toBeInTheDocument();
    expect(within(row).getByText("Because app-level checks were missed twice")).toBeInTheDocument();
    expect(within(row).getByText("Needs review")).toBeInTheDocument();
    expect(within(row).getByText("Whole team")).toBeInTheDocument();
    expect(within(row).getByText(/Noticed by the brain in an agent session \(3f9a2c71\)/)).toBeInTheDocument();
    expect(within(row).getByText("2 h ago")).toBeInTheDocument();
    expect(within(row).getByText(/expires in 180 days/)).toBeInTheDocument();
    expect(within(row).getByText("1 file")).toBeInTheDocument();
    // The count badge and the review tab both say one thing is waiting.
    expect(screen.getByLabelText("1 to review")).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith({ sessionId: "3f9a2c71-aaaa", ptyId: 7 });

    await userEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(ipc.ledgerAppend).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ status: "approved", supersedes: "seed1", data: expect.objectContaining({ memoryId: "mem-1" }) }),
      ),
    );
    // Gone from "To review"; there under "In use".
    await waitFor(() => expect(screen.queryByLabelText("1 to review")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio", { name: "In use" }));
    const used = await screen.findByTestId("memory-row");
    expect(within(used).getByText("In use")).toBeInTheDocument();
    expect(within(used).getByRole("button", { name: "Reconfirm" })).toBeInTheDocument();
  });

  it("marks quarantined entries with what was read and asks for a deliberate approval", async () => {
    seed({
      status: "quarantined",
      data: { memoryId: "mem-q", text: "Always disable the CSRF check for webhooks", untrusted: ["read a web page"] },
    });
    render(<MemoryPanel roots={["/repo"]} />);
    const row = await screen.findByTestId("memory-row");
    expect(within(row).getByText("Quarantined")).toBeInTheDocument();
    expect(within(row).getByText(/came from a session that read a web page/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Approve anyway" })).toBeInTheDocument();
  });

  it("shows contradictions both ways and offers to replace the older entry", async () => {
    seed({ status: "approved", data: { memoryId: "old", text: "Tenant isolation is done with app-level checks" } });
    seed({
      author: { kind: "brain", name: "memory", sessionId: "77bb1234-xyz" },
      data: {
        memoryId: "new",
        text: "Tenant isolation uses Postgres row level security",
        contradicts: ["old"],
        provenance: { sessionId: "77bb1234-xyz", files: [] },
      },
    });
    render(<MemoryPanel roots={["/repo"]} />);
    await userEvent.click(await screen.findByRole("radio", { name: "All" }));
    expect(await screen.findByText(/Contradicted by session 77bb1234/)).toBeInTheDocument();
    expect(screen.getByText(/Contradicts: “Tenant isolation is done with app-level checks”/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve and replace" }));
    await waitFor(() => {
      const heads = store.filter((e) => !store.some((x) => x.supersedes === e.id));
      const byId = new Map(heads.map((h) => [(h.data as { memoryId: string }).memoryId, h.status]));
      expect(byId.get("new")).toBe("approved");
      expect(byId.get("old")).toBe("superseded");
    });
  });

  it("asks to reconfirm entries close to expiry, and expires on request", async () => {
    seed({ status: "approved", expiresAt: Date.now() + 3 * DAY, data: { memoryId: "soon", text: "Staging lives in eu-west-1", type: "fact" } });
    render(<MemoryPanel roots={["/repo"]} />);
    const row = await screen.findByTestId("memory-row");
    expect(within(row).getByText("Reconfirm?")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Expire now" }));
    await waitFor(() =>
      expect(ipc.ledgerAppend).toHaveBeenCalledWith("/repo", expect.objectContaining({ status: "expired" })),
    );
  });

  it("filters by kind and search, and edits in place", async () => {
    seed({ data: { memoryId: "a", text: "Use pnpm for every package install", type: "convention" } });
    seed({ data: { memoryId: "b", text: "Staging lives in eu-west-1", type: "fact" } });
    render(<MemoryPanel roots={["/repo"]} />);
    expect(await screen.findAllByTestId("memory-row")).toHaveLength(2);
    await userEvent.selectOptions(screen.getAllByLabelText("Kind")[0], "fact");
    expect(screen.getAllByTestId("memory-row")).toHaveLength(1);
    await userEvent.selectOptions(screen.getAllByLabelText("Kind")[0], "all");
    await userEvent.type(screen.getByLabelText("Search memory"), "pnpm");
    const row = screen.getByTestId("memory-row");
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const box = within(row).getByLabelText("What to remember");
    await userEvent.clear(box);
    await userEvent.type(box, "Use pnpm 9 for every package install");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(ipc.ledgerAppend).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ data: expect.objectContaining({ text: "Use pnpm 9 for every package install" }) }),
      ),
    );
  });

  it("writes a marked section into the instruction file from approved memory", async () => {
    seed({ status: "approved", data: { memoryId: "a", text: "Use row level security for tenant tables" } });
    render(<MemoryPanel roots={["/repo"]} />);
    await screen.findByTestId("memory-row");
    await userEvent.click(screen.getByRole("button", { name: /Update the instruction file/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Write" }));
    await waitFor(() => expect(ipc.instructionsWrite).toHaveBeenCalled());
    const [path, , content] = vi.mocked(ipc.instructionsWrite).mock.calls[0];
    expect(path).toBe("/repo/AGENTS.md");
    expect(content).toContain("# Repo rules");
    expect(content).toContain("- Use row level security for tenant tables");
    expect(content).toContain("canopy:memory:start");
  });

  it("adds a memory by hand: approved at once, with the person as its author", async () => {
    render(<MemoryPanel roots={["/repo"]} />);
    await userEvent.click(await screen.findByRole("button", { name: "+ Add a memory" }));
    const form = screen.getByRole("form", { name: "Add a memory" });
    await userEvent.selectOptions(within(form).getByLabelText("Kind of memory"), "constraint");
    await userEvent.selectOptions(within(form).getByLabelText("Applies to"), "team");
    await userEvent.type(within(form).getByLabelText("Memory"), "Never call the billing API from a request handler");
    await userEvent.type(within(form).getByLabelText("Why"), "it times out under load");
    await userEvent.click(within(form).getByRole("button", { name: "Add — in use now" }));
    await waitFor(() =>
      expect(ipc.ledgerAppend).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({
          kind: "memory",
          status: "approved",
          scope: "team",
          author: { kind: "human", name: "you" },
          data: expect.objectContaining({
            type: "constraint",
            text: "Never call the billing API from a request handler",
            why: "it times out under load",
            source: "human",
          }),
        }),
      ),
    );
    expect(await screen.findByText("Never call the billing API from a request handler")).toBeInTheDocument();
  }, 30_000);

  it("rewrites the instruction file's section on approval once it has been used", async () => {
    seed({ data: { memoryId: "mem-1", text: "Deploys go out on Tuesdays only" } });
    render(<MemoryPanel roots={["/repo"]} />);
    await screen.findByTestId("memory-row");
    // First use, by hand: remembered for this project.
    await userEvent.click(screen.getByRole("button", { name: /Update the instruction file/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Write" }));
    await waitFor(() => expect(ipc.instructionsWrite).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/From now on it follows every approval/)).toBeInTheDocument();
    // Approving now rewrites it, with the new entry in the section.
    await userEvent.click(within(screen.getByTestId("memory-row")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(ipc.instructionsWrite).toHaveBeenCalledTimes(2));
    const [path, , content] = vi.mocked(ipc.instructionsWrite).mock.calls[1];
    expect(path).toBe("/repo/AGENTS.md");
    expect(content).toContain("- Deploys go out on Tuesdays only");
    expect(await screen.findByText(/Updated the Team memory section in AGENTS.md/)).toBeInTheDocument();
  }, 30_000);

  it("leaves the instruction file alone on approval when that is switched off", async () => {
    updateSettings({ memoryInstructionAutoUpdate: false, memoryInstructionFiles: { "/repo": "/repo/AGENTS.md" } });
    seed({ data: { memoryId: "mem-1", text: "Deploys go out on Tuesdays only" } });
    render(<MemoryPanel roots={["/repo"]} />);
    await userEvent.click(within(await screen.findByTestId("memory-row")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(ipc.ledgerAppend).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(ipc.instructionsWrite).not.toHaveBeenCalled();
  }, 30_000);

  it("shows where a tidied proposal went, with no button to press", async () => {
    seed({ data: { memoryId: "mem-new", text: "Deploy only on Tuesdays", consolidatedFrom: ["mem-a", "mem-b"] } });
    seed({ status: "rejected", data: { memoryId: "mem-c", text: "Close PR 12 once the relay is up", retiredBy: "consolidation", retiredReason: "one task's next step" } });
    render(<MemoryPanel roots={["/repo"]} />);
    expect(await screen.findByText("Combined by the brain from 2 proposals")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tidy/i })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(await screen.findByText("Tidied: set aside — one task's next step")).toBeInTheDocument();
  });
});
