import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IncomingJob, MeshJobs } from "../meshJobs";
import type { Placement } from "../jobScope";
import { MeshJobInbox } from "./MeshJobInbox";
import { cloneUrlFor } from "../jobScope";

afterEach(cleanup);

const repo = { host: "github.com", slug: "FluidWorksApp/cause-api" };
const item = (placement: Placement, over: Partial<IncomingJob> = {}): IncomingJob => ({
  job: { id: "job-12345678", title: "Fix #101", brief: "cause-api #101, then dashboard #66", workspace: null, created: 1, scope: { repos: [repo, { host: "github.com", slug: "FluidWorksApp/dashboard" }] } },
  team: "t1",
  account: "me",
  sender: { user: "bob", device: "bob-1", name: "Bob" },
  sameAccount: false,
  received: 1,
  placement,
  ...over,
});
function jobsWith(items: IncomingJob[]) {
  const approve = vi.fn(async () => ({}));
  const jobs = { inbox: () => items, subscribe: () => () => {}, approve, decline: vi.fn(async () => {}), relocate: vi.fn(async () => {}) };
  return { jobs: jobs as unknown as MeshJobs, approve };
}
const approveButton = () => screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
const PROJECTS = ["CauseConnect", "cause-api", "dashboard"];

it("runs a matched job in its project with no picker to get wrong", async () => {
  const api = { project: "cause-api", dir: "/src/cause-api", rel: "", origin: "git@github.com:FluidWorksApp/cause-api.git", main: true };
  const { jobs, approve } = jobsWith([item({ kind: "matched", repo, choices: [api] })]);
  render(<MeshJobInbox jobs={jobs} workspaces={PROJECTS} />);
  expect(screen.getByText(/Runs in/).textContent).toBe("Runs in cause-api (matches FluidWorksApp/cause-api)");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("Also involves FluidWorksApp/dashboard.")).toBeTruthy();
  expect(approveButton().disabled).toBe(false);
  fireEvent.click(approveButton());
  await waitFor(() => expect(approve).toHaveBeenCalledWith("job-12345678", { dir: "/src/cause-api", label: "cause-api" }));
});

it("shows the main checkout first when several match, and lets the user change it", async () => {
  const main = { project: "cause-api", dir: "/src/cause-api", rel: "", origin: "x", main: true };
  const wt = { project: "cause-api-wt", dir: "/src/cause-api-wt", rel: "", origin: "x", main: false };
  const { jobs, approve } = jobsWith([item({ kind: "matched", repo, choices: [main, wt] })]);
  render(<MeshJobInbox jobs={jobs} workspaces={PROJECTS} />);
  const select = screen.getByRole("combobox") as HTMLSelectElement;
  expect(select.value).toBe("/src/cause-api");
  expect([...select.options].map((o) => o.textContent)).toEqual(["cause-api", "cause-api-wt (worktree)"]);
  fireEvent.change(select, { target: { value: "/src/cause-api-wt" } });
  fireEvent.click(approveButton());
  await waitFor(() => expect(approve).toHaveBeenCalledWith("job-12345678", { dir: "/src/cause-api-wt", label: "cause-api-wt" }));
});

it("asks where to run a job whose repository isn't here, with nothing preselected", async () => {
  const onClone = vi.fn();
  const { jobs, approve } = jobsWith([item({ kind: "missing", repo })]);
  render(<MeshJobInbox jobs={jobs} workspaces={PROJECTS} onClone={onClone} />);
  expect(screen.getByText("You don't have FluidWorksApp/cause-api open here. Where do you want to run it?")).toBeTruthy();
  const select = screen.getByRole("combobox") as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(approveButton().disabled).toBe(true);
  fireEvent.click(approveButton());
  expect(approve).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Clone FluidWorksApp/cause-api…" }));
  expect(onClone).toHaveBeenCalledWith("https://github.com/FluidWorksApp/cause-api.git");

  fireEvent.change(select, { target: { value: "dashboard" } });
  expect(approveButton().disabled).toBe(false);
  fireEvent.click(approveButton());
  await waitFor(() => expect(approve).toHaveBeenCalledWith("job-12345678", { project: "dashboard" }));
});

it("says plainly when no project is attached at all", () => {
  const { jobs } = jobsWith([item({ kind: "none" }, { sameAccount: true, job: { id: "job-12345678", title: "t", brief: "b", workspace: "CauseConnect", created: 1 } })]);
  render(<MeshJobInbox jobs={jobs} workspaces={PROJECTS} onClone={vi.fn()} />);
  expect(screen.getByText("No project attached to this job. Where do you want to run it?")).toBeTruthy();
  // Even a project named in the job is not preselected: names are not a match.
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
  expect(approveButton().disabled).toBe(true);
  expect(screen.queryByRole("button", { name: /Clone/ })).toBeNull();
});

it("offers a clone only for a real host", () => {
  expect(cloneUrlFor(repo)).toBe("https://github.com/FluidWorksApp/cause-api.git");
  expect(cloneUrlFor({ slug: "acme/api" })).toBeNull();
  expect(cloneUrlFor({ host: "work", slug: "acme/api" })).toBeNull();
});
