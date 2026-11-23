import { expect, it } from "vite-plus/test";

import { pasteTextToFocusComposer, shouldTypeToFocusComposer } from "./composerFocusRedirect";

/** Two chat roots: one whose column shows, one whose column its right panel maximized away. */
function twoChats() {
  const chatRoot = (maximizedAway: boolean) => {
    const root = document.createElement("div");
    const column = document.createElement("div");
    column.setAttribute("data-chat-column-maximized-away", maximizedAway ? "true" : "false");
    root.append(column);
    document.body.append(root);
    return root;
  };
  const shown = chatRoot(false);
  const maximized = chatRoot(true);
  return {
    shown,
    maximized,
    [Symbol.dispose]: () => {
      shown.remove();
      maximized.remove();
    },
  };
}

it("redirects typing and pastes to a chat whose column shows while another chat maximizes its panel", () => {
  using chats = twoChats();
  const key = new KeyboardEvent("keydown", { key: "a" });
  expect(shouldTypeToFocusComposer(key, chats.shown)).toBe(true);
  expect(shouldTypeToFocusComposer(key, chats.maximized)).toBe(false);

  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "pasted");
  const paste = new ClipboardEvent("paste", { clipboardData });
  expect(pasteTextToFocusComposer(paste, chats.shown)).toBe("pasted");
  expect(pasteTextToFocusComposer(paste, chats.maximized)).toBeNull();
});
