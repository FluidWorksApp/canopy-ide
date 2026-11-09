import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockCommands } from "../test/setup";
import { T3Connect } from "./T3Connect";

const LINK = "http://192.168.1.4:3773/pair#token=CODE";

describe("T3Connect", () => {
  it("shows the machine the link reaches before redeeming it, then saves it", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const record = (name: string, value: unknown) => (args: Record<string, unknown>) => { calls.push([name, args]); return value; };
    mockCommands({
      t3_list: record("t3_list", []),
      t3_describe: record("t3_describe", { environmentId: "env-1", label: "Studio Mac", httpBaseUrl: "http://192.168.1.4:3773/", serverVersion: "0.1.7", platform: { os: "darwin" } }),
      t3_pair: record("t3_pair", { id: "env-1", environmentId: "env-1", label: "Studio Mac", httpBaseUrl: "http://192.168.1.4:3773/", scope: "filesystem:read", expiresAt: "2030-01-01T00:00:00Z" }),
    });
    const opened: string[] = [];
    render(<T3Connect onOpen={machine => opened.push(machine.id)} />);
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: LINK } });
    fireEvent.click(screen.getByRole("button", { name: "Check link" }));
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(calls.map(([name]) => name)).toEqual(["t3_list", "t3_describe"]);
    fireEvent.click(screen.getByRole("button", { name: "Connect to Studio Mac" }));
    await screen.findByRole("status");
    expect(calls.at(-1)).toEqual(["t3_pair", { link: LINK, expectedEnvironmentId: "env-1" }]);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(opened).toEqual(["env-1"]);
  });

  it("names a malformed link without contacting anything", async () => {
    mockCommands({ t3_list: [] });
    render(<T3Connect onOpen={() => {}} />);
    fireEvent.change(screen.getByLabelText("Pairing link"), { target: { value: "https://box.example.com/pair" } });
    fireEvent.click(screen.getByRole("button", { name: "Check link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Pairing URL is missing its token."));
  });
});
