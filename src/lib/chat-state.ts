export type ChatMessage = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  cursor: string;
};

export type ChatPage = {
  messages: ChatMessage[];
  olderCursor: string | null;
  newerCursor: string;
  hasMore: boolean;
  revision: string;
};

export type ChatState = {
  messages: ChatMessage[];
  olderCursor: string | null;
  newerCursor: string;
  revision: string;
};

export function initialChat(page: ChatPage): ChatState {
  return { messages: page.messages, olderCursor: page.olderCursor, newerCursor: page.newerCursor, revision: page.revision };
}

export function appendNewChat(current: ChatState, page: ChatPage): ChatState {
  const known = new Set(current.messages.map(message => message.id));
  return {
    ...current,
    messages: [...current.messages, ...page.messages.filter(message => !known.has(message.id))].sort(compareMessages),
    // POST responses must never advance this cursor; only a GET after this cursor can.
    newerCursor: page.newerCursor,
  };
}

function compareMessages(left: ChatMessage, right: ChatMessage) {
  return BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0;
}

export function appendSentChat(current: ChatState, message: ChatMessage): ChatState {
  if (current.messages.some(item => item.id === message.id)) return current;
  return { ...current, messages: [...current.messages, message].sort(compareMessages) };
}

export function prependOlderChat(current: ChatState, page: ChatPage): ChatState {
  const known = new Set(current.messages.map(message => message.id));
  return {
    ...current,
    messages: [...page.messages.filter(message => !known.has(message.id)), ...current.messages],
    olderCursor: page.olderCursor,
  };
}
