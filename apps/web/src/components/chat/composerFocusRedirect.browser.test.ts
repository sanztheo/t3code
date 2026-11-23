import { afterEach, expect, it } from "vite-plus/test";

import { pasteTextToFocusComposer, shouldTypeToFocusComposer } from "./composerFocusRedirect";

/** A chat root whose column is shown, or maximized away behind its right panel. */
function chatRoot(maximizedAway: boolean) {
  const root = document.createElement("div");
  const column = document.createElement("div");
  column.setAttribute("data-chat-column-maximized-away", maximizedAway ? "true" : "false");
  root.append(column);
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

it("redirects typing and pastes to a chat whose column shows while another chat maximizes its panel", () => {
  const shown = chatRoot(false);
  const maximized = chatRoot(true);
  const key = new KeyboardEvent("keydown", { key: "a" });
  expect(shouldTypeToFocusComposer(key, shown)).toBe(true);
  expect(shouldTypeToFocusComposer(key, maximized)).toBe(false);

  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "pasted");
  const paste = new ClipboardEvent("paste", { clipboardData });
  expect(pasteTextToFocusComposer(paste, shown)).toBe("pasted");
  expect(pasteTextToFocusComposer(paste, maximized)).toBeNull();
});
