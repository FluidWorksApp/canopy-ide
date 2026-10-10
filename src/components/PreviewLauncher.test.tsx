import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { PreviewLauncher } from "./PreviewLauncher";
const server = {
  url: "http://localhost:3100",
  port: 3100,
  ptyId: 7,
  title: "Website",
  cwd: "/repo",
  componentLabel: "website",
  componentPath: "/repo",
  run: true,
};
it("opens a manually entered preview when no listening port has been detected", async () => {
  const onNavigate = vi.fn(),
    user = userEvent.setup();
  render(<PreviewLauncher servers={[]} onNavigate={onNavigate} />);
  expect(screen.getByRole("status").textContent).toContain(
    "No web server port detected",
  );
  expect(screen.getByRole("button", { name: "Open preview" })).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Server URL" }),
    "localhost:3100/office-hours{Enter}",
  );
  expect(onNavigate).toHaveBeenCalledWith("localhost:3100/office-hours");
  expect(screen.queryByText("I'm getting your project ready.")).toBeNull();
});
it("offers a discovered server when it appears, without losing the URL being typed", async () => {
  const onNavigate = vi.fn(),
    user = userEvent.setup();
  const view = render(<PreviewLauncher servers={[]} onNavigate={onNavigate} />);
  await user.type(
    screen.getByRole("textbox", { name: "Server URL" }),
    "localhost:4200",
  );
  view.rerender(<PreviewLauncher servers={[server]} onNavigate={onNavigate} />);
  expect(screen.getByRole("textbox", { name: "Server URL" })).toHaveValue(
    "localhost:4200",
  );
  await user.click(screen.getByRole("button", { name: /Website/ }));
  expect(onNavigate).toHaveBeenCalledWith(server.url);
  expect(screen.queryByRole("status")).toBeNull();
});
