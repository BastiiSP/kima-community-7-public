import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeComments, mergeFeedPage, type Comment, type Community, type Post } from "../src/lib/feed-state";

const comment = (id: number, body = `Text ${id}`): Comment => ({ id: String(id), body, authorId: "member", authorName: "Test Person", agentName: null, createdAt: `2026-11-16T12:00:${String(id).padStart(2, "0")}Z` });
const post = (id: number, comments: Comment[] = []): Post => ({ id: String(id), body: `Beitrag ${id}`, deleted: false, authorId: "member", authorName: "Test Person", agentName: null, createdAt: `2026-11-16T12:00:${String(id).padStart(2, "0")}Z`, comments, commentCount: comments.length, commentsNextCursor: null });
const feed = (posts: Post[], nextCursor: string | null = "next"): Community => ({ member: { id: "member", firstName: "Test", lastName: "Person" }, posts, nextCursor });

test("refresh updates posts while preserving historical cards, expanded comments and pagination", () => {
  const previous = post(2, Array.from({ length: 8 }, (_, index) => comment(index + 1)));
  const current = feed([previous, post(1)], "oldest-cursor");
  const incoming = { ...post(2, [comment(1, "Geändert"), comment(3), comment(4), comment(5), comment(6)]), commentsNextCursor: "first-five", commentCount: 7 };
  const updated = mergeFeedPage(current, feed([post(3), incoming]));
  assert.deepEqual(updated.posts.map(item => item.id), ["3", "2", "1"]);
  assert.equal(updated.nextCursor, "oldest-cursor");
  const comments = updated.posts[1].comments;
  assert.equal(comments[0].body, "Geändert");
  assert.equal(comments.find(item => item.id === "2")?.deleted, true);
  assert.equal(comments.find(item => item.id === "2")?.body, "");
  assert.equal(comments.at(-1)?.id, "8");
});

test("complete comment windows clear deleted text but keep IDs for local editor drafts", () => {
  const result = mergeComments([comment(1), comment(2), comment(3)], [comment(2, "Neu")], true);
  assert.deepEqual(result.map(item => item.id), ["1", "2", "3"]);
  assert.equal(result[0].body, "");
  assert.equal(result[0].authorName, "Gelöschter Kommentar");
  assert.equal(result[1].body, "Neu");
  assert.equal(result[2].deleted, true);
});

test("different membership replaces all previous private history", () => {
  const incoming = { ...feed([post(3)]), member: { id: "other", firstName: "Other", lastName: "Person" } };
  assert.deepEqual(mergeFeedPage(feed([post(1)]), incoming), incoming);
});

test("a burst beyond the first page retains a usable cursor through the unseen gap", () => {
  const current = feed([post(2), post(1)], null);
  const incoming = feed([post(15), post(14)], "gap-cursor");
  const result = mergeFeedPage(current, incoming);
  assert.equal(result.nextCursor, "gap-cursor");
  assert.deepEqual(result.posts.map(item => item.id), ["15", "14", "2", "1"]);
  const more = mergeFeedPage(result, feed([post(13), post(12)], "older-cursor"), true);
  assert.equal(more.nextCursor, "older-cursor");
  assert.equal(more.posts.length, 6);
});

test("precise server timestamps distinguish comments within the same millisecond", () => {
  const earlier = { ...comment(9), createdAt: "2026-11-16T12:00:00.123Z", orderAt: "2026-11-16T12:00:00.123100Z" };
  const later = { ...comment(1), createdAt: earlier.createdAt, orderAt: "2026-11-16T12:00:00.123900Z" };
  const result = mergeComments([earlier, later], [earlier], false);
  assert.equal(result.find(item => item.id === later.id)?.deleted, undefined);
  const deleted = mergeComments([earlier, later], [later], false);
  assert.equal(deleted.find(item => item.id === earlier.id)?.deleted, true);
});

test("refreshing an expanded comment window updates and deletes beyond the first twenty", () => {
  const current = Array.from({ length: 42 }, (_, index) => comment(index + 1));
  const incoming = current.slice(25).filter(item => item.id !== "41").map(item => item.id === "42" ? { ...item, body: "Geändert" } : item);
  const result = mergeComments(current, incoming, true, current[24]);
  assert.equal(result.length, 42);
  assert.equal(result.find(item => item.id === "41")?.deleted, true);
  assert.equal(result.find(item => item.id === "42")?.body, "Geändert");
  assert.equal(result.find(item => item.id === "20")?.body, "Text 20");
});
