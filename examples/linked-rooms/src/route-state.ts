export const linkedRoomIds = ["linked-village", "linked-cave", "linked-pixel-room"] as const;
export type LinkedRoomId = (typeof linkedRoomIds)[number];

export const linkedRoomFromSearch = (search: string): LinkedRoomId => {
  const candidate = new URLSearchParams(search).get("room");
  return linkedRoomIds.find((roomId) => roomId === candidate) ?? "linked-village";
};

export const urlForLinkedRoom = (href: string, roomId: LinkedRoomId): string => {
  const url = new URL(href);
  url.searchParams.set("room", roomId);
  return url.toString();
};
