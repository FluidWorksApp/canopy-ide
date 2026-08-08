import { beforeEach, describe, expect, it } from "vitest";
import {
  EDITOR_VIEW_STATE_LIMIT,
  editorViewState,
  editorViewStateMetrics,
  rememberEditorViewState,
  resetEditorViewStates,
} from "./editorViewState";

describe("bounded inactive editor view states", () => {
  beforeEach(resetEditorViewStates);

  it("evicts the least-recently-used state at the fixed limit", () => {
    for (let index = 0; index < EDITOR_VIEW_STATE_LIMIT; index += 1) {
      rememberEditorViewState(`file-${index}`, { index });
    }
    expect(editorViewState("file-0")).toEqual({ index: 0 });
    rememberEditorViewState("new-file", { index: 99 });
    expect(editorViewState("file-1")).toBeNull();
    expect(editorViewState("file-0")).toEqual({ index: 0 });
    expect(editorViewStateMetrics()).toEqual({
      retained: EDITOR_VIEW_STATE_LIMIT,
      limit: EDITOR_VIEW_STATE_LIMIT,
    });
  });

  it("replaces one key without growing retention", () => {
    rememberEditorViewState("file", { scroll: 1 });
    rememberEditorViewState("file", { scroll: 2 });
    expect(editorViewState("file")).toEqual({ scroll: 2 });
    expect(editorViewStateMetrics().retained).toBe(1);
  });
});
