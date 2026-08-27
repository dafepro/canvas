# Repository rules

- Test-drive code changes, preferably with end-to-end tests using Docker and Testcontainers (or the JavaScript equivalent).
- Before committing, run only tests whose outcomes are likely to change from the modified code or configuration.
- Commit regularly as verified vertical slices are completed.
- Canvas is used by external application clients. Preserve backward compatibility for existing clients whenever practical, including public APIs, protocols, configuration, persisted data, and other externally consumed contracts. Prefer additive changes, deprecation periods, and migrations over silently removing or changing supported behavior.
- When a backward-incompatible change is unavoidable, make the break explicit and accumulate it in the repository's major-version backward-incompatibility notes, including the affected contract, client impact, and required migration. Keep those notes current until the next major release; do not use the project's prerelease status as a reason to omit compatibility work or documentation.
- Bind runnable demos to the LAN interface and report both the localhost URL and the usable LAN URL whenever a demo is launched or handed off.
