import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TabPreviewShot } from "./TabPreviewShot";
import { forgetTabThumb, setTabThumb } from "../tabThumbs";
import type { SubTab } from "./ProjectView/helpers";

const tab = { id: "p1", type: "preview", url: "http://localhost:3001/us" } as unknown as SubTab;
const props = { tab, icon: <i data-testid="icon" />, paneRef: { current: null }, termText: () => null, tick: 0 };

afterEach(() => forgetTabThumb("p1"));

describe("a preview tab's thumbnail", () => {
  it("is a tile with the address until the page has been photographed", () => {
    const { container, getByText } = render(<TabPreviewShot {...props} />);
    expect(container.querySelector(".tsw-blank")).not.toBeNull();
    expect(getByText("localhost:3001/us")).toBeInTheDocument();
    expect(container.querySelector(".tsw-scale")).toBeNull();
  });
  it("is the last picture of the page once there is one", () => {
    setTabThumb("p1", "AAAA");
    const { container } = render(<TabPreviewShot {...props} />);
    expect(container.querySelector("img.tsw-page-shot")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });
});
