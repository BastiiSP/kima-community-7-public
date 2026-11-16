export type Member = { id: string; firstName: string; lastName: string };
export type Comment = { id: string; body: string; authorId: string; authorName: string; agentName: string | null; createdAt: string; orderAt?: string; deleted?: boolean };
export type Post = { id: string; body: string; deleted: boolean; authorId: string | null; authorName: string; agentName: string | null; createdAt: string; orderAt?: string; comments: Comment[]; commentsTruncated?: boolean; commentCount: number; commentsNextCursor: string | null };
export type Community = { member: Member; posts: Post[]; nextCursor: string | null };

export type CommentBoundary = Pick<Comment, "id" | "createdAt" | "orderAt">;

function compareComments(a: CommentBoundary, b: CommentBoundary) { return (a.orderAt && b.orderAt ? a.orderAt.localeCompare(b.orderAt) : a.createdAt.localeCompare(b.createdAt)) || a.id.localeCompare(b.id); }
function afterBoundary(comment: Comment, boundary: CommentBoundary) {
  return comment.orderAt && boundary.orderAt ? compareComments(comment, boundary) > 0 : Date.parse(comment.createdAt) > Date.parse(boundary.createdAt);
}
function beforeBoundary(comment: Comment, boundary: CommentBoundary) {
  // Old deployments expose only millisecond timestamps. Do not infer deletion
  // for an ambiguous boundary until an exact/complete window arrives.
  return comment.orderAt && boundary.orderAt ? compareComments(comment, boundary) <= 0 : Date.parse(comment.createdAt) < Date.parse(boundary.createdAt);
}

// Replace only the authoritative returned range. Keep loaded history, and keep
// empty deletion shells so a mounted editor can retain its unsaved local text.
export function mergeComments(current: Comment[], incoming: Comment[], complete: boolean, after?: CommentBoundary): Comment[] {
  const last = incoming.at(-1);
  const fresh = new Map(incoming.map(comment => [comment.id, comment]));
  const merged = current.map(comment => {
    const replacement = fresh.get(comment.id);
    if (replacement) { fresh.delete(comment.id); return replacement; }
    const inRange = (!after || afterBoundary(comment, after)) && (complete || last && beforeBoundary(comment, last));
    return inRange ? { ...comment, body: "", authorId: "", authorName: "Gelöschter Kommentar", agentName: null, deleted: true } : comment;
  });
  return [...merged, ...fresh.values()].sort(compareComments);
}

export function mergeFeedPage(current: Community | null, incoming: Community, append = false): Community {
  if (!current || current.member.id !== incoming.member.id) return incoming;
  const existing = new Map(current.posts.map(post => [post.id, post]));
  const replacements = incoming.posts.map(post => {
    const previous = existing.get(post.id);
    existing.delete(post.id);
    if (!previous) return post;
    const comments = mergeComments(previous.comments, post.comments, !post.commentsNextCursor);
    const hasLoadedMore = previous.comments.filter(comment => !comment.deleted).length > post.comments.length;
    return { ...post, comments, commentsNextCursor: hasLoadedMore ? previous.commentsNextCursor ?? (post.commentCount > previous.comments.filter(comment => !comment.deleted).length ? post.commentsNextCursor : null) : post.commentsNextCursor,
      commentsTruncated: hasLoadedMore ? previous.commentsTruncated : post.commentsTruncated };
  });
  const posts = [...replacements, ...existing.values()].sort((a, b) => (a.orderAt && b.orderAt ? b.orderAt.localeCompare(a.orderAt) : b.createdAt.localeCompare(a.createdAt)) || b.id.localeCompare(a.id));
  return { ...incoming, posts, nextCursor: append || incoming.posts.length > 0 && !current.posts.some(post => post.id === incoming.posts.at(-1)!.id) ? incoming.nextCursor : current.nextCursor };
}
