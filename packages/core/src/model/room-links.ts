export interface RoomLinkDefinition {
  /** Globally unique route id stored in a room-portal item's configuration. */
  id: string;
  fromRoomId: string;
  toRoomId: string;
  /** Exact route that returns from toRoomId to fromRoomId. */
  returnLinkId: string;
  /** Consumer-owned arrival hint, normally a destination Canvas spawn-point id. */
  arrivalSpawnPointId?: string;
}

const required = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`room link ${field} is required`);
  return normalized;
};

/**
 * Immutable, validated navigation graph. Every route must have an exact reverse
 * so an application never admits a one-way room transition by accident.
 */
export class RoomLinkGraph {
  private readonly byId = new Map<string, Readonly<RoomLinkDefinition>>();

  constructor(links: readonly RoomLinkDefinition[]) {
    for (const source of links) {
      const link = Object.freeze({
        ...source,
        id: required(source.id, "id"),
        fromRoomId: required(source.fromRoomId, "fromRoomId"),
        toRoomId: required(source.toRoomId, "toRoomId"),
        returnLinkId: required(source.returnLinkId, "returnLinkId"),
        arrivalSpawnPointId: source.arrivalSpawnPointId === undefined
          ? undefined
          : required(source.arrivalSpawnPointId, "arrivalSpawnPointId"),
      });
      if (link.fromRoomId === link.toRoomId) {
        throw new Error(`room link '${link.id}' must leave its current room`);
      }
      if (this.byId.has(link.id)) throw new Error(`duplicate room link '${link.id}'`);
      this.byId.set(link.id, link);
    }

    for (const link of this.byId.values()) {
      const reverse = this.byId.get(link.returnLinkId);
      if (!reverse) {
        throw new Error(`room link '${link.id}' has no return link '${link.returnLinkId}'`);
      }
      if (
        reverse.fromRoomId !== link.toRoomId ||
        reverse.toRoomId !== link.fromRoomId ||
        reverse.returnLinkId !== link.id
      ) {
        throw new Error(`room link '${link.id}' does not have an exact reverse route`);
      }
    }
  }

  resolve(roomId: string, linkId: string): Readonly<RoomLinkDefinition> {
    const link = this.byId.get(linkId);
    if (!link) throw new Error(`unknown room link '${linkId}'`);
    if (link.fromRoomId !== roomId) {
      throw new Error(`room link '${linkId}' does not leave room '${roomId}'`);
    }
    return link;
  }

  linksFrom(roomId: string): readonly Readonly<RoomLinkDefinition>[] {
    return Object.freeze(
      [...this.byId.values()].filter((link) => link.fromRoomId === roomId),
    );
  }
}
