# Canvas 0.6.2

Canvas 0.6.2 preserves embedded `data:` and `blob:` asset URLs instead of
appending the cache-busting revision query used for network resources. This
keeps consumer-generated SVG and object URLs decodable by the Pixi asset
loader.

The release does not change public declarations, protocol version 8, durable
data, simulation, authority, or server behavior.
