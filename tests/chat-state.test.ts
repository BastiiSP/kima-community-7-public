import assert from "node:assert/strict";
import { test } from "node:test";
import { appendNewChat, appendSentChat, ChatMessage, initialChat, prependOlderChat } from "../src/lib/chat-state";

const message = (id: string, cursor: string): ChatMessage => ({ id, cursor, body: id, authorId: "member-1", authorName: "Test Person", createdAt: "2026-11-16T10:00:00.000Z" });

test("initial page keeps the last 50 messages in chronological order and both cursors", () => {
  const messages = Array.from({ length: 50 }, (_, index) => message(String(index + 51), String(index + 51)));
  const state = initialChat({ messages, olderCursor: "50", newerCursor: "100", hasMore: false, revision: "0" });
  assert.equal(state.messages.length, 50);
  assert.equal(state.messages[0].id, "51");
  assert.equal(state.messages.at(-1)?.id, "100");
  assert.equal(state.olderCursor, "50");
  assert.equal(state.newerCursor, "100");
});

test("older pages prepend without duplicates and do not rewind the new-message cursor", () => {
  const initial = initialChat({ messages: [message("3", "3"), message("4", "4")], olderCursor: "2", newerCursor: "4", hasMore: false, revision: "0" });
  const next = prependOlderChat(initial, { messages: [message("1", "1"), message("2", "2"), message("3", "3")], olderCursor: null, newerCursor: "3", hasMore: false, revision: "0" });
  assert.deepEqual(next.messages.map(item => item.id), ["1", "2", "3", "4"]);
  assert.equal(next.olderCursor, null);
  assert.equal(next.newerCursor, "4");
});

test("new GET pages advance the cursor while preserving older pages and deduplicating own sends", () => {
  const initial = initialChat({ messages: [message("1", "1")], olderCursor: null, newerCursor: "1", hasMore: false, revision: "0" });
  const next = appendNewChat(initial, { messages: [message("2", "2"), message("3", "3")], olderCursor: "2", newerCursor: "3", hasMore: true, revision: "0" });
  const afterOwnSend = appendNewChat(next, { messages: [message("3", "3"), message("4", "4")], olderCursor: null, newerCursor: "4", hasMore: false, revision: "0" });
  assert.deepEqual(afterOwnSend.messages.map(item => item.id), ["1", "2", "3", "4"]);
  assert.equal(afterOwnSend.olderCursor, null);
  assert.equal(afterOwnSend.newerCursor, "4");
});

test("a confirmed send preserves the GET cursor and merges concurrent messages in exact position order", () => {
  const initial = initialChat({ messages: [message("old", "9007199254740992")], olderCursor: null, newerCursor: "9007199254740992", hasMore: false, revision: "0" });
  const sent = appendSentChat(initial, message("mine", "9007199254740994"));
  assert.equal(sent.newerCursor, initial.newerCursor);
  const merged = appendNewChat(sent, { messages: [message("other", "9007199254740993"), message("mine", "9007199254740994")], olderCursor: null, newerCursor: "9007199254740994", hasMore: false, revision: "0" });
  assert.deepEqual(merged.messages.map(item => item.id), ["old", "other", "mine"]);
  assert.equal(appendSentChat(merged, message("mine", "9007199254740994")), merged);
});
